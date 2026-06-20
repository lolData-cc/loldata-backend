// src/server/explorer/pool.ts
//
// A raw `pg` pool for the EXPLORER endpoint. The rest of the backend talks to
// Supabase/PostgREST, but the node-query compiler emits self-joins + group-bys
// that PostgREST can't express, so this hits Postgres directly on DATABASE_URL
// (the same connection string the cron uses). Set DATABASE_URL in the backend
// service env (Railway) — same value as loldata-cron.

import { Pool } from "pg";

let _pool: Pool | null = null;

export function explorerPool(): Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (required by /api/explorer/query)");
    _pool = new Pool({ connectionString: url, max: 6, idleTimeoutMillis: 30_000 });
  }
  return _pool;
}

// Current live patch prefix (e.g. "16.12"), cached ~10 min. The patch that
// contains the most-recent ranked game wins.
let _patch = "";
let _patchAt = 0;
export async function currentPatchPrefix(): Promise<string> {
  const now = Date.now();
  if (_patch && now - _patchAt < 600_000) return _patch;
  try {
    const { rows } = await explorerPool().query(
      `SELECT split_part(game_version, '.', 1) || '.' || split_part(game_version, '.', 2) AS v
         FROM matches
        WHERE game_version IS NOT NULL
        GROUP BY v
        ORDER BY max(game_creation) DESC
        LIMIT 1`
    );
    _patch = (rows[0]?.v as string) || _patch || "16.12";
    _patchAt = now;
  } catch {
    if (!_patch) _patch = "16.12";
  }
  return _patch;
}

// The N most-recent patch prefixes, newest-first, cached ~10 min. Powers PATCH
// VARIATION: the subject cohort is scoped to exactly these patches and grouped
// by patch so the UI can plot drift across them. Uses the indexed `patch`
// column (same value the compiler filters on).
let _recent: string[] = [];
let _recentN = 0;
let _recentAt = 0;
export async function recentPatches(n = 6): Promise<string[]> {
  const now = Date.now();
  if (_recent.length && _recentN >= n && now - _recentAt < 600_000) return _recent.slice(0, n);
  try {
    const { rows } = await explorerPool().query(
      `SELECT patch
         FROM matches
        WHERE patch IS NOT NULL
        GROUP BY patch
        ORDER BY max(game_creation) DESC
        LIMIT $1`,
      [n]
    );
    const list = rows.map((r) => r.patch as string).filter(Boolean);
    if (list.length) {
      _recent = list;
      _recentN = n;
      _recentAt = now;
    }
  } catch {
    /* fall through to whatever we have cached (possibly empty) */
  }
  return _recent.slice(0, n);
}
