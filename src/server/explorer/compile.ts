// src/server/explorer/compile.ts
//
// The EXPLORER query engine. Compiles an `ExplorerGraph` — the normalized
// output of the node editor — into ONE parameterized SQL query over
// `participants` (self-joined for allies/enemies) + `matches`.
//
// The subject's filters live in a MATERIALIZED CTE so Postgres fetches the
// champion's rows FIRST (via the champion_name index) and only THEN joins
// `matches`. Without it the `game_version LIKE` patch filter tricks the planner
// into a matches-first hash join that is ~7× slower on the 7M-row table.
//
// Item/Rune modules attach to a champion node, so each champion (subject and
// every ally/enemy) carries its own item + keystone constraints. Everything is
// parameterized; roles/tiers/dimensions are validated against allowlists.

import { categoryMembers, isChampCategory, type ChampCategory } from "./champClass";

// Bayesian prior strength for the weighted item ranking: an item's winrate is
// shrunk toward the cohort baseline with this many "phantom" games, so a small
// sample regresses to the champ's average (see the item-rank branch in compile).
const ITEM_PRIOR_C = 150;

export type Role = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";

const ROLES = new Set<string>(["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]);
const TIERS = new Set<string>([
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
]);

export type ChampSpec = {
  champion?: string;
  role?: Role;
  items?: number[];
  keystones?: number[];
  itemSlots?: Record<string, number>; // itemId → required build slot (1-6 = Nth completed item); absent = any slot
  excludeItems?: number[];    // items this champ must NOT have built (EXCLUDE submodule)
  excludeKeystones?: number[]; // keystones this champ must NOT have run
};

export type Constraint =
  | ({ type: "ally"; negate?: boolean } & ChampSpec)   // negate = NOT EXISTS such an ally
  | ({ type: "enemy"; negate?: boolean } & ChampSpec);

export type Filters = {
  scope?: "current_patch" | "all";
  tiers?: string[];
  queues?: number[];
  platforms?: string[]; // region filter: lowercase platform codes (e.g. "euw1"); empty/absent = all regions
};

export type Output =
  | { kind: "stats" }
  | {
      kind: "rank";
      dimension: "ally" | "enemy" | "item";
      role?: Role;
      limit?: number;
      minGames?: number;
      itemPool?: number[]; // dimension "item": restrict the ranking to these ids (real build items)
    };

// A team-composition constraint: "the <side> team has at least <min> champions
// of class <cls>" (e.g. enemy ≥3 Assassins). Expanded in buildCohort to a COUNT
// over the relevant team's participants via the champion→class map (champClass).
export type CompConstraint = {
  side: "ally" | "enemy";
  cls: ChampCategory; // a roster class, a damage profile (AD/AP), or attack type (Melee/Ranged)
  min: number;
};

export type ExplorerGraph = {
  subject: ChampSpec;
  constraints?: Constraint[];
  categories?: CompConstraint[];
  filters?: Filters;
  itemPool?: number[]; // completed-item id set; used to order "Nth completed item" for build-slot filters
  output: Output;
};

export type CompiledQuery = {
  text: string;
  params: unknown[];
  mode: "current_patch" | "all";
};

// How the subject cohort is scoped on the time axis:
//  - current: a single patch (the live one)   → `patch = $`
//  - all:     no patch filter (whole season)  → (nothing)
// PATCH VARIATION doesn't need a third "list" scope — it just runs the fast
// single-patch query once per recent patch (see explorerPatchHandler).
export type PatchScope =
  | { kind: "current"; patch: string }
  | { kind: "all" };

// Shared cohort builder: the MATERIALIZED subject CTE (index-friendly filters +
// the patch/queue semi-join) and the ally/enemy EXISTS outer clause. The caller
// appends the final SELECT. `P` is the shared param-pusher so every fragment's
// params land in ONE ordered array. Keeping this in one place means `compile`
// (stats/rank) and `compilePatchVariation` share identical, equally-tuned SQL.
export function buildCohort(g: ExplorerGraph, P: (v: unknown) => string, scope: PatchScope) {
  // "<alias> built item X in ANY slot" — alias "" = unqualified (CTE body).
  // Checks final inventory (item0..item6), so it's index-friendly and needs no
  // timeline data.
  const itemOr = (alias: string, itemId: number) => {
    const a = alias ? `${alias}.` : "";
    const ph = P(Number(itemId) | 0);
    return `(${a}item0=${ph} OR ${a}item1=${ph} OR ${a}item2=${ph} OR ${a}item3=${ph} OR ${a}item4=${ph} OR ${a}item5=${ph} OR ${a}item6=${ph})`;
  };

  // Build-slot constraint: "<alias> bought item X as its Nth COMPLETED item".
  // Windowed over the player's ITEM_PURCHASED timeline events, restricted to the
  // completed-item pool so component purchases (Long Sword, etc.) don't count as
  // slots. Only matches WITH timeline data (participant_item_events) qualify — so
  // a slot filter narrows the sample to timeline-covered games. Falls back to
  // ordering all purchases if no pool was shipped.
  const itemPool = (g.itemPool ?? []).map((n) => Number(n) | 0).filter((n) => n > 0);
  const slotOf = (spec: ChampSpec | Constraint | undefined, itemId: number): number => {
    const n = Number(spec?.itemSlots?.[String(itemId)]) | 0;
    return n >= 1 && n <= 6 ? n : 0;
  };
  // A build-slot constraint = "the Nth completed-item purchase (by time) is this
  // item". A scalar subquery scans the player's purchases in ts order via the pkey
  // prefix index and SHORT-CIRCUITS at OFFSET+LIMIT — ~0.5s even for an all-patch
  // popular champ. (Measured alternatives: `count(*)=N-1` was ~40× slower — it
  // can't stop early; a global precomputed CTE was worse still, since popular items
  // like Liandry have 200k+ purchases across all champs.) Subject = the un-aliased
  // CTE table `participants`; ally/enemy = the EXISTS alias x.
  const slotItem = (alias: string, itemId: number, slot: number) => {
    const corr = alias ? `${alias}.` : "participants.";
    const poolCond = itemPool.length ? `AND e.item_id = ANY(${P(itemPool)})` : "AND e.item_id <> 0";
    return `(SELECT e.item_id FROM participant_item_events e
      WHERE e.match_id = ${corr}match_id AND e.participant_id = ${corr}participant_id
        AND e.event_type = 'PURCHASE' ${poolCond}
      ORDER BY e.ts_ms OFFSET ${P(Math.max(0, slot - 1))} LIMIT 1) = ${P(Number(itemId) | 0)}`;
  };

  // ── subject CTE filters (on `participants`, index-friendly) ──
  const cte: string[] = [];
  if (g.subject?.champion) cte.push(`champion_name = ${P(g.subject.champion)}`);
  if (g.subject?.role && ROLES.has(g.subject.role)) cte.push(`role = ${P(g.subject.role)}`);
  // Subject build-slot checks run on `s` AFTER it materializes (the cohort is
  // already narrowed by champion + patch/queue/region/tier), not inside the CTE
  // where the planner might probe the slot per row over the whole champion pool.
  const subjectSlots: string[] = [];
  for (const it of g.subject?.items ?? []) {
    const slot = slotOf(g.subject, it);
    if (slot) subjectSlots.push(slotItem("s", it, slot));
    else cte.push(itemOr("", it)); // final-inventory check is index-friendly — keep it in the CTE
  }
  const sk = (g.subject?.keystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
  if (sk.length) cte.push(`perk_keystone = ANY(${P(sk)})`);
  // EXCLUDE: the subject must NOT have built these items / run these keystones.
  for (const it of g.subject?.excludeItems ?? []) cte.push(`NOT ${itemOr("", it)}`);
  const sek = (g.subject?.excludeKeystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
  if (sek.length) cte.push(`(perk_keystone IS NULL OR perk_keystone <> ALL(${P(sek)}))`);
  const tiers = (g.filters?.tiers ?? []).filter((t) => TIERS.has(t));
  if (tiers.length) cte.push(`tier = ANY(${P(tiers)})`);
  // Patch + queue scoping is pushed INTO the subject CTE as a `match_id IN
  // (SELECT … FROM matches …)` semi-join, NOT a join in the outer query. This
  // narrows the subject to the chosen patch(es) BEFORE any ally/enemy EXISTS
  // runs, so a high-volume champion (all-patch Ezreal ≈ 120k rows) is
  // materialized down to its scoped slice first and the EXISTS probes only those.
  // With matches joined in the outer query the planner ran the EXISTS across all
  // 120k rows before applying the patch filter — 28s, tripping the timeout.
  // `patch` is an indexed column (idx_matches_patch_queue) = the major.minor of
  // game_version, so this is a clean equality/ANY, not a LIKE.
  const matchCond: string[] = [];
  if (scope.kind === "current") matchCond.push(`patch = ${P(scope.patch)}`);
  const queues = g.filters?.queues?.length ? g.filters.queues.map((q) => Number(q) | 0) : [420, 440];
  matchCond.push(`queue_id = ANY(${P(queues)})`);
  // region filter: `matches.platform` is the lowercase platform code (e.g. "euw1")
  // — indexed, so it lives in the same matches semi-join as patch/queue.
  const plats = (g.filters?.platforms ?? [])
    .map((p) => String(p).toLowerCase().trim())
    .filter((p) => /^[a-z]{2,4}[0-9]?$/.test(p));
  if (plats.length) matchCond.push(`platform = ANY(${P(plats)})`);
  const matchSub = `SELECT match_id FROM matches WHERE ${matchCond.join(" AND ")}`;
  // For a PATCH-SCOPED query, wrap the match set in ARRAY(...) instead of a bare
  // `match_id IN (subquery)`. The array form lets the planner use it as an index
  // condition on idx_participants_cname_match (champion_name, match_id), so it
  // touches ONLY the current-patch rows of the champion. With `IN (subquery)` the
  // planner scans ALL of the champion's rows (every patch) via the champion_name
  // index and applies the patch filter afterwards — for a mega-popular champion
  // (Kai'Sa ≈ 105k all-patch rows, ~1 per heap page) that's ~760 MB of random
  // reads and ~47s. The ARRAY form restricts to the ~14k current-patch rows first:
  // 47s → <1s warm, measured. (All-scope has no patch filter, so the array would
  // be every ranked match — keep the plain semi-join there.)
  if (scope.kind === "current") cte.push(`match_id = ANY(ARRAY(${matchSub}))`);
  else cte.push(`match_id IN (${matchSub})`);
  const cteWhere = `WHERE ${cte.join(" AND ")}`;

  // ── outer filters: ally/enemy existence only (patch/queue now in the CTE) ──
  const outer: string[] = [];
  for (const c of g.constraints ?? []) {
    if (c.type !== "ally" && c.type !== "enemy") continue;
    // team_id is always 100 or 200 in these queues, so "the enemy team" is
    // `300 - s.team_id` — an equality the (match_id, team_id) index can seek,
    // unlike `<>` which forces a scan of all of a match's participants.
    const teamExpr = c.type === "ally" ? `x.team_id = s.team_id` : `x.team_id = 300 - s.team_id`;
    const sub = [`x.match_id = s.match_id`, teamExpr];
    if (c.type === "ally") sub.push(`x.puuid <> s.puuid`);
    if (c.champion) sub.push(`x.champion_name = ${P(c.champion)}`);
    if (c.role && ROLES.has(c.role)) sub.push(`x.role = ${P(c.role)}`);
    for (const it of c.items ?? []) {
      const slot = slotOf(c, it);
      sub.push(slot ? slotItem("x", it, slot) : itemOr("x", it));
    }
    const ck = (c.keystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
    if (ck.length) sub.push(`x.perk_keystone = ANY(${P(ck)})`);
    // EXCLUDE wired into an item/rune ON the ally/enemy → that ally must NOT have it.
    for (const it of c.excludeItems ?? []) sub.push(`NOT ${itemOr("x", it)}`);
    const cek = (c.excludeKeystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
    if (cek.length) sub.push(`(x.perk_keystone IS NULL OR x.perk_keystone <> ALL(${P(cek)}))`);
    // `LIMIT 1 OFFSET 0` is an optimization fence. Without it, adding a role
    // filter to the ally/enemy EXISTS makes the planner flatten it into a hash
    // semi-join that bulk-scans the entire (champion_name, role) cohort across
    // ALL patches (~14k rows) before applying the current-patch filter — 25-30s,
    // tripping the statement_timeout ("query too heavy"). The fence keeps it a
    // correlated per-match index probe (idx_participants_cname_match), ~5× faster.
    // `negate` (EXCLUDE on the ally/enemy itself) flips EXISTS → NOT EXISTS.
    outer.push(`${c.negate ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM participants x WHERE ${sub.join(" AND ")} LIMIT 1 OFFSET 0)`);
  }

  // ── team-composition (champion-class) constraints ──
  // "the enemy/ally team has ≥N champions of class C". Expand C to its champion_name
  // list (Data Dragon class map) and COUNT the relevant team's participants in it —
  // a correlated per-match probe on the (match_id, team_id) index, same shape as the
  // ally/enemy EXISTS. Unknown class / map not loaded → empty list → skipped (no-op).
  for (const cc of g.categories ?? []) {
    if (!isChampCategory(cc.cls)) continue;
    const names = categoryMembers(cc.cls);
    if (names.length === 0) continue;
    const min = Math.max(1, Math.min(5, Number(cc.min) | 0));
    const teamExpr = cc.side === "ally" ? `cc.team_id = s.team_id` : `cc.team_id = 300 - s.team_id`;
    const selfExcl = cc.side === "ally" ? ` AND cc.puuid <> s.puuid` : "";
    outer.push(
      `(SELECT count(*) FROM participants cc WHERE cc.match_id = s.match_id AND ${teamExpr}${selfExcl} AND cc.champion_name = ANY(${P(names)})) >= ${P(min)}`
    );
  }

  // Subject build-slot predicates are evaluated in the OUTER query, against the
  // already-materialized (and narrowed) cohort `s` — so participant_id must be in
  // s's SELECT list.
  outer.push(...subjectSlots);
  const cteSql = `WITH s AS MATERIALIZED (
  SELECT match_id, participant_id, team_id, puuid, win, kills, deaths, assists, total_cs, gold_earned,
         item0, item1, item2, item3, item4, item5, item6
  FROM participants
  ${cteWhere}
)`;
  const base = `FROM s`;
  const outerWhere = outer.length ? `WHERE ${outer.join("\n    AND ")}` : "";
  return { cteSql, base, outerWhere };
}

export function compile(g: ExplorerGraph, patchPrefix: string): CompiledQuery {
  const params: unknown[] = [];
  const P = (v: unknown) => `$${params.push(v)}`;

  const scope: "current_patch" | "all" = g.filters?.scope === "all" ? "all" : "current_patch";
  const { cteSql, base, outerWhere } = buildCohort(
    g,
    P,
    scope === "all" ? { kind: "all" } : { kind: "current", patch: patchPrefix }
  );

  // ── output: single aggregate ──
  if (g.output.kind === "stats") {
    const text = `${cteSql}
  SELECT count(*)::int AS games,
         round(avg((s.win)::int) * 100, 2)::float8 AS winrate,
         round(avg(s.kills), 2)::float8 AS avg_kills,
         round(avg(s.deaths), 2)::float8 AS avg_deaths,
         round(avg(s.assists), 2)::float8 AS avg_assists,
         round(avg(s.total_cs), 1)::float8 AS avg_cs,
         round(avg(s.gold_earned))::int AS avg_gold
  ${base}
  ${outerWhere}`;
    return { text, params, mode: scope };
  }

  // ── output: ranking ──
  const limit = Math.min(Math.max(Number(g.output.limit ?? 10) | 0, 1), 50);
  const minGames = Math.max(Number(g.output.minGames ?? 5) | 0, 1);
  const dim = g.output.dimension;

  if (dim === "ally" || dim === "enemy") {
    const teamExpr = dim === "ally" ? `r.team_id = s.team_id` : `r.team_id = 300 - s.team_id`;
    const j = [`r.match_id = s.match_id`, teamExpr];
    if (dim === "ally") j.push(`r.puuid <> s.puuid`);
    if (g.output.role && ROLES.has(g.output.role)) j.push(`r.role = ${P(g.output.role)}`);
    // Rank champions by a CONFIDENCE-WEIGHTED LIFT, not raw winrate — otherwise a
    // 7-game off-meta pick at 85% buries the genuinely good, reliable partners (and
    // the headline games count collapses to that handful). Same Bayesian shrinkage
    // as the item branch: shrunk_wr regresses small samples toward the subject's
    // baseline winrate (coh.b); log10(games) rewards proven, high-sample pairings.
    // `cohort_games` (coh.n) is the FULL subject sample — surfaced so the UI shows
    // "analyzed N games" instead of the sum of the few displayed rows.
    const C = ITEM_PRIOR_C;
    const text = `${cteSql},
  coh AS (SELECT count(*)::int AS n, avg((s.win)::int) AS b FROM s ${outerWhere})
  SELECT r.champion_name AS dimension,
         count(*)::int AS games,
         round(avg((s.win)::int) * 100, 2)::float8 AS winrate,
         round((avg((s.win)::int) - max(coh.b)) * 100, 2)::float8 AS lift,
         round(max(coh.b) * 100, 2)::float8 AS baseline,
         max(coh.n)::int AS cohort_games
  ${base}
  JOIN participants r ON ${j.join(" AND ")}
  CROSS JOIN coh
  ${outerWhere}
  GROUP BY r.champion_name
  HAVING count(*) >= ${P(minGames)}
  ORDER BY (((sum((s.win)::int) + ${C} * max(coh.b)) / (count(*) + ${C})) - max(coh.b)) * log(10, (1 + count(*))::numeric) DESC, games DESC
  LIMIT ${P(limit)}`;
    return { text, params, mode: scope };
  }

  if (dim === "item") {
    // Only rank real build items: the frontend passes the current completed-item +
    // boots id set (no components, no trinkets). Falls back to "any non-empty slot"
    // if no pool is given. The trinket slot (item6) is excluded by the pool anyway.
    const pool = (g.output.itemPool ?? []).map((n) => Number(n) | 0).filter((n) => n > 0);
    const itemCond = pool.length ? `it.item = ANY(${P(pool)})` : "it.item IS NOT NULL AND it.item <> 0";
    const andOr = outerWhere ? "AND" : "WHERE";
    const C = ITEM_PRIOR_C;
    // Items are ranked by a CONFIDENCE-WEIGHTED LIFT, not raw winrate:
    //   score = (shrunk_wr − baseline) · log10(1 + games)
    // shrunk_wr = (wins + C·baseline)/(games + C) regresses small samples toward the
    // cohort's overall winrate (`coh.b`); the log10(games) factor rewards proven /
    // high-pick items. So 55% over 8000g outranks 80% over 100g when the latter is
    // noise, while a genuinely strong well-played item still rises. `coh` is the
    // (filtered) cohort baseline; `lift`/`pickrate`/`baseline` are surfaced for the UI.
    const text = `${cteSql},
  coh AS (SELECT count(*)::int AS n, avg((s.win)::int) AS b FROM s ${outerWhere})
  SELECT it.item AS dimension,
         count(*)::int AS games,
         round(avg((s.win)::int) * 100, 2)::float8 AS winrate,
         round((avg((s.win)::int) - max(coh.b)) * 100, 2)::float8 AS lift,
         round(count(*)::numeric / nullif(max(coh.n), 0) * 100, 2)::float8 AS pickrate,
         round(max(coh.b) * 100, 2)::float8 AS baseline,
         max(coh.n)::int AS cohort_games,
         round(
           (((sum((s.win)::int) + ${C} * max(coh.b)) / (count(*) + ${C})) - max(coh.b))
           * log(10, (1 + count(*))::numeric)
         , 5)::float8 AS score
  ${base}
  CROSS JOIN LATERAL (VALUES (s.item0),(s.item1),(s.item2),(s.item3),(s.item4),(s.item5),(s.item6)) AS it(item)
  CROSS JOIN coh
  ${outerWhere}
  ${andOr} ${itemCond}
  GROUP BY it.item
  HAVING count(*) >= ${P(minGames)}
  ORDER BY score DESC, games DESC
  LIMIT ${P(limit)}`;
    return { text, params, mode: scope };
  }

  throw new Error("unknown output dimension");
}
