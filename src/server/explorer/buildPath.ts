// src/server/explorer/buildPath.ts
//
// BUILD-PATH engine. Reconstructs the ordered "core item" build for a cohort from
// `participant_item_events` (PURCHASE events, ordered by ts_ms, restricted to the
// completed/legendary pool), then aggregates per PURCHASE SLOT:
//
//   slot 1 = the cohort's 1st completed item, slot 2 = the 2nd, …
//
// For every (slot, item) we return games, winrate, lift over the cohort baseline,
// pick rate, and the same confidence-weighted score as the item ranking. The
// frontend draws the most-picked item at each slot as the main "cyber path" and
// the rest as situational alternatives.
//
// IMPORTANT — survivorship: item winrate is computed PER SLOT, never pooled across
// slots (a 1st-item WR and a 5th-item WR aren't comparable — reaching item 5 means
// the game went long, which correlates with winning). Conditioning on slot is the
// standard fix (u.gg/lolalytics do the same).
//
// Coverage caveat: only games WITH timeline data have item events, so the build
// path covers a SUBSET of the cohort. We report `coverage` so the UI can show it.

import { buildCohort, type ExplorerGraph } from "./compile";
import { explorerPool, currentPatchPrefix } from "./pool";

const PRIOR_C = 150; // same Bayesian prior strength as the item ranking
const DEFAULT_MAX_SLOTS = 5;
const DEFAULT_TOP_PER_SLOT = 6;
const MIN_GAMES_PER_SLOT_ITEM = 10; // drop noise from a slot's alternatives

export type BuildSlotItem = {
  item: number;
  games: number;
  winrate: number; // 0..100
  lift: number; // percentage points vs cohort baseline
  pickrate: number; // 0..100 of covered games
  score: number; // confidence-weighted lift (see compile item-rank)
};

export type BuildPathResult = {
  slots: BuildSlotItem[][]; // slots[0] = 1st-item options (sorted by games desc), slots[1] = 2nd, …
  cohortGames: number; // total cohort players (subject rows after all filters)
  coveredGames: number; // cohort players that have item-purchase (timeline) data
  coverage: number; // coveredGames / cohortGames * 100
  baseline: number; // cohort overall winrate 0..100
  patch: string;
  mode: "current_patch" | "all";
};

type Row = {
  slot: number;
  item: number;
  games: number;
  wins: number;
  cohort_n: number;
  baseline: string | number; // numeric comes back as string from pg
  covered: number;
};

