// src/routes/getChampionStats.ts
import { supabase } from "../supabase/client";
type ChampionStatsBody = {
  championId?: number | string;
  patch?: string | null;
  queueId?: number | null;
  role?: string | null;
  tier?: string | null;
  opponents?: { championId: number; role?: string | null; itemId?: number | null }[] | null;
};
const CACHE_TTL_MS = Number(process.env.CHAMP_STATS_CACHE_TTL_MS ?? "60000"); // 60s
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
export async function getChampionStatsHandler(req: Request): Promise<Response> {
  const requestId =
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    crypto.randomUUID();
  try {
    const raw = await req.text();
    const body: ChampionStatsBody | null = raw ? (safeJson(raw) as any) : null;
    const championId = body?.championId;
    const patch = body?.patch ?? null;
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
    const cacheKey = `champStats:${champNum}:${patch ?? "any"}:${queueId}:${roleNorm ?? "any"}:${tier ?? "any"}:${JSON.stringify(opponents ?? [])}`;
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
    const { data, error } = await supabase.rpc("get_champion_stats", {
      p_champion_id: champNum,
      p_patch: patch,
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
