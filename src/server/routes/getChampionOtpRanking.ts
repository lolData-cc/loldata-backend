// src/server/routes/getChampionOtpRanking.ts
//
// Top OTP (one-trick) players for a champion, restricted to the global Master+
// ladder. Unlike the old implementation (which leaned on the Cloud `users` table
// — only logged-in loldata users — and a PostgREST query silently capped at 1000
// rows), this runs a single SQL aggregation on the box against:
//   • participants   — every crawled ranked game (per-champ + per-player totals)
//   • players         — the box's crawled rank ladder (tier/division/lp/name/icon)
//
// An OTP = a Master/GM/Challenger player with >= MIN_CHAMP_GAMES games on the
// champion AND >= PLAYRATE_THRESHOLD of their (sampled) games on it. For each we
// surface their rank, most-used keystone + secondary tree, most-used first
// completed item (legendary_order[1]) and their champ playrate.
//
// Ranking is by RANK (tier, then LP) — the highest-elo OTP is #1. This is the
// single authoritative "best <champion> player" list; the AI's
// `champion_top_players` tool calls fetchChampionOtps() too so the chatbot and
// the OTP page never disagree.

import { explorerPool } from "../explorer/pool";

export const MASTER_PLUS = ["MASTER", "GRANDMASTER", "CHALLENGER"];
export const MIN_CHAMP_GAMES = 10;
export const PLAYRATE_THRESHOLD = 0.4; // 40% of their games on this champ
const LIMIT = 50;

// The box crawls EU only → platforms EUW1 / EUN1. Map the UI region key to a
// platform filter (ALL → no filter). Keep this in sync with REGIONS in the
// ChampionOtpRanking component.
export const REGION_TO_PLATFORM: Record<string, string | null> = {
  ALL: null,
  EUW: "EUW1",
  EUNE: "EUN1",
};

// platform → routing region the summoner page understands (for the row link).
export const PLATFORM_TO_REGION: Record<string, string> = {
  EUW1: "EUW",
  EUN1: "EUNE",
};

const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * The authoritative ranked one-trick list for a champion: Master+ players with
 * >= MIN_CHAMP_GAMES on the champ and >= PLAYRATE_THRESHOLD of their games on it,
 * ORDERED BY RANK (tier, then LP) — NOT by winrate. `players[0]` is the best /
 * highest-elo one-trick. `championName` must be the canonical Riot champion name
 * (e.g. "Trundle"). Returns [] for an unknown region key.
 */
export async function fetchChampionOtps(
  championName: string,
  regionKey: string = "ALL",
  limit: number = LIMIT
): Promise<any[]> {
  const key = (regionKey ?? "ALL").toUpperCase();
  if (!(key in REGION_TO_PLATFORM)) return [];
  const platform = REGION_TO_PLATFORM[key];

  // Reads the nightly summary (otp_champion_players) instead of deriving the
  // aggregates per request.
  //
  // ⚠️ The RANK is still joined live from `players`, deliberately. Tier,
  // division and LP change every game; the participant-derived stats move
  // slowly. Freezing the first with the second would have the tab showing a
  // rank a day out of date.
  //
  // What this replaces: the same answer used to cost a 1.5M-row bitmap heap
  // scan of `participants` per champion per request — 184 seconds measured on
  // Ahri, and a 500 when parallel workers exhausted the container's /dev/shm.
  // See src/jobs/otp-precompute.ts in loldata-cron for the build side.
  const sql = `
    SELECT o.puuid, pl.game_name, pl.tag_line, pl.tier, pl.division, pl.lp,
           pl.icon_id, pl.platform,
           o.champ_games, o.champ_wins, o.k, o.d, o.a, o.cs, o.secs,
           o.keystone, o.sub_style, o.first_item, o.total_games
    FROM otp_champion_players o
    JOIN players pl ON pl.puuid = o.puuid
    WHERE o.champion_name = $1
      AND pl.tier = ANY($2)
      AND o.champ_games >= $3
      AND ($4::text IS NULL OR pl.platform = $4)
      AND (o.champ_games::float / NULLIF(o.total_games, 0)) >= $5
    ORDER BY CASE pl.tier WHEN 'CHALLENGER' THEN 0 WHEN 'GRANDMASTER' THEN 1 WHEN 'MASTER' THEN 2 ELSE 9 END,
             pl.lp DESC
    LIMIT $6;`;

  const { rows } = await explorerPool().query(sql, [
    championName,
    MASTER_PLUS,
    MIN_CHAMP_GAMES,
    platform,
    PLAYRATE_THRESHOLD,
    limit,
  ]);

  return rows.map((r: any, i: number) => {
    const games = Number(r.champ_games) || 0;
    const wins = Number(r.champ_wins) || 0;
    const total = Number(r.total_games) || 0;
    const deaths = Number(r.d) || 0;
    const kills = Number(r.k) || 0;
    const assists = Number(r.a) || 0;
    const cs = Number(r.cs) || 0;
    const secs = Number(r.secs) || 0;
    const minutes = secs / 60;
    return {
      rank: i + 1,
      puuid: r.puuid,
      name: r.game_name ?? "Unknown",
      tag: r.tag_line ?? "",
      tier: (r.tier ?? "").toUpperCase(),
      division: r.division ?? "",
      lp: r.lp ?? 0,
      profileIconId: r.icon_id ?? 29,
      champGames: games,
      champWins: wins,
      champWinrate: games > 0 ? Math.round((wins / games) * 1000) / 10 : 0,
      totalGames: total,
      champPlayrate: total > 0 ? Math.round((games / total) * 1000) / 10 : 0,
      avgKills: games > 0 ? Math.round((kills / games) * 10) / 10 : 0,
      avgDeaths: games > 0 ? Math.round((deaths / games) * 10) / 10 : 0,
      avgAssists: games > 0 ? Math.round((assists / games) * 10) / 10 : 0,
      kda: deaths > 0 ? Math.round(((kills + assists) / deaths) * 100) / 100 : 99,
      avgCsPerMin: minutes > 0 ? Math.round((cs / minutes) * 10) / 10 : 0,
      keystone: r.keystone ?? null,
      secondaryStyle: r.sub_style ?? null,
      firstItem: r.first_item ?? null,
      region: PLATFORM_TO_REGION[r.platform] ?? "EUW",
    };
  });
}

export async function getChampionOtpRankingHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { championName } = body;
    const regionKey = (body.region ?? "ALL").toUpperCase();

    if (!championName) {
      return new Response("Missing championName", { status: 400 });
    }

    if (!(regionKey in REGION_TO_PLATFORM)) {
      return Response.json({ champion: championName, region: regionKey, players: [], totalOtps: 0 });
    }

    const cacheKey = `${championName}:${regionKey}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return Response.json(cached.data);
    }

    const players = await fetchChampionOtps(championName, regionKey, LIMIT);

    const result = {
      champion: championName,
      region: regionKey,
      players,
      totalOtps: players.length,
    };

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return Response.json(result);
  } catch (err) {
    console.error("OTP ranking error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
