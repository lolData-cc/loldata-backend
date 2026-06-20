// src/server/explorer/patchStats.ts
//
// Fast, subject-level PATCH VARIATION backed by the precomputed
// `explorer_patch_stats` table (sums per champion·role·patch·tier). Reads are
// instant — no cold scan of the 7M-row participants table. Honours the subject's
// champion + role and the Filter module's tiers; it does NOT reflect ally / item
// / rune constraints (those use the slow live path in query.ts).

import { explorerPool } from "./pool";
import type { ExplorerGraph } from "./compile";

const ROLES = new Set(["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]);
const TIERS = new Set([
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
]);

export type PatchStatRow = {
  patch: string; games: number; winrate: number | null;
  avg_kills: number | null; avg_deaths: number | null; avg_assists: number | null;
  avg_cs: number | null; avg_gold: number | null;
};

// Read the champion's per-patch trend, aggregating the stored sums across the
// requested roles/tiers so winrate + averages stay correct for any subset.
export async function readPatchVariation(g: ExplorerGraph): Promise<PatchStatRow[]> {
  const champion = g.subject?.champion;
  if (!champion) return [];

  const params: unknown[] = [champion];
  const where = ["champion_name = $1"];
  if (g.subject?.role && ROLES.has(g.subject.role)) {
    params.push(g.subject.role);
    where.push(`role = $${params.length}`);
  }
  const tiers = (g.filters?.tiers ?? []).filter((t) => TIERS.has(t));
  if (tiers.length) {
    params.push(tiers);
    where.push(`tier = ANY($${params.length})`);
  }

  const text = `
    SELECT patch,
           sum(games)::int AS games,
           round(100.0 * sum(wins) / nullif(sum(games), 0), 2)::float8 AS winrate,
           round(sum(sum_kills)::numeric   / nullif(sum(games), 0), 2)::float8 AS avg_kills,
           round(sum(sum_deaths)::numeric  / nullif(sum(games), 0), 2)::float8 AS avg_deaths,
           round(sum(sum_assists)::numeric / nullif(sum(games), 0), 2)::float8 AS avg_assists,
           round(sum(sum_cs)::numeric      / nullif(sum(games), 0), 1)::float8 AS avg_cs,
           round(sum(sum_gold)::numeric    / nullif(sum(games), 0))::int       AS avg_gold
    FROM explorer_patch_stats
    WHERE ${where.join(" AND ")}
    GROUP BY patch
    HAVING sum(games) > 0
    ORDER BY string_to_array(patch, '.')::int[]`; // oldest → newest

  const r = await explorerPool().query(text, params);
  return r.rows as PatchStatRow[];
}

// TRUNCATE + re-aggregate the whole table. One full GROUP-BY scan of
// participants ⋈ matches (~40s on the live set). Background job — call from the
// admin endpoint / alongside the snapshot rebuild, never on the request path.
export async function rebuildPatchStats(): Promise<number> {
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 300000"); // 5 min
    // Self-bootstrap so a fresh environment doesn't need the migration run first.
    await client.query(`
      CREATE TABLE IF NOT EXISTS explorer_patch_stats (
        champion_name text NOT NULL, role text NOT NULL, patch text NOT NULL, tier text NOT NULL,
        games integer NOT NULL, wins integer NOT NULL,
        sum_kills bigint NOT NULL, sum_deaths bigint NOT NULL, sum_assists bigint NOT NULL,
        sum_cs bigint NOT NULL, sum_gold bigint NOT NULL,
        PRIMARY KEY (champion_name, role, patch, tier));
      CREATE INDEX IF NOT EXISTS idx_eps_champion ON explorer_patch_stats (champion_name);`);
    await client.query("TRUNCATE explorer_patch_stats");
    const ins = await client.query(`
      INSERT INTO explorer_patch_stats
        (champion_name, role, patch, tier, games, wins, sum_kills, sum_deaths, sum_assists, sum_cs, sum_gold)
      SELECT p.champion_name, p.role, m.patch, COALESCE(p.tier, 'UNRANKED'),
             count(*)::int, COALESCE(sum((p.win)::int), 0)::int,
             COALESCE(sum(p.kills), 0)::bigint, COALESCE(sum(p.deaths), 0)::bigint, COALESCE(sum(p.assists), 0)::bigint,
             COALESCE(sum(p.total_cs), 0)::bigint, COALESCE(sum(p.gold_earned), 0)::bigint
      FROM participants p
      JOIN matches m ON m.match_id = p.match_id
      WHERE m.queue_id IN (420, 440) AND m.patch IS NOT NULL
        AND p.role IS NOT NULL AND p.champion_name IS NOT NULL
      GROUP BY p.champion_name, p.role, m.patch, COALESCE(p.tier, 'UNRANKED')`);
    return ins.rowCount ?? 0;
  } finally {
    client.release();
  }
}
