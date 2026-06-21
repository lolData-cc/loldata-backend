// src/server/explorer/itemStrength.ts
//
// CONDITIONAL ITEM-STRENGTH engine. For a champion + a specific item, decides
// when that item is statistically GOOD or BAD depending on the ENEMY composition
// (e.g. "Death's Dance is +4.2% WR when the enemy has ≥3 AD champions").
//
// Method (see the research methodology):
//   • Take the subject cohort, keep the players who BUILT the item (final inventory).
//   • For each enemy-composition condition P (e.g. "≥2 Assassins", "≥3 AD champs"),
//     split those builders into IN (P holds) and OUT (P doesn't) buckets.
//   • Compare the two winrates with a two-proportion z-test; shrink each bucket
//     toward the item's own winrate to tame small buckets.
//   • Flag "good/bad vs P" only when both buckets have ≥100 games (and ≥10 wins
//     and ≥10 losses), |z| ≥ 1.96, and the shrunk effect ≥ 2 pp — so we never
//     surface noise as a verdict.
//
// Enemy composition is derived from a champion→class/damage map (champClass.ts),
// injected into SQL as a (champion_name, category) table and counted per match.

import { buildCohort, type ExplorerGraph } from "./compile";
import { explorerPool, currentPatchPrefix } from "./pool";
import {
  CHAMP_CLASSES,
  championsInClass,
  championsByDamage,
  champClassesReady,
  type ChampClass,
} from "./champClass";

const CLASS_THRESHOLD = 2; // "≥2 of this class" — discriminating yet keeps buckets large
const DAMAGE_THRESHOLD = 3; // "≥3 AD/AP champions" — natural for damage-profile conditions
const SHRINK_C = 40; // smaller prior than the global ranking: buckets are smaller
const MIN_BUCKET_GAMES = 100; // hard floor per bucket to even run the test
const MIN_WL = 10; // ≥10 wins and ≥10 losses per bucket (normal-approx validity)
const Z_SIG = 1.96; // 95% two-sided
const MIN_EFFECT = 0.02; // ≥2 pp shrunk effect to be "practically" meaningful

// Human labels + a short mechanical rationale (only mechanically-plausible pairs
// are emphasised; we still compute all, but the UI can lead with the rational ones).
const CONDITION_LABEL: Record<string, string> = {
  Assassin: "≥2 enemy Assassins",
  Fighter: "≥2 enemy Fighters",
  Mage: "≥2 enemy Mages",
  Marksman: "≥2 enemy Marksmen",
  Support: "≥2 enemy Supports",
  Tank: "≥2 enemy Tanks",
  AD: "≥3 enemy AD champions",
  AP: "≥3 enemy AP champions",
};

export type StrengthVerdict = {
  category: string; // class name or "AD"/"AP"
  label: string;
  threshold: number;
  gamesIn: number;
  winrateIn: number; // 0..100
  gamesOut: number;
  winrateOut: number; // 0..100
  delta: number; // shrunk (in − out), percentage points
  z: number; // two-proportion z
  significant: boolean; // passes all gates
  direction: "strong" | "weak" | "neutral";
};

export type ItemStrengthResult = {
  item: number;
  builderGames: number; // cohort players who built the item
  builderWinrate: number; // their overall WR, 0..100
  baseline: number; // cohort overall WR, 0..100
  verdicts: StrengthVerdict[];
  ready: boolean; // champion class map loaded?
  patch: string;
  mode: "current_patch" | "all";
};

type Cond = { cat: string; thr: number };

type RawRow = {
  cat: string;
  thr: number;
  games_in: number;
  wins_in: number;
  games_out: number;
  wins_out: number;
};

