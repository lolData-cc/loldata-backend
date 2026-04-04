// src/routes/getChampionStats.ts
import { supabaseAdmin } from "../supabase/client";
type ChampionStatsBody = {
  championId?: number | string;
  patch?: string | null;
  region?: string | null;
  queueId?: number | null;
  role?: string | null;
  tier?: string | null;
  opponents?: { championId: number; role?: string | null; itemId?: number | null }[] | null;
};
const CACHE_TTL_MS = Number(process.env.CHAMP_STATS_CACHE_TTL_MS ?? "300000"); // 5 min
const _cache = new Map<string, { exp: number; value: unknown }>();
function cacheGet(key: string) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key: string, value: unknown) {
  _cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
}
function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── resolve latest patch from DB (cached) ──────────────────
let _latestPatch: { value: string; exp: number } | null = null;
async function getLatestPatch(): Promise<string | null> {
  if (_latestPatch && Date.now() < _latestPatch.exp) return _latestPatch.value;
  const { data } = await supabaseAdmin
    .from("matches")
    .select("game_version")
    .order("game_creation", { ascending: false })
    .limit(1)
    .single();
  if (data?.game_version) {
    // "15.13.548.9786" → "15.13"
    const short = String(data.game_version).split(".").slice(0, 2).join(".");
    // cache for 10 min — patch doesn't change often
    _latestPatch = { value: short, exp: Date.now() + 600_000 };
    return short;
  }
  return null;
}
export async function getChampionStatsHandler(req: Request): Promise<Response> {
  const requestId =
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    crypto.randomUUID();
  try {
    const raw = await req.text();
    const body: ChampionStatsBody | null = raw ? (safeJson(raw) as any) : null;
    const championId = body?.championId;
    const rawPatch = body?.patch ?? null;
    const patch = rawPatch || null; // null = use materialized views (fast path)
    const region = body?.region ?? null;
    const queueId = body?.queueId ?? 420;
    const role = body?.role ?? null;
    const tier = body?.tier ?? null;
    const opponents = body?.opponents?.length ? body.opponents : null;
    if (championId === undefined || championId === null || championId === "") {
      return new Response("Missing championId", { status: 400 });
    }
    const champNum = Number(championId);
    if (!Number.isFinite(champNum) || champNum <= 0) {
      return new Response("Invalid championId", { status: 400 });
    }
    const roleNorm = role ? String(role).toUpperCase() : null;
    const cacheKey = `champStats:${champNum}:${patch ?? "any"}:${region ?? "all"}:${queueId}:${roleNorm ?? "any"}:${tier ?? "any"}:${JSON.stringify(opponents ?? [])}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return Response.json(cached, {
        headers: {
          "x-cache": "HIT",
          "x-request-id": requestId,
        },
      });
    }
    const t0 = Date.now();

    // Fast path: serve from daily snapshot when no opponents/region/patch filters
    // Only use snapshots when a specific role is selected (not "all roles")
    if (!opponents && !region && !patch && roleNorm) {
      let snapQuery = supabaseAdmin
        .from("champion_stats_snapshots")
        .select("data")
        .eq("champion_id", champNum)
        .eq("role", roleNorm)
        .order("snapshot_date", { ascending: false })
        .limit(1);

      if (tier) {
        snapQuery = snapQuery.eq("tier", tier);
      } else {
        snapQuery = snapQuery.is("tier", null);
      }

      const { data: snap } = await snapQuery.maybeSingle();
      if (snap?.data) {
        const ms = Date.now() - t0;
        console.log(`✅ champion stats from snapshot (${ms}ms)`, { champNum, roleNorm, tier: tier ?? "ALL" });
        cacheSet(cacheKey, snap.data);
        return Response.json(snap.data, {
          headers: {
            "x-cache": "SNAPSHOT",
            "x-request-id": requestId,
            "server-timing": `db;dur=${ms}`,
          },
        });
      }
    }

    // Slow path: compute live from RPC
    const { data, error } = await supabaseAdmin.rpc("get_champion_stats", {
      p_champion_id: champNum,
      p_patch: patch,
      p_region: region,
      p_queue_id: queueId ?? 420,
      p_role: roleNorm,
      p_tier: tier,
      p_opponents: opponents ?? null,
    });
    const ms = Date.now() - t0;
    if (error) {
      console.error("❌ get_champion_stats rpc error", {
        requestId,
        message: error.message,
        details: (error as any).details,
        hint: (error as any).hint,
        code: (error as any).code,
        ms,
        champNum,
        patch,
        queueId,
        role: roleNorm,
      });
      return new Response("Failed to load champion stats", {
        status: 500,
        headers: { "x-request-id": requestId },
      });
    }
    cacheSet(cacheKey, data);
    return Response.json(data, {
      headers: {
        "x-cache": "MISS",
        "x-request-id": requestId,
        "server-timing": `db;dur=${ms}`,
      },
    });
  } catch (err: any) {
    console.error("Errore in getChampionStatsHandler:", {
      requestId,
      message: err?.message,
      stack: err?.stack,
    });
    return new Response("Errore interno", {
      status: 500,
      headers: { "x-request-id": requestId },
    });
  }
}

// ── GET available patches ──────────────────────────────────
let _patchesCache: { value: string[]; exp: number } | null = null;
export async function getAvailablePatchesHandler(_req: Request): Promise<Response> {
  if (_patchesCache && Date.now() < _patchesCache.exp) {
    return Response.json({ patches: _patchesCache.value });
  }
  const { data, error } = await supabaseAdmin
    .from("matches")
    .select("game_version")
    .order("game_creation", { ascending: false })
    .limit(500);
  if (error || !data) {
    return Response.json({ patches: [] });
  }
  // dedupe & shorten: "15.13.548.9786" → "15.13"
  const seen = new Set<string>();
  const patches: string[] = [];
  for (const row of data) {
    const short = String(row.game_version ?? "").split(".").slice(0, 2).join(".");
    if (short && !seen.has(short)) {
      seen.add(short);
      patches.push(short);
    }
  }
  // cache 10 min
  _patchesCache = { value: patches, exp: Date.now() + 600_000 };
  return Response.json({ patches });
}
