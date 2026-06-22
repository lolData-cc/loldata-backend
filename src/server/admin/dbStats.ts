// src/server/admin/dbStats.ts
//
// "How much data do we have" for the admin dashboard, served off the Explorer
// pg pool (DATABASE_URL) — so in prod it reflects the BOX (where ingest grows
// the match data), and in dev whatever the local backend points at.
//
// Two shapes:
//  • getDbOverview()  — snapshot for the tab: live match count + DB size + the
//    biggest tables (instant catalog reads + a cached count(*) on matches).
//  • the live ticker  — ONE server-side poll every 5s, fanned out to every
//    subscribed socket via server.publish(DBSTATS_TOPIC, …). The poll only runs
//    while ≥1 client is connected, so an idle dashboard costs nothing.
//
// Costs measured on the live DB: count(*) matches ≈ 290ms (cheap enough to tick),
// count(*) participants ≈ 4.2s (too slow → use the planner's reltuples estimate).

import type { Server } from "bun";
import { statfsSync } from "node:fs";
import { explorerPool } from "../explorer/pool";

export const DBSTATS_TOPIC = "dbstats";

export type TableStat = { table: string; estRows: number; sizeBytes: number; sizePretty: string };
export type DbOverview = {
  matches: number;          // exact, count(*)
  dbSizeBytes: number;
  dbSizePretty: string;
  diskTotalBytes?: number;  // capacity of the FS holding the DB data (gauge max)
  diskUsedBytes?: number;   // whole-disk used (the DB is the dominant chunk)
  tables: TableStat[];      // public tables, biggest first
  generatedAt: number;
};

// Disk capacity of the filesystem holding the DB data, for the "fill" gauge. On
// the box the PG data lives on "/" (md2 NVMe array). Best-effort: degrades to
// null if statfs is unavailable, so the overview never fails on it.
function diskCapacity(path = process.env.DB_DISK_PATH || "/"): { total: number; used: number } | null {
  try {
    const s = statfsSync(path);
    const total = Number(s.bsize) * Number(s.blocks);
    const used = Number(s.bsize) * (Number(s.blocks) - Number(s.bfree));
    return total > 0 ? { total, used } : null;
  } catch {
    return null;
  }
}

// exact match count, guarded by a short per-statement timeout so a heavy ingest
// moment can't wedge the poll. SET LOCAL keeps the timeout off the pooled conn.
async function matchCount(): Promise<number> {
  const c = await explorerPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = 9000");
    const r = await c.query("SELECT count(*)::bigint AS n FROM matches");
    await c.query("COMMIT");
    return Number(r.rows[0].n);
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* noop */ }
    throw e;
  } finally {
    c.release();
  }
}

let _overview: DbOverview | null = null;
let _overviewAt = 0;

export async function getDbOverview(maxAgeMs = 20_000): Promise<DbOverview> {
  const now = Date.now();
  if (_overview && now - _overviewAt < maxAgeMs) return _overview;

  const matches = await matchCount();
  const c = await explorerPool().connect();
  try {
    const size = await c.query(
      `SELECT pg_database_size(current_database()) AS b,
              pg_size_pretty(pg_database_size(current_database())) AS p`
    );
    const tbl = await c.query(
      `SELECT c.relname AS table,
              c.reltuples::bigint AS est_rows,
              pg_total_relation_size(c.oid) AS size_bytes,
              pg_size_pretty(pg_total_relation_size(c.oid)) AS size_pretty
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 14`
    );
    const disk = diskCapacity();
    _overview = {
      matches,
      dbSizeBytes: Number(size.rows[0].b),
      dbSizePretty: size.rows[0].p as string,
      diskTotalBytes: disk?.total,
      diskUsedBytes: disk?.used,
      tables: tbl.rows.map((r: any) => ({
        table: r.table as string,
        estRows: Math.max(0, Number(r.est_rows)),
        sizeBytes: Number(r.size_bytes),
        sizePretty: r.size_pretty as string,
      })),
      generatedAt: now,
    };
    _overviewAt = now;
    return _overview;
  } finally {
    c.release();
  }
}

// ── live ticker (single poll, pub/sub fan-out, ref-counted) ──────────
let _server: Server | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _subs = 0;
let _lastCount = 0;
let _lastAt = 0;

async function tick() {
  if (!_server) return;
  try {
    const matches = await matchCount();
    const now = Date.now();
    let ratePerMin = 0;
    if (_lastAt && matches >= _lastCount) {
      ratePerMin = ((matches - _lastCount) / Math.max(1, now - _lastAt)) * 60_000;
    }
    _lastCount = matches;
    _lastAt = now;
    _server.publish(
      DBSTATS_TOPIC,
      JSON.stringify({ type: "tick", matches, ratePerMin: Math.round(ratePerMin), ts: now })
    );
  } catch (e: any) {
    // transient (timeout under ingest IO) — skip this tick, keep the loop alive
    console.warn("[db-stats] tick skipped:", String(e?.message ?? e).slice(0, 80));
  }
}

export function dbStatsSubscribed(server: Server) {
  _server = server;
  _subs++;
  if (_subs === 1 && !_timer) {
    _lastAt = 0; // reset the rate baseline for a fresh viewing session
    void tick(); // push one immediately so the counter isn't blank
    _timer = setInterval(() => void tick(), 5000);
  }
}

export function dbStatsUnsubscribed() {
  _subs = Math.max(0, _subs - 1);
  if (_subs === 0 && _timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
