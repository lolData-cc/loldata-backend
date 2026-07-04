// Persists the player's chosen Improvement-Tree path (role) on the box DB.
// Follows the lazy-ensure pattern used by ai/chatStore.ts.
import { explorerPool } from "../../../explorer/pool";

let _ensured: Promise<void> | null = null;

function ensure(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      const c = await explorerPool().connect();
      try {
        await c.query(`
          CREATE TABLE IF NOT EXISTS improvement_tree (
            puuid       text PRIMARY KEY,
            region      text NOT NULL,
            role        text NOT NULL,
            created_at  timestamptz NOT NULL DEFAULT now(),
            updated_at  timestamptz NOT NULL DEFAULT now()
          );
        `);
      } finally {
        c.release();
      }
    })().catch((e) => {
      _ensured = null; // allow retry
      throw e;
    });
  }
  return _ensured;
}

export async function getChosenPath(puuid: string): Promise<string | null> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      const r = await c.query(`SELECT role FROM improvement_tree WHERE puuid = $1`, [puuid]);
      return r.rows[0]?.role ?? null;
    } finally {
      c.release();
    }
  } catch (e) {
    console.error("[improvement] getChosenPath:", (e as Error)?.message ?? e);
    return null;
  }
}

export async function setChosenPath(puuid: string, region: string, role: string): Promise<void> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      await c.query(
        `INSERT INTO improvement_tree (puuid, region, role) VALUES ($1, $2, $3)
         ON CONFLICT (puuid) DO UPDATE SET role = EXCLUDED.role, region = EXCLUDED.region, updated_at = now()`,
        [puuid, region, role]
      );
    } finally {
      c.release();
    }
  } catch (e) {
    console.error("[improvement] setChosenPath:", (e as Error)?.message ?? e);
  }
}
