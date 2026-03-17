// src/server/routes/season_stats.ts
// Simplified: reads season aggregates from DB (populated by matchIngest service).
// No more background Riot API fetching — ingestion handles everything.

import type { SeasonStatsPayload } from "../seasonCache";
import { supabaseAdmin } from "../supabase/client";
import { getCurrentSeasonWindow } from "../season";

/**
 * Reads season stats from DB and formats for frontend.
 */
async function readSeasonStatsFromDb(opts: {
  puuid: string;
  region: string;
  queueGroup: "ranked_all" | "ranked_solo" | "ranked_flex";
}): Promise<SeasonStatsPayload> {
  const { puuid, queueGroup } = opts;

  const { startTime } = getCurrentSeasonWindow();
  const seasonStart = Number(startTime ?? 0);

  const { data: champs, error } = await supabaseAdmin
    .from("season_champion_aggregates")
    .select(
      "champion,games,wins,total_gold,total_kills,total_deaths,total_assists,total_cs,total_duration_minutes"
    )
    .eq("puuid", puuid)
    .eq("season_start", seasonStart)
    .eq("queue_group", queueGroup);

  if (error) throw error;

  const rows = champs ?? [];

  const topChampions = rows
    .map((c) => {
      const deaths = c.total_deaths ?? 0;
      const kills = c.total_kills ?? 0;
      const assists = c.total_assists ?? 0;

      const rawKda = deaths > 0 ? (kills + assists) / deaths : Infinity;
      const winrate = c.games > 0 ? Math.round((c.wins / c.games) * 100) : 0;

      const avgGold =
        c.games > 0 ? Math.round((c.total_gold ?? 0) / c.games) : 0;
      const csPerMin =
        (c.total_duration_minutes ?? 0) > 0
          ? ((c.total_cs ?? 0) / (c.total_duration_minutes ?? 1)).toFixed(2)
          : "0.00";

      return {
        champion: c.champion,
        games: c.games,
        wins: c.wins,
        kills,
        deaths,
        assists,
        winrate,
        avgGold,
        avgKda: deaths > 0 ? rawKda.toFixed(2) : "Perfect",
        csPerMin,
        _sortGames: c.games,
        _sortWinrate: winrate,
        _sortKda: rawKda,
      };
    })
    .sort(
      (a, b) =>
        b._sortGames - a._sortGames ||
        b._sortWinrate - a._sortWinrate ||
        b._sortKda - a._sortKda
    )
    .map(({ _sortGames, _sortWinrate, _sortKda, ...rest }) => rest);

  const seasonTotals = topChampions.reduce(
    (acc, c) => ({ games: acc.games + c.games, wins: acc.wins + c.wins }),
    { games: 0, wins: 0 }
  );

  // Fetch per-champion matchup data (top 3 opponents per champion)
  let matchups: Record<string, any[]> = {};
  try {
    const { data: matchupRows } = await supabaseAdmin
      .from("season_champion_matchups")
      .select(
        "champion,opponent,games,wins,total_kills,total_deaths,total_assists"
      )
      .eq("puuid", puuid)
      .eq("season_start", seasonStart)
      .eq("queue_group", queueGroup);

    if (matchupRows) {
      for (const r of matchupRows) {
        if (!matchups[r.champion]) matchups[r.champion] = [];
        const deaths = r.total_deaths ?? 0;
        const kills = r.total_kills ?? 0;
        const assists = r.total_assists ?? 0;
        const kda =
          deaths > 0
            ? ((kills + assists) / deaths).toFixed(2)
            : "Perfect";
        const wr =
          r.games > 0 ? Math.round((r.wins / r.games) * 100) : 0;

        matchups[r.champion].push({
          opponent: r.opponent,
          games: r.games,
          wins: r.wins,
          winrate: wr,
          kills,
          deaths,
          assists,
          kda,
        });
      }
      for (const champ in matchups) {
        matchups[champ] = matchups[champ]
          .sort((a, b) => b.games - a.games)
          .slice(0, 3);
      }
    }
  } catch {
    // Table may not exist yet — non-fatal
  }

  return {
    topChampions,
    seasonTotals,
    matchups,
    computedAt: Date.now(),
  };
}

/**
 * Route handler — always returns 200 with whatever data is in DB.
 * No more 202 / background fetching. Ingestion is handled by matchIngest service.
 */
export async function getSeasonStatsHandler(req: Request): Promise<Response> {
  const { puuid, region, queueGroup = "ranked_all" } = await req.json();

  if (!puuid || !region)
    return new Response("Missing puuid/region", { status: 400 });

  let payload: SeasonStatsPayload;
  try {
    payload = await readSeasonStatsFromDb({ puuid, region, queueGroup });
  } catch (err) {
    console.error("season_stats DB read error:", err);
    payload = {
      topChampions: [],
      seasonTotals: { games: 0, wins: 0 },
      computedAt: Date.now(),
    };
  }

  return Response.json(payload, { status: 200 });
}
