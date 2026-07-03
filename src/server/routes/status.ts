// src/server/routes/status.ts
//
// Public system status for the /status page.
//
//   GET /api/status          → live checks (20s in-process cache)
//   GET /api/status/history  → 24h uptime buckets per service (from the
//                              status_history table, swept every 60s)
//
// Checks run SERVER-side from the box, each with its own timeout so one
// slow dependency can't hang the endpoint:
//   database  — pg SELECT 1 latency + matches size (reltuples) + ingest lag
//   cdn       — cdn2.loldata.cc version marker
//   auth      — Supabase Cloud reachability
//   riot:*    — Riot lol-status-v4 per platform (third-party: listed but
//               EXCLUDED from the overall state — Riot being down is not
//               a loldata outage)
// The API service itself is implicit: if this endpoint answers, it's up.

import { explorerPool } from "../explorer/pool";
import { supabaseAdmin } from "../supabase/client";

const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const CDN_MARKER = "https://cdn2.loldata.cc/_current_version.txt";
const RIOT_PLATFORMS: Record<string, string> = { EUW: "euw1", NA: "na1", KR: "kr" };

// state: 2 = operational, 1 = degraded, 0 = down (numeric so history rows sort)
export type ServiceState = 2 | 1 | 0;
type ServiceCheck = {
  id: string;
  label: string;
  state: ServiceState;
  latencyMs: number | null;
  detail: string | null;
  thirdParty?: boolean;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// ── individual checks ────────────────────────────────────────────────────────

async function checkDatabase(): Promise<ServiceCheck> {
  const t0 = Date.now();
  try {
    await withTimeout(explorerPool().query("SELECT 1"), 4000);
    const latencyMs = Date.now() - t0;
    let detail: string | null = null;
    let state: ServiceState = 2;
    try {
      // freshness probe is best-effort: its failure degrades detail, not the DB
      const { rows } = await withTimeout(
        explorerPool().query(
          `SELECT (SELECT reltuples::bigint FROM pg_class WHERE relname = 'matches') AS matches,
                  (SELECT game_creation FROM matches ORDER BY match_id DESC LIMIT 1) AS last_game`
        ) as Promise<{ rows: any[] }>,
        6000
      );
      const matches = Number(rows[0]?.matches ?? 0);
      const lastGame = Number(rows[0]?.last_game ?? 0);
      if (lastGame > 0) {
        const lagMin = Math.max(0, Math.round((Date.now() - lastGame) / 60_000));
        detail = `${(matches / 1e6).toFixed(2)}M matches · last ingested ${lagMin}m ago`;
        // the ingest normally lands games within minutes; >3h = stalled
        if (lagMin > 180) state = 1;
      } else {
        detail = `${(matches / 1e6).toFixed(2)}M matches`;
      }
    } catch {
      detail = "freshness probe timed out";
      state = 1;
    }
    return { id: "database", label: "Match Database", state, latencyMs, detail };
  } catch {
    return { id: "database", label: "Match Database", state: 0, latencyMs: null, detail: "unreachable" };
  }
}

async function checkCdn(): Promise<ServiceCheck> {
  const t0 = Date.now();
  try {
    const res = await withTimeout(fetch(CDN_MARKER, { headers: { "cache-control": "no-cache" } }), 5000);
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { id: "cdn", label: "Asset CDN", state: 0, latencyMs, detail: `HTTP ${res.status}` };
    const version = (await res.text()).trim();
    return {
      id: "cdn",
      label: "Asset CDN",
      state: latencyMs > 2500 ? 1 : 2,
      latencyMs,
      detail: `serving patch ${version}`,
    };
  } catch {
    return { id: "cdn", label: "Asset CDN", state: 0, latencyMs: null, detail: "unreachable" };
  }
}

async function checkAuth(): Promise<ServiceCheck> {
  const t0 = Date.now();
  try {
    const { error } = await withTimeout(
      supabaseAdmin.from("streamers").select("id").limit(1) as unknown as Promise<{ error: unknown }>,
      5000
    );
    const latencyMs = Date.now() - t0;
    if (error) return { id: "auth", label: "Accounts & Auth", state: 1, latencyMs, detail: "responding with errors" };
    return { id: "auth", label: "Accounts & Auth", state: 2, latencyMs, detail: "Supabase Cloud" };
  } catch {
    return { id: "auth", label: "Accounts & Auth", state: 0, latencyMs: null, detail: "unreachable" };
  }
}

// Riot's own platform status — cached longer (their data barely moves and we
// don't want to spend rate limit on a public page).
let _riotCache: { ts: number; checks: ServiceCheck[] } | null = null;
const RIOT_TTL = 120_000;

async function checkRiot(): Promise<ServiceCheck[]> {
  if (_riotCache && Date.now() - _riotCache.ts < RIOT_TTL) return _riotCache.checks;
  const checks = await Promise.all(
    Object.entries(RIOT_PLATFORMS).map(async ([region, platform]): Promise<ServiceCheck> => {
      const id = `riot-${region.toLowerCase()}`;
      const label = `Riot API · ${region}`;
      const t0 = Date.now();
      try {
        const res = await withTimeout(
          fetch(`https://${platform}.api.riotgames.com/lol/status/v4/platform-data`, {
            headers: { "X-Riot-Token": RIOT_API_KEY },
          }),
          5000
        );
        const latencyMs = Date.now() - t0;
        if (!res.ok) return { id, label, state: 0, latencyMs, detail: `HTTP ${res.status}`, thirdParty: true };
        const data = (await res.json()) as { maintenances?: unknown[]; incidents?: unknown[] };
        const maint = data.maintenances?.length ?? 0;
        const inc = data.incidents?.length ?? 0;
        return {
          id,
          label,
          state: inc > 0 ? 1 : maint > 0 ? 1 : 2,
          latencyMs,
          detail:
            inc > 0
              ? `${inc} active incident${inc > 1 ? "s" : ""}`
              : maint > 0
                ? `${maint} maintenance window${maint > 1 ? "s" : ""}`
                : "no incidents",
          thirdParty: true,
        };
      } catch {
        return { id, label, state: 0, latencyMs: null, detail: "unreachable", thirdParty: true };
      }
    })
  );
  _riotCache = { ts: Date.now(), checks };
  return checks;
}

// ── aggregate (cached 20s — the sweep and the public page share it) ──────────

type StatusPayload = {
  overall: ServiceState;
  services: ServiceCheck[];
  checkedAt: string;
  uptimeSince: string;
};
let _cache: { ts: number; payload: StatusPayload } | null = null;
const TTL = 20_000;
const bootedAt = new Date().toISOString();

async function computeStatus(): Promise<StatusPayload> {
  if (_cache && Date.now() - _cache.ts < TTL) return _cache.payload;
  const [db, cdn, auth, riot] = await Promise.all([checkDatabase(), checkCdn(), checkAuth(), checkRiot()]);
  const api: ServiceCheck = { id: "api", label: "API Core", state: 2, latencyMs: 0, detail: "api2.loldata.cc" };
  const own = [api, db, cdn, auth];
  const overall = own.reduce<ServiceState>((worst, s) => (s.state < worst ? s.state : worst), 2);
  const payload: StatusPayload = {
    overall,
    services: [...own, ...riot],
    checkedAt: new Date().toISOString(),
    uptimeSince: bootedAt,
  };
  _cache = { ts: Date.now(), payload };
  return payload;
}

export async function statusHandler(_req: Request): Promise<Response> {
  try {
    const payload = await computeStatus();
    return Response.json(payload, { headers: { "Cache-Control": "public, max-age=15" } });
  } catch (e: any) {
    console.error("[status] error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}

// ── history: 24h buckets per service ─────────────────────────────────────────

export async function statusHistoryHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours")) || 24));
    const bucketMin = hours <= 24 ? 30 : 120; // 48 buckets for 24h
    const { rows } = await explorerPool().query(
      `SELECT service,
              to_char(date_bin($2 * interval '1 minute', at, 'epoch'::timestamptz), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
              min(state)::int AS worst,
              round(avg(latency_ms))::int AS avg_latency
         FROM status_history
        WHERE at > now() - $1 * interval '1 hour'
        GROUP BY service, bucket
        ORDER BY service, bucket`,
      [hours, bucketMin]
    );
    const byService: Record<string, { bucket: string; worst: number; avgLatency: number | null }[]> = {};
    for (const r of rows as any[]) {
      (byService[r.service] ??= []).push({ bucket: r.bucket, worst: r.worst, avgLatency: r.avg_latency });
    }
    // uptime % over the window: operational=1, degraded=0.5, down=0
    const uptime: Record<string, number> = {};
    for (const [svc, buckets] of Object.entries(byService)) {
      const score = buckets.reduce((a, b) => a + (b.worst === 2 ? 1 : b.worst === 1 ? 0.5 : 0), 0);
      uptime[svc] = Math.round((score / buckets.length) * 1000) / 10;
    }
    return Response.json(
      { hours, bucketMinutes: bucketMin, services: byService, uptimePct: uptime },
      { headers: { "Cache-Control": "public, max-age=60" } }
    );
  } catch (e: any) {
    console.error("[status] history error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}

// ── sweep: record one row per service every 60s (+ prune every ~6h) ─────────

let _sweepStarted = false;
export function startStatusSweep() {
  if (_sweepStarted) return;
  _sweepStarted = true;
  let tick = 0;
  const run = async () => {
    try {
      _cache = null; // the sweep always measures fresh
      const { services } = await computeStatus();
      for (const s of services) {
        await explorerPool().query(
          `INSERT INTO status_history (service, state, latency_ms) VALUES ($1, $2, $3)`,
          [s.id, s.state, s.latencyMs]
        );
      }
      if (++tick % 360 === 0) {
        await explorerPool().query(`DELETE FROM status_history WHERE at < now() - interval '92 days'`);
      }
    } catch (e: any) {
      console.error("[status] sweep error:", e?.message ?? e);
    }
  };
  setInterval(run, 60_000);
  // first sample shortly after boot so the page isn't empty
  setTimeout(run, 5_000);
  console.log("⏱️ status sweep started (60s)");
}
