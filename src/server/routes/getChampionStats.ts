// src/routes/getChampionStats.ts
import { supabase } from "../supabase/client";

type ChampionStatsBody = {
  championId?: number | string;
  patch?: string | null;
  queueId?: number | null;
  role?: string | null;
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
    // Supporta body vuoto (alcuni client inviano POST senza body)
    const raw = await req.text();
    const body: ChampionStatsBody | null = raw ? (safeJson(raw) as any) : null;

    const championId = body?.championId;
    const patch = body?.patch ?? null;
    const queueId = body?.queueId ?? 420;
    const role = body?.role ?? null;

    if (championId === undefined || championId === null || championId === "") {
      return new Response("Missing championId", { status: 400 });
    }

    const champNum = Number(championId);
    if (!Number.isFinite(champNum) || champNum <= 0) {
      return new Response("Invalid championId", { status: 400 });
    }

    // normalizza role (opzionale)
    const roleNorm = role ? String(role).toUpperCase() : null;

    // cache key
    const cacheKey = `champStats:${champNum}:${patch ?? "any"}:${queueId}:${roleNorm ?? "any"}`;
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
      p_patch: patch,            // assicurati che il tipo in SQL combaci (text / null)
      p_queue_id: queueId ?? 420,
      p_role: roleNorm,          // passa null oppure stringa coerente
    });

    const ms = Date.now() - t0;

    if (error) {
      // LOG COMPLETO (fondamentale su Supabase/PostgREST)
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

      // se vuoi distinguere timeout (spesso code=57014 su postgres query canceled)
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
