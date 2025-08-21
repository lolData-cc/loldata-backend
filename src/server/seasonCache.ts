// src/server/dbSeasonCache.ts
import { supabase } from "../server/supabase/client";

export type SeasonStatsPayload = {
  topChampions: any[];
  seasonTotals: { games: number; wins: number };
  computedAt: number; // epoch ms
};

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function buildCacheKey(puuid: string, startEpoch: number, queueGroup: string) {
  return `${puuid}:${startEpoch}:${queueGroup}`;
}

function parseCacheKey(cacheKey: string) {
  const [puuid, startEpochStr, queueGroup] = cacheKey.split(":");
  const startEpoch = Number(startEpochStr);
  if (!puuid || !queueGroup || !Number.isFinite(startEpoch)) {
    throw new Error(`[seasonCache] Invalid cacheKey: ${cacheKey}`);
  }
  return { puuid, startEpoch: Math.floor(startEpoch), queueGroup };
}

export async function readSeasonCache(cacheKey: string): Promise<SeasonStatsPayload | null> {
  const { data, error } = await supabase
    .from("season_stats_cache")
    .select("payload, expires_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error) {
    console.error("[seasonCache] read error:", error.message);
    return null;
  }
  if (!data) return null;

  const expired = new Date(data.expires_at).getTime() <= Date.now();
  if (expired) return null;

  return data.payload as SeasonStatsPayload;
}

export async function readStaleSeasonCache(cacheKey: string): Promise<SeasonStatsPayload | null> {
  const { data, error } = await supabase
    .from("season_stats_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error) {
    console.error("[seasonCache] readStale error:", error.message);
    return null;
  }
  return data ? (data.payload as SeasonStatsPayload) : null;
}

/**
 * Nuova firma: passa SOLO cacheKey (string), noi estraiamo puuid/startEpoch/queueGroup.
 * Evita NULL su start_epoch e inconsistenze.
 */
export async function writeSeasonCache(
  cacheKey: string,
  payload: SeasonStatsPayload,
  ttlMs = DEFAULT_TTL_MS
) {
  const { puuid, startEpoch, queueGroup } = parseCacheKey(cacheKey);

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const row = {
    cache_key: cacheKey,
    payload,
    computed_at: new Date(payload.computedAt).toISOString(),
    expires_at: expiresAt,
    puuid,
    start_epoch: startEpoch,        // <- mai NULL
    queue_group: queueGroup,
  };

  const { error } = await supabase
    .from("season_stats_cache")
    .upsert(row, { onConflict: "cache_key" });

  if (error) {
    console.error("[seasonCache] write error:", error.message);
  }
}

export async function purgeExpiredSeasonCache() {
  const { error } = await supabase
    .from("season_stats_cache")
    .delete()
    .lt("expires_at", new Date().toISOString());

  if (error) {
    console.error("[seasonCache] purge error:", error.message);
  }
}
