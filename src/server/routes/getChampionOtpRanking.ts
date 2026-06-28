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

const MASTER_PLUS = ["MASTER", "GRANDMASTER", "CHALLENGER"];
const MIN_CHAMP_GAMES = 10;
const PLAYRATE_THRESHOLD = 0.4; // 40% of their games on this champ
const LIMIT = 50;

// The box crawls EU only → platforms EUW1 / EUN1. Map the UI region key to a
// platform filter (ALL → no filter). Keep this in sync with REGIONS in the
// ChampionOtpRanking component.
const REGION_TO_PLATFORM: Record<string, string | null> = {
  ALL: null,
  EUW: "EUW1",
  EUNE: "EUN1",
};

// platform → routing region the summoner page understands (for the row link).
const PLATFORM_TO_REGION: Record<string, string> = {
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

  const sql = `
    WITH champ AS (
      SELECT p.puuid,
             count(*)                                        AS champ_games,
             count(*) FILTER (WHERE p.win)                   AS champ_wins,
             sum(p.kills)::int                               AS k,
             sum(p.deaths)::int                              AS d,
             sum(p.assists)::int                             AS a,
             sum(p.total_cs)::bigint                         AS cs,
             sum(p.time_played)::bigint                      AS secs,
             mode() WITHIN GROUP (ORDER BY p.perk_keystone)        AS keystone,
             mode() WITHIN GROUP (ORDER BY p.perk_sub_style)       AS sub_style,
             mode() WITHIN GROUP (ORDER BY p.legendary_order[1])   AS first_item
      FROM participants p
      WHERE p.champion_name = $1 AND p.puuid IS NOT NULL
      GROUP BY p.puuid
    ),
    ranked AS (
      SELECT c.*, pl.game_name, pl.tag_line, pl.tier, pl.division, pl.lp, pl.icon_id, pl.platform
      FROM champ c
      JOIN players pl ON pl.puuid = c.puuid
      WHERE pl.tier = ANY($2)
        AND c.champ_games >= $3
        AND ($4::text IS NULL OR pl.platform = $4)
    ),
    totals AS (
      SELECT puuid, count(*) AS total_games
      FROM participants
      WHERE puuid IN (SELECT puuid FROM ranked)
      GROUP BY puuid
    )
    SELECT r.puuid, r.game_name, r.tag_line, r.tier, r.division, r.lp, r.icon_id, r.platform,
           r.champ_games, r.champ_wins, r.k, r.d, r.a, r.cs, r.secs,
           r.keystone, r.sub_style, r.first_item, t.total_games
    FROM ranked r
    JOIN totals t ON t.puuid = r.puuid
    WHERE (r.champ_games::float / NULLIF(t.total_games, 0)) >= $5
    ORDER BY CASE r.tier WHEN 'CHALLENGER' THEN 0 WHEN 'GRANDMASTER' THEN 1 WHEN 'MASTER' THEN 2 ELSE 9 END,
             r.lp DESC
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
