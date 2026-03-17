// src/server/routes/getMatches.ts
// Serves matches using match IDs from DB (consistent) + details from Riot API.
// The DB is populated by matchIngest service (triggered by getSummoner).
// Match details are cached in-memory since they never change.

import { supabaseAdmin } from "../supabase/client";
import { getAccountByRiotId, getMatchDetails } from "../riot";

// In-memory LRU cache for match details (match data never changes)
const matchCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 500;

function getCachedMatch(matchId: string): any | null {
  const entry = matchCache.get(matchId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    matchCache.delete(matchId);
    return null;
  }
  return entry.data;
}

function setCachedMatch(matchId: string, data: any) {
  // Evict oldest entries if cache is too large
  if (matchCache.size >= MAX_CACHE_SIZE) {
    const firstKey = matchCache.keys().next().value;
    if (firstKey) matchCache.delete(firstKey);
  }
  matchCache.set(matchId, { data, ts: Date.now() });
}

export async function getMatchesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, tag, region } = body;

    const offset = Math.max(0, Number(body?.offset ?? 0));
    const limitReq = Math.max(1, Number(body?.limit ?? 10));
    const limit = Math.min(20, limitReq);

    if (!name || !tag || !region) {
      console.error("Missing name, tag or region");
      return new Response("Missing name, tag or region", { status: 400 });
    }

    // Resolve puuid — check DB first, fallback to Riot API
    let puuid: string | null = null;

    const { data: userRow } = await supabaseAdmin
      .from("users")
      .select("puuid")
      .eq("name", name)
      .eq("tag", tag)
      .maybeSingle();

    if (userRow?.puuid) {
      puuid = userRow.puuid;
    } else {
      try {
        const account = await getAccountByRiotId(name, tag, region);
        puuid = account.puuid;
      } catch {
        return new Response("Player not found", { status: 404 });
      }
    }

    // Get match IDs for this player from DB (consistent source of truth)
    // Join with matches table to filter ranked + order by game_creation
    const { data: matchRows, error: mErr } = await supabaseAdmin
      .from("participants")
      .select("match_id, champion_name, win, matches!inner(game_creation, queue_id)")
      .eq("puuid", puuid)
      .in("matches.queue_id", [420, 440])
      .order("matches(game_creation)", { ascending: false });

    if (mErr) {
      console.error("❌ Error querying matches from DB:", mErr);
      // Fallback: DB join failed, try flat query
      return await fallbackGetMatches(puuid, region, offset, limit);
    }

    if (!matchRows || matchRows.length === 0) {
      // No matches in DB — ingestion hasn't completed yet
      return Response.json({
        matches: [],
        topChampions: [],
        seasonTotals: null,
        hasMore: false,
        nextOffset: 0,
        ingesting: true,
      });
    }

    // Paginate
    const paged = matchRows.slice(offset, offset + limit);
    const hasMore = offset + limit < matchRows.length;
    const nextOffset = offset + paged.length;

    if (paged.length === 0) {
      return Response.json({
        matches: [],
        topChampions: [],
        seasonTotals: null,
        hasMore: false,
        nextOffset: offset,
        ingesting: false,
      });
    }

    // Fetch match details in parallel (with caching)
    const matchesWithWin: any[] = await Promise.all(
      paged.map(async (row) => {
        try {
          let match = getCachedMatch(row.match_id);
          if (!match) {
            match = await getMatchDetails(row.match_id, region);

            // Normalize gameEndTimestamp
            const startTs =
              match.info.gameStartTimestamp ?? match.info.gameCreation;
            if (startTs && match.info.gameDuration) {
              match.info.gameEndTimestamp =
                startTs + match.info.gameDuration * 1000;
            }

            setCachedMatch(row.match_id, match);
          }

          return {
            match,
            win: !!row.win,
            championName: row.champion_name ?? "Unknown",
          };
        } catch (err) {
          console.error("❌ Error fetching match detail:", row.match_id, err);
          return null;
        }
      })
    ).then(results => results.filter(Boolean));

    return Response.json({
      matches: matchesWithWin,
      topChampions: [],
      seasonTotals: null,
      hasMore,
      nextOffset,
      ingesting: false,
    });
  } catch (err) {
    console.error("❌ Error in getMatches:", err);
    return new Response("Internal server error", { status: 500 });
  }
}

/**
 * Fallback: if the Supabase join query fails (e.g. no foreign key),
 * do a simpler two-step query.
 */
async function fallbackGetMatches(
  puuid: string,
  region: string,
  offset: number,
  limit: number
): Promise<Response> {
  // Step 1: Get match IDs from participants
  const { data: pRows } = await supabaseAdmin
    .from("participants")
    .select("match_id, champion_name, win")
    .eq("puuid", puuid);

  if (!pRows || pRows.length === 0) {
    return Response.json({
      matches: [],
      topChampions: [],
      seasonTotals: null,
      hasMore: false,
      nextOffset: 0,
      ingesting: true,
    });
  }

  const allIds = pRows.map((r) => r.match_id);
  const pLookup = new Map(pRows.map((r) => [r.match_id, r]));

  // Step 2: Get match metadata for filtering + ordering
  const { data: matchMeta } = await supabaseAdmin
    .from("matches")
    .select("match_id, queue_id, game_creation")
    .in("match_id", allIds)
    .in("queue_id", [420, 440])
    .order("game_creation", { ascending: false });

  if (!matchMeta || matchMeta.length === 0) {
    return Response.json({
      matches: [],
      topChampions: [],
      seasonTotals: null,
      hasMore: false,
      nextOffset: 0,
      ingesting: false,
    });
  }

  const paged = matchMeta.slice(offset, offset + limit);
  const hasMore = offset + limit < matchMeta.length;
  const nextOffset = offset + paged.length;

  const matchesWithWin: any[] = await Promise.all(
    paged.map(async (m) => {
      try {
        let match = getCachedMatch(m.match_id);
        if (!match) {
          match = await getMatchDetails(m.match_id, region);
          const startTs =
            match.info.gameStartTimestamp ?? match.info.gameCreation;
          if (startTs && match.info.gameDuration) {
            match.info.gameEndTimestamp =
              startTs + match.info.gameDuration * 1000;
          }
          setCachedMatch(m.match_id, match);
        }

        const pRow = pLookup.get(m.match_id);
        return {
          match,
          win: !!pRow?.win,
          championName: pRow?.champion_name ?? "Unknown",
        };
      } catch (err) {
        console.error("❌ Error fetching match detail:", m.match_id, err);
        return null;
      }
    })
  ).then(results => results.filter(Boolean));

  return Response.json({
    matches: matchesWithWin,
    topChampions: [],
    seasonTotals: null,
    hasMore,
    nextOffset,
    ingesting: false,
  });
}
