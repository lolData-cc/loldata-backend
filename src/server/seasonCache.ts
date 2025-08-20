// src/server/dbSeasonCache.ts
import { supabase } from "../server/supabase/client";

export type SeasonStatsPayload = {
  topChampions: any[];
  seasonTotals: { games: number; wins: number };
  computedAt: number; // epoch ms
};

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minuti

export function buildCacheKey(puuid: string, startEpoch: number, queueGroup: string) {
  return `${puuid}:${startEpoch}:${queueGroup}`;
}

export async function readSeasonCache(cacheKey: string): Promise<SeasonStatsPayload | null> {
  const { startTime, endTime } = getCurrentSeasonWindow();

  const start_epoch = Number.isFinite(startTime as number) ? Math.floor(startTime as number) : null;
// se la colonna è NOT NULL, scegli un default coerente (es. 0, o ‘inizio stagione noto’)
const safe_start_epoch = start_epoch ?? 0; // <-- evita NULL

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

  const expired = new Date(data.expires_at).getTime() < Date.now();
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

export async function writeSeasonCache(
  puuid: string,
  startEpoch: number,
  queueGroup: string,
  payload: SeasonStatsPayload,
  ttlMs = DEFAULT_TTL_MS
) {
  const cacheKey = buildCacheKey(puuid, startEpoch, queueGroup);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const row = {
    cache_key: cacheKey,
    payload,
    computed_at: new Date(payload.computedAt).toISOString(),
    expires_at: expiresAt,
    puuid,
    start_epoch: startEpoch,
    queue_group: queueGroup
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
