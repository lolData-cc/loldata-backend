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
};

export type Constraint =
  | ({ type: "ally" } & ChampSpec)
  | ({ type: "enemy" } & ChampSpec);

export type Filters = {
  scope?: "current_patch" | "all";
  tiers?: string[];
  queues?: number[];
};

export type Output =
  | { kind: "stats" }
  | {
      kind: "rank";
      dimension: "ally" | "enemy" | "item";
      role?: Role;
      limit?: number;
      minGames?: number;
    };

export type ExplorerGraph = {
  subject: ChampSpec;
  constraints?: Constraint[];
  filters?: Filters;
  output: Output;
};

export type CompiledQuery = {
  text: string;
  params: unknown[];
  mode: "current_patch" | "all";
};

export function compile(g: ExplorerGraph, patchPrefix: string): CompiledQuery {
  const params: unknown[] = [];
  const P = (v: unknown) => `$${params.push(v)}`;
  // "<alias> built item X in ANY slot" — alias "" = unqualified (CTE body)
  const itemOr = (alias: string, itemId: number) => {
    const a = alias ? `${alias}.` : "";
    const ph = P(Number(itemId) | 0);
    return `(${a}item0=${ph} OR ${a}item1=${ph} OR ${a}item2=${ph} OR ${a}item3=${ph} OR ${a}item4=${ph} OR ${a}item5=${ph} OR ${a}item6=${ph})`;
  };

  // ── subject CTE filters (on `participants`, index-friendly) ──
  const cte: string[] = [];
  if (g.subject?.champion) cte.push(`champion_name = ${P(g.subject.champion)}`);
  if (g.subject?.role && ROLES.has(g.subject.role)) cte.push(`role = ${P(g.subject.role)}`);
  for (const it of g.subject?.items ?? []) cte.push(itemOr("", it));
  const sk = (g.subject?.keystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
  if (sk.length) cte.push(`perk_keystone = ANY(${P(sk)})`);
  const tiers = (g.filters?.tiers ?? []).filter((t) => TIERS.has(t));
  if (tiers.length) cte.push(`tier = ANY(${P(tiers)})`);
  // Patch + queue scoping is pushed INTO the subject CTE as a `match_id IN
  // (SELECT … FROM matches …)` semi-join, NOT a join in the outer query. This
  // narrows the subject to the current patch BEFORE any ally/enemy EXISTS runs,
  // so a high-volume champion (all-patch Ezreal ≈ 120k rows) is materialized
  // down to its ~current-patch slice first and the EXISTS probes only those.
  // With matches joined in the outer query the planner ran the EXISTS across all
  // 120k rows before applying the patch filter — 28s, tripping the timeout.
  // `patch` is an indexed column (idx_matches_patch_queue) = the major.minor of
  // game_version, so this is a clean equality, not a LIKE.
  const scope: "current_patch" | "all" = g.filters?.scope === "all" ? "all" : "current_patch";
  const matchCond: string[] = [];
  if (scope === "current_patch") matchCond.push(`patch = ${P(patchPrefix)}`);
  const queues = g.filters?.queues?.length ? g.filters.queues.map((q) => Number(q) | 0) : [420, 440];
  matchCond.push(`queue_id = ANY(${P(queues)})`);
  cte.push(`match_id IN (SELECT match_id FROM matches WHERE ${matchCond.join(" AND ")})`);
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
    for (const it of c.items ?? []) sub.push(itemOr("x", it));
    const ck = (c.keystones ?? []).map((n) => Number(n) | 0).filter(Boolean);
    if (ck.length) sub.push(`x.perk_keystone = ANY(${P(ck)})`);
    // `LIMIT 1 OFFSET 0` is an optimization fence. Without it, adding a role
    // filter to the ally/enemy EXISTS makes the planner flatten it into a hash
    // semi-join that bulk-scans the entire (champion_name, role) cohort across
    // ALL patches (~14k rows) before applying the current-patch filter — 25-30s,
    // tripping the statement_timeout ("query too heavy"). The fence keeps it a
    // correlated per-match index probe (idx_participants_cname_match), ~5× faster.
    outer.push(`EXISTS (SELECT 1 FROM participants x WHERE ${sub.join(" AND ")} LIMIT 1 OFFSET 0)`);
  }

  const cteSql = `WITH s AS MATERIALIZED (
  SELECT match_id, team_id, puuid, win, kills, deaths, assists, total_cs, gold_earned,
         item0, item1, item2, item3, item4, item5, item6
  FROM participants
  ${cteWhere}
)`;
  const base = `FROM s`;
  const outerWhere = outer.length ? `WHERE ${outer.join("\n    AND ")}` : "";

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
    const text = `${cteSql}
  SELECT r.champion_name AS dimension,
         count(*)::int AS games,
         round(avg((s.win)::int) * 100, 2)::float8 AS winrate
  ${base}
  JOIN participants r ON ${j.join(" AND ")}
  ${outerWhere}
  GROUP BY r.champion_name
  HAVING count(*) >= ${P(minGames)}
  ORDER BY winrate DESC, games DESC
  LIMIT ${P(limit)}`;
    return { text, params, mode: scope };
  }

  if (dim === "item") {
    const andOr = outerWhere ? "AND" : "WHERE";
    const text = `${cteSql}
  SELECT it.item AS dimension,
         count(*)::int AS games,
         round(avg((s.win)::int) * 100, 2)::float8 AS winrate
  ${base}
  CROSS JOIN LATERAL (VALUES (s.item0),(s.item1),(s.item2),(s.item3),(s.item4),(s.item5),(s.item6)) AS it(item)
  ${outerWhere}
  ${andOr} it.item IS NOT NULL AND it.item <> 0
  GROUP BY it.item
  HAVING count(*) >= ${P(minGames)}
  ORDER BY winrate DESC, games DESC
  LIMIT ${P(limit)}`;
    return { text, params, mode: scope };
  }

  throw new Error("unknown output dimension");
}
