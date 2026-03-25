// src/server/routes/getMatches.ts
// Always fetches match IDs from Riot (fast, 1 call) so the latest game shows.
// Match details are fetched in parallel batches from Riot (with in-memory cache).
// DB ingestion runs purely in the background — never blocks the response.

import { supabaseAdmin } from "../supabase/client";
import { getAccountByRiotId, getMatchDetails, getMatchIdsByPuuidOpts, RateLimitError } from "../riot";
import { ingestQuickThenBackground } from "../services/matchIngest";
import { getCurrentSeasonWindow } from "../season";

// ── In-memory caches ──

const matchCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

const puuidCache = new Map<string, { puuid: string; ts: number }>();
const PUUID_CACHE_TTL = 5 * 60 * 1000;

// Cache the full response JSON to avoid hammering Riot on rapid frontend polls
const responseCache = new Map<string, { json: any; ts: number }>();
const RESP_CACHE_TTL = 4_000; // 4s — frontend polls every 3s

function getCachedMatch(id: string) {
  const e = matchCache.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { matchCache.delete(id); return null; }
  return e.data;
}
function setCachedMatch(id: string, d: any) {
  if (matchCache.size >= MAX_CACHE_SIZE) {
    const k = matchCache.keys().next().value;
    if (k) matchCache.delete(k);
  }
  matchCache.set(id, { data: d, ts: Date.now() });
}

async function resolvePuuid(name: string, tag: string, region: string): Promise<string | null> {
  const key = `${name.toLowerCase()}#${tag.toLowerCase()}`;
  const c = puuidCache.get(key);
  if (c && Date.now() - c.ts < PUUID_CACHE_TTL) return c.puuid;

  try {
    const acc = await getAccountByRiotId(name, tag, region);
    puuidCache.set(key, { puuid: acc.puuid, ts: Date.now() });
    return acc.puuid;
  } catch {
    const { data } = await supabaseAdmin.from("users").select("puuid").eq("name", name).eq("tag", tag).maybeSingle();
    if (data?.puuid) { puuidCache.set(key, { puuid: data.puuid, ts: Date.now() }); return data.puuid; }
    return null;
  }
}

/** Fetch a single match with rate-limit retry. */
async function fetchMatchWithRetry(matchId: string, region: string, retries = 2): Promise<any> {
  const cached = getCachedMatch(matchId);
  if (cached) return cached;

  for (let i = 0; i <= retries; i++) {
    try {
      const match = await getMatchDetails(matchId, region);
      const st = match.info.gameStartTimestamp ?? match.info.gameCreation;
      if (st && match.info.gameDuration) {
        match.info.gameEndTimestamp = st + match.info.gameDuration * 1000;
      }
      setCachedMatch(matchId, match);
      return match;
    } catch (err) {
      if (err instanceof RateLimitError && i < retries) {
        await new Promise(r => setTimeout(r, err.retryAfterMs ?? 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Fetch match details for multiple IDs in parallel batches.
 * Uses in-memory cache to skip already-fetched matches.
 * Batches of BATCH_SIZE to stay under Riot rate limits.
 */
const BATCH_SIZE = 5;

async function fetchMatchDetailsBatched(
  matchIds: string[],
  puuid: string,
  region: string
): Promise<any[]> {
  const results: any[] = [];

  for (let i = 0; i < matchIds.length; i += BATCH_SIZE) {
    const batch = matchIds.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async (matchId) => {
        const match = await fetchMatchWithRetry(matchId, region);
        const me = match.info.participants.find((p: any) => p.puuid === puuid);
        return {
          match,
          win: !!me?.win,
          championName: me?.championName ?? "Unknown",
        };
      })
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
      else console.error("❌ Match detail error:", r.reason?.message ?? r.reason);
    }
  }

  return results;
}

// ── Handler ──

export async function getMatchesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, tag, region } = body;
    const offset = Math.max(0, Number(body?.offset ?? 0));
    const limit = Math.min(20, Math.max(1, Number(body?.limit ?? 10)));

    if (!name || !tag || !region) return new Response("Missing params", { status: 400 });

    const puuid = await resolvePuuid(name, tag, region);
    if (!puuid) return new Response("Player not found", { status: 404 });

    // ── Response cache (prevents hammering on rapid polls) ──
    const rcKey = `${puuid}:${offset}:${limit}`;
    const rc = responseCache.get(rcKey);
    if (rc && Date.now() - rc.ts < RESP_CACHE_TTL) {
      return Response.json(rc.json);
    }

    // ── Always fetch match IDs from Riot (1 fast call, ~200ms) ──
    const { startTime, endTime } = getCurrentSeasonWindow();
    let matchIds: string[];
    try {
      matchIds = await getMatchIdsByPuuidOpts(puuid, region, {
        start: 0,
        count: 100, // always fetch all ranked match IDs for the season
        type: "ranked",
        startTime,
        endTime,
      });
    } catch (err) {
      console.error("❌ Riot match IDs fetch failed:", err);
      // Fallback: try DB if Riot is down
      const dbResult = await fetchFromDB(puuid, region, offset, limit);
      if (dbResult) return Response.json(dbResult);
      return Response.json({ matches: [], topChampions: [], seasonTotals: null, hasMore: false, nextOffset: 0, ingesting: false });
    }

    if (!matchIds || matchIds.length === 0) {
      return Response.json({ matches: [], topChampions: [], seasonTotals: null, hasMore: false, nextOffset: 0, ingesting: false });
    }

    // Paginate
    const paged = matchIds.slice(offset, offset + limit);
    const hasMore = offset + limit < matchIds.length;

    // ── Fetch match details in parallel batches (cached ones are instant) ──
    const matches = await fetchMatchDetailsBatched(paged, puuid, region);

    // Fire background ingestion (populates DB for season stats etc)
    ingestQuickThenBackground(puuid, region).catch(e =>
      console.error("⚠️ Background ingestion error:", e)
    );

    const result = {
      matches,
      topChampions: [],
      seasonTotals: null,
      hasMore,
      nextOffset: offset + paged.length,
      ingesting: false,
    };

    responseCache.set(rcKey, { json: result, ts: Date.now() });
    return Response.json(result);

  } catch (err) {
    console.error("❌ getMatches error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}

// ── DB fallback (only used when Riot API is down) ──

async function fetchFromDB(
  puuid: string, region: string, offset: number, limit: number
): Promise<any | null> {
  try {
    const { data: pRows } = await supabaseAdmin
      .from("participants")
      .select("match_id, champion_name, win")
      .eq("puuid", puuid)
      .limit(200);

    if (!pRows || pRows.length === 0) return null;

    const matchIds = pRows.map(r => r.match_id);
    const pLookup = new Map(pRows.map(r => [r.match_id, r]));

    const { data: meta } = await supabaseAdmin
      .from("matches")
      .select("match_id, queue_id, game_creation")
      .in("match_id", matchIds)
      .in("queue_id", [420, 440])
      .order("game_creation", { ascending: false });

    if (!meta || meta.length === 0) return null;

    const paged = meta.slice(offset, offset + limit);
    const hasMore = offset + limit < meta.length;

    const matches: any[] = [];
    for (const m of paged) {
      try {
        const match = await fetchMatchWithRetry(m.match_id, region);
        const p = pLookup.get(m.match_id);
        matches.push({ match, win: !!p?.win, championName: p?.champion_name ?? "Unknown" });
      } catch { /* skip */ }
    }

    return { matches, topChampions: [], seasonTotals: null, hasMore, nextOffset: offset + paged.length, ingesting: false };
  } catch {
    return null;
  }
}
