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

// ── Snapshot preload cache ──────────────────────────────────
// Key: "champId:role:tier" → snapshot data
const _snapCache = new Map<string, any>();
let _snapLoaded = false;

function snapKey(champId: number, role: string, tier: string | null) {
  return `${champId}:${role}:${tier ?? "ALL"}`;
}

export function getSnap(champId: number, role: string, tier: string | null) {
  return _snapCache.get(snapKey(champId, role, tier)) ?? null;
}

function getChampRoles(champId: number): { role: string; games: number }[] {
  const roles: { role: string; games: number }[] = [];
  for (const [key, data] of _snapCache.entries()) {
    if (key.startsWith(`${champId}:`) && key.endsWith(":ALL")) {
      const role = key.split(":")[1];
      roles.push({ role, games: data?.core?.gamesAnalyzed ?? 0 });
    }
  }
  return roles.sort((a, b) => b.games - a.games);
}

export async function preloadSnapshots() {
  console.log("⏳ Preloading champion snapshots...");
  const t0 = Date.now();

  // Fetch in pages to avoid timeout
  const PAGE = 200;
  let offset = 0;
  let total = 0;
  const seen = new Set<string>();

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("champion_stats_snapshots")
      .select("champion_id, role, tier, data, snapshot_date")
      .order("snapshot_date", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error(`❌ Snapshot preload failed at offset ${offset}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      const k = snapKey(row.champion_id, row.role, row.tier);
      if (seen.has(k)) continue;
      seen.add(k);
      _snapCache.set(k, row.data);
    }

    total += data.length;
    offset += PAGE;
    if (data.length < PAGE) break;
  }

  _snapLoaded = true;
  console.log(`✅ Preloaded ${_snapCache.size} snapshots (${total} rows) in ${Date.now() - t0}ms`);
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

    // Fast path: serve from preloaded snapshot cache
    if (!opponents && !region && !patch && _snapLoaded) {
      let effectiveRole = roleNorm;
      if (!effectiveRole) {
        const roles = getChampRoles(champNum);
        if (roles.length) effectiveRole = roles[0].role;
      }

      if (effectiveRole) {
        const snapData = getSnap(champNum, effectiveRole, tier ?? null);
        if (snapData) {
          const ms = Date.now() - t0;
          console.log(`✅ champion stats from snapshot (${ms}ms)`, { champNum, roleNorm: effectiveRole, tier: tier ?? "ALL" });
          cacheSet(cacheKey, snapData);
          return Response.json(snapData, {
            headers: {
              "x-cache": "SNAPSHOT",
              "x-request-id": requestId,
              "server-timing": `db;dur=${ms}`,
            },
          });
        }
      }
    }

    // Fast path for single opponent: use champion_vs_stats (uses mv_lane_opponents, ~50-200ms)
    if (opponents?.length === 1 && roleNorm) {
      const oppId = opponents[0].championId;
      console.log(`⚡ Fast VS query: ${champNum} vs ${oppId}, role=${roleNorm}, tier=${tier}`);
      const { data: vsData, error: vsErr } = await supabaseAdmin.rpc("champion_vs_stats", {
        p_champion_id: champNum,
        p_opponent_id: oppId,
        p_role: roleNorm,
        p_tier: tier ?? null,
      });
      if (!vsErr && vsData) {
        const ms = Date.now() - t0;
        console.log(`✅ VS stats in ${ms}ms`);
        cacheSet(cacheKey, vsData);
        return Response.json(vsData, {
          headers: {
            "x-cache": "VS_FAST",
            "x-request-id": requestId,
            "server-timing": `db;dur=${ms}`,
          },
        });
      }
    }

    // Slow path: compute live from get_champion_stats_full (fallback)
    console.log(`⏳ Live query for champion ${champNum}, role=${roleNorm}, tier=${tier}, opponents=${JSON.stringify(opponents)}`);
    const { data, error } = await supabaseAdmin.rpc("get_champion_stats_full", {
      p_champion_id: champNum,
      p_role: roleNorm,
      p_tier: tier,
      p_queue_id: queueId ?? 420,
      p_opponents: opponents ?? null,
    });
    const ms = Date.now() - t0;
    if (error) {
      console.error("❌ get_champion_stats_full rpc error", {
        requestId,
        message: error.message,
        details: (error as any).details,
        hint: (error as any).hint,
        code: (error as any).code,
        ms,
        champNum,
        roleNorm,
        tier,
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