export async function itemStrength(
  g: ExplorerGraph,
  itemId: number,
  patchPrefix: string
): Promise<ItemStrengthResult> {
  const scope: "current_patch" | "all" = g.filters?.scope === "all" ? "all" : "current_patch";

  if (!champClassesReady()) {
    return {
      item: itemId,
      builderGames: 0,
      builderWinrate: 0,
      baseline: 0,
      verdicts: [],
      ready: false,
      patch: patchPrefix,
      mode: scope,
    };
  }

  // champion → category rows (one per class membership + one per damage profile)
  const names: string[] = [];
  const cats: string[] = [];
  for (const cls of CHAMP_CLASSES) {
    for (const nm of championsInClass(cls)) {
      names.push(nm);
      cats.push(cls);
    }
  }
  for (const dmg of ["AD", "AP"] as const) {
    for (const nm of championsByDamage(dmg)) {
      names.push(nm);
      cats.push(dmg);
    }
  }

  const conds: Cond[] = [
    ...CHAMP_CLASSES.map((c) => ({ cat: c as string, thr: CLASS_THRESHOLD })),
    { cat: "AD", thr: DAMAGE_THRESHOLD },
    { cat: "AP", thr: DAMAGE_THRESHOLD },
  ];

  const params: unknown[] = [];
  const P = (v: unknown) => `$${params.push(v)}`;
  const { cteSql, outerWhere } = buildCohort(
    g,
    P,
    scope === "all" ? { kind: "all" } : { kind: "current", patch: patchPrefix }
  );

  const it = P(Number(itemId) | 0); // reused 7× (one per inventory slot)
  const builtExpr = `(s.item0=${it} OR s.item1=${it} OR s.item2=${it} OR s.item3=${it} OR s.item4=${it} OR s.item5=${it} OR s.item6=${it})`;
  const namesP = P(names);
  const catsP = P(cats);

  // pivoted enemy-category counts per builder, then UNION one bucket-split per cond
  const pivotCols = conds
    .map((c) => `coalesce(max(ec.cnt) FILTER (WHERE ec.cls = '${c.cat}'), 0) AS c_${c.cat}`)
    .join(",\n         ");
  const unionParts = conds
    .map(
      (c) => `  SELECT '${c.cat}' AS cat, ${c.thr} AS thr,
         count(*) FILTER (WHERE c_${c.cat} >= ${c.thr})::int AS games_in,
         coalesce(sum(win) FILTER (WHERE c_${c.cat} >= ${c.thr}), 0)::int AS wins_in,
         count(*) FILTER (WHERE c_${c.cat} < ${c.thr})::int AS games_out,
         coalesce(sum(win) FILTER (WHERE c_${c.cat} < ${c.thr}), 0)::int AS wins_out
  FROM builders`
    )
    .join("\n  UNION ALL\n");

  const text = `${cteSql},
  sf AS (
    SELECT s.match_id, s.participant_id, s.team_id, (s.win)::int AS win, ${builtExpr} AS built
    FROM s
    ${outerWhere}
  ),
  champ_cat(champion_name, cls) AS (
    SELECT * FROM unnest(${namesP}::text[], ${catsP}::text[]) AS t(champion_name, cls)
  ),
  enemy_counts AS (
    SELECT sf.match_id, sf.participant_id, cc.cls AS cls, count(*)::int AS cnt
    FROM sf
    JOIN participants e ON e.match_id = sf.match_id AND e.team_id = 300 - sf.team_id
    JOIN champ_cat cc ON lower(cc.champion_name) = lower(e.champion_name)
    WHERE sf.built
    GROUP BY sf.match_id, sf.participant_id, cc.cls
  ),
  builders AS (
    SELECT sf.match_id, sf.participant_id, sf.win,
         ${pivotCols}
    FROM sf
    LEFT JOIN enemy_counts ec
      ON ec.match_id = sf.match_id AND ec.participant_id = sf.participant_id
    WHERE sf.built
    GROUP BY sf.match_id, sf.participant_id, sf.win
  )
${unionParts}`;

  let client: Awaited<ReturnType<ReturnType<typeof explorerPool>["connect"]>> | undefined;
  let rows: RawRow[] = [];
  try {
    client = await explorerPool().connect();
    await client.query("SET statement_timeout = 25000");
    const r = await client.query(text, params);
    rows = r.rows as RawRow[];
  } finally {
    client?.release();
  }

  // builder totals (sum of any cond's in+out is the same: all builders)
  let builderGames = 0;
  let builderWins = 0;
  if (rows.length) {
    const r0 = rows[0];
    builderGames = Number(r0.games_in) + Number(r0.games_out);
    builderWins = Number(r0.wins_in) + Number(r0.wins_out);
  }
  const pX = builderGames > 0 ? builderWins / builderGames : 0; // item's own WR (shrink target)

  const verdicts: StrengthVerdict[] = rows.map((r) => {
    const gi = Number(r.games_in);
    const go = Number(r.games_out);
    const wi = Number(r.wins_in);
    const wo = Number(r.wins_out);
    const pin = gi > 0 ? wi / gi : 0;
    const pout = go > 0 ? wo / go : 0;

    // shrunk effect toward the item's own WR
    const pinS = (wi + SHRINK_C * pX) / (gi + SHRINK_C);
    const poutS = (wo + SHRINK_C * pX) / (go + SHRINK_C);
    const deltaS = pinS - poutS;

    // two-proportion z-test on the raw bucket counts
    let z = 0;
    if (gi > 0 && go > 0) {
      const pPool = (wi + wo) / (gi + go);
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / gi + 1 / go));
      z = se > 0 ? (pin - pout) / se : 0;
    }

    const lossesIn = gi - wi;
    const lossesOut = go - wo;
    const gated =
      gi >= MIN_BUCKET_GAMES &&
      go >= MIN_BUCKET_GAMES &&
      wi >= MIN_WL &&
      wo >= MIN_WL &&
      lossesIn >= MIN_WL &&
      lossesOut >= MIN_WL;
    const significant = gated && Math.abs(z) >= Z_SIG && Math.abs(deltaS) >= MIN_EFFECT;
    const direction: StrengthVerdict["direction"] = !significant
      ? "neutral"
      : deltaS > 0
        ? "strong"
        : "weak";

    return {
      category: r.cat,
      label: CONDITION_LABEL[r.cat] ?? r.cat,
      threshold: Number(r.thr),
      gamesIn: gi,
      winrateIn: round2(pin * 100),
      gamesOut: go,
      winrateOut: round2(pout * 100),
      delta: round2(deltaS * 100),
      z: round2(z),
      significant,
      direction,
    };
  });

  // significant first (by |effect|), then the rest
  verdicts.sort((a, b) => {
    if (a.significant !== b.significant) return a.significant ? -1 : 1;
    return Math.abs(b.delta) - Math.abs(a.delta);
  });

  return {
    item: itemId,
    builderGames,
    builderWinrate: round2(pX * 100),
    baseline: 0, // filled below if we want; cohort baseline not needed for verdicts
    verdicts,
    ready: true,
    patch: patchPrefix,
    mode: scope,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── HTTP handler ───────────────────────────────────────────────────
export async function explorerItemStrengthHandler(req: Request): Promise<Response> {
  let body: { graph?: ExplorerGraph; itemId?: number };
  try {
    body = (await req.json()) as { graph?: ExplorerGraph; itemId?: number };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const graph = body?.graph;
  const itemId = Number(body?.itemId) | 0;
  if (!graph?.subject?.champion) {
    return Response.json({ error: "A subject champion is required" }, { status: 400 });
  }
  if (!itemId) {
    return Response.json({ error: "An itemId is required" }, { status: 400 });
  }
  const t0 = Date.now();
  try {
    const patch = await currentPatchPrefix();
    const result = await itemStrength(graph, itemId, patch);
    return Response.json({ ...result, ms: Date.now() - t0 });
  } catch (e: any) {
    console.error("[explorer] itemstrength error:", String(e?.message ?? e));
    return Response.json({ error: "Item-strength query failed" }, { status: 500 });
  }
}
