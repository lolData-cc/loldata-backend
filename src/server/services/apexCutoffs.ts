// src/server/services/apexCutoffs.ts
// Nightly snapshot of the Grandmaster + Challenger LP cutoffs per region, so the
// /players apex progress bars know how far a Master/GM/Challenger is toward the
// next rank. Per region we read the apex leagues and store:
//   gm_cutoff         = MEDIAN LP among Grandmaster players (real GM bulk)
//   challenger_cutoff = MEDIAN LP among Challenger players (real Challenger bulk)
//   challenger_max    = highest Challenger LP (rank 1)
// Median, not min: the apex leagues carry a low-LP tail of ghost entries that
// makes a min-based cutoff useless (see apexStats).

import { explorerPool } from "../explorer/pool";
import { getApexLeague } from "../riot";

const REGIONS = ["EUW", "EUNE", "NA", "KR"];

let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      const c = await explorerPool().connect();
      try {
        await c.query(`
          CREATE TABLE IF NOT EXISTS apex_cutoffs (
            region            text PRIMARY KEY,
            gm_cutoff         int,
            challenger_cutoff int,
            challenger_max    int,
            updated_at        timestamptz NOT NULL DEFAULT now()
          );
        `);
      } finally { c.release(); }
    })().catch((e) => { _ensured = null; throw e; });
  }
  return _ensured;
}

// The cutoff is the MEDIAN LP of the tier, not the raw minimum: the apex leagues
// carry a long tail of just-promoted / decaying "ghost" entries at very low LP
// (e.g. an EUW Grandmaster sitting at 71 LP) that would make a min-based cutoff
// meaningless. The median tracks the real bulk of the tier (~1800 LP for EUW GM,
// ~2490 for EUW Challenger). `max` is the #1 player.
function apexStats(league: any): { cutoff: number | null; max: number | null } {
  const lps: number[] = (Array.isArray(league?.entries) ? league.entries : [])
    .map((e: any) => Number(e?.leaguePoints ?? 0))
    .filter((x: number) => Number.isFinite(x))
    .sort((a: number, b: number) => a - b);
  if (!lps.length) return { cutoff: null, max: null };
  return { cutoff: lps[Math.floor(lps.length / 2)], max: lps[lps.length - 1] };
}

export async function refreshApexCutoffs(): Promise<void> {
  await ensure();
  for (const region of REGIONS) {
    try {
      const [chall, gm] = await Promise.all([
        getApexLeague("challenger", region),
        getApexLeague("grandmaster", region),
      ]);
      const c = apexStats(chall);
      const g = apexStats(gm);
      const conn = await explorerPool().connect();
      try {
        await conn.query(
          `INSERT INTO apex_cutoffs (region, gm_cutoff, challenger_cutoff, challenger_max, updated_at)
             VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (region) DO UPDATE SET
             gm_cutoff = EXCLUDED.gm_cutoff, challenger_cutoff = EXCLUDED.challenger_cutoff,
             challenger_max = EXCLUDED.challenger_max, updated_at = now()`,
          [region, g.cutoff, c.cutoff, c.max]
        );
      } finally { conn.release(); }
      console.log(`[apex] ${region}: GM~${g.cutoff} CHALL~${c.cutoff} #1=${c.max}`);
    } catch (e) {
      console.warn(`[apex] ${region} failed:`, (e as any)?.message ?? e);
    }
  }
}

export type ApexCutoff = { gm_cutoff: number | null; challenger_cutoff: number | null; challenger_max: number | null };
export async function getApexCutoffs(): Promise<Record<string, ApexCutoff>> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      const r = await c.query(`SELECT region, gm_cutoff, challenger_cutoff, challenger_max FROM apex_cutoffs`);
      const out: Record<string, ApexCutoff> = {};
      for (const row of r.rows as any[]) out[row.region] = { gm_cutoff: row.gm_cutoff, challenger_cutoff: row.challenger_cutoff, challenger_max: row.challenger_max };
      return out;
    } finally { c.release(); }
  } catch { return {}; }
}

// Run on boot (after warmup) + once a day.
let _started = false;
export function startApexCutoffSweep(): void {
  if (_started) return;
  _started = true;
  const run = () => refreshApexCutoffs().catch((e) => console.warn("[apex] sweep:", (e as any)?.message ?? e));
  setTimeout(run, 30_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