export async function buildPath(
  g: ExplorerGraph,
  patchPrefix: string,
  opts?: { maxSlots?: number; topPerSlot?: number }
): Promise<BuildPathResult> {
  const maxSlots = Math.max(1, Math.min(7, opts?.maxSlots ?? DEFAULT_MAX_SLOTS));
  const topPerSlot = Math.max(1, Math.min(12, opts?.topPerSlot ?? DEFAULT_TOP_PER_SLOT));

  const params: unknown[] = [];
  const P = (v: unknown) => `$${params.push(v)}`;
  const scope: "current_patch" | "all" = g.filters?.scope === "all" ? "all" : "current_patch";
  const { cteSql, outerWhere } = buildCohort(
    g,
    P,
    scope === "all" ? { kind: "all" } : { kind: "current", patch: patchPrefix }
  );

  // `sf` = the fully-filtered subject cohort; `seq` = each player's ordered completed
  // legendary build as an int[] (legendary_order, filled at ingest); we unnest WITH
  // ORDINALITY to get (item, slot); group by (slot, item). coh/cov carry the
  // baseline + coverage as constants on every row.
  const text = `${cteSql},
  sf AS (
    SELECT s.match_id, s.participant_id, (s.win)::int AS win
    FROM s
    ${outerWhere}
  ),
  seq AS (
    SELECT sf.win,
           (SELECT p.legendary_order FROM participants p
            WHERE p.match_id = sf.match_id AND p.participant_id = sf.participant_id) AS items
    FROM sf
  ),
  coh AS (SELECT count(*)::int AS n, avg(win)::numeric AS b FROM sf),
  cov AS (SELECT count(*)::int AS c FROM seq WHERE items IS NOT NULL)
  SELECT u.slot::int AS slot,
         u.item::int AS item,
         count(*)::int AS games,
         sum(seq.win)::int AS wins,
         max(coh.n) AS cohort_n,
         max(coh.b) AS baseline,
         max(cov.c) AS covered
  FROM seq
  CROSS JOIN LATERAL unnest(seq.items) WITH ORDINALITY AS u(item, slot)
  CROSS JOIN coh
  CROSS JOIN cov
  WHERE seq.items IS NOT NULL AND u.slot <= ${P(maxSlots)}
  GROUP BY u.slot, u.item
  ORDER BY u.slot, games DESC`;

  let client: Awaited<ReturnType<ReturnType<typeof explorerPool>["connect"]>> | undefined;
  let rows: Row[] = [];
  try {
    client = await explorerPool().connect();
    await client.query("SET statement_timeout = 25000");
    const r = await client.query(text, params);
    rows = r.rows as Row[];
  } finally {
    client?.release();
  }

  const cohortGames = rows.length ? Number(rows[0].cohort_n) : 0;
  const coveredGames = rows.length ? Number(rows[0].covered) : 0;
  const baseline = rows.length ? Number(rows[0].baseline) : 0; // 0..1

  // Post-process in JS: compute the weighted score, drop low-sample noise, keep
  // the top-N per slot. Small result set (~slots × distinct items), so this is cheap.
  const bySlot = new Map<number, BuildSlotItem[]>();
  for (const r of rows) {
    const games = Number(r.games);
    if (games < MIN_GAMES_PER_SLOT_ITEM) continue;
    const wins = Number(r.wins);
    const wr = games > 0 ? wins / games : 0;
    const shrunk = (wins + PRIOR_C * baseline) / (games + PRIOR_C);
    const score = (shrunk - baseline) * Math.log10(1 + games);
    const item: BuildSlotItem = {
      item: Number(r.item),
      games,
      winrate: round2(wr * 100),
      lift: round2((wr - baseline) * 100),
      pickrate: coveredGames > 0 ? round2((games / coveredGames) * 100) : 0,
      score: round5(score),
    };
    if (!bySlot.has(r.slot)) bySlot.set(r.slot, []);
    bySlot.get(r.slot)!.push(item);
  }

  const slots: BuildSlotItem[][] = [];
  for (let slot = 1; slot <= maxSlots; slot++) {
    const arr = (bySlot.get(slot) ?? []).sort((a, b) => b.games - a.games).slice(0, topPerSlot);
    slots.push(arr);
  }
  // Trim trailing empty slots (e.g. few players reached item 5).
  while (slots.length > 1 && slots[slots.length - 1].length === 0) slots.pop();

  return {
    slots,
    cohortGames,
    coveredGames,
    coverage: cohortGames > 0 ? round2((coveredGames / cohortGames) * 100) : 0,
    baseline: round2(baseline * 100),
    patch: patchPrefix,
    mode: scope,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

// ── HTTP handler ───────────────────────────────────────────────────
export async function explorerBuildPathHandler(req: Request): Promise<Response> {
  let graph: ExplorerGraph;
  try {
    graph = (await req.json()) as ExplorerGraph;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!graph?.subject?.champion) {
    return Response.json({ error: "A subject champion is required for the build path" }, { status: 400 });
  }
  const t0 = Date.now();
  try {
    const patch = await currentPatchPrefix();
    const result = await buildPath(graph, patch);
    return Response.json({ ...result, ms: Date.now() - t0 });
  } catch (e: any) {
    console.error("[explorer] buildpath error:", String(e?.message ?? e));
    return Response.json({ error: "Build-path query failed" }, { status: 500 });
  }
}
