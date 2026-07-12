// src/server/routes/livegameStats.ts
// Returns champion winrate + filled detection for live game participants.
// Reads from season_champion_aggregates + participants tables (populated by cron).

import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client"; // match → box, users → Cloud (hybrid)
import { getCurrentSeasonWindow } from "../season";

type ParticipantInput = {
  riotId: string;
  championName: string;
  role: string; // "top" | "jungle" | "mid" | "bot" | "support"
};

// Normalize role strings from different sources
function normalizeRole(role: string): string {
  const r = (role ?? "").toUpperCase().trim();
  if (r === "MIDDLE") return "MID";
  if (r === "BOTTOM") return "BOT";
  if (r === "UTILITY") return "SUPPORT";
  if (r === "JUNGLE") return "JUNGLE";
  if (r === "TOP") return "TOP";
  // Handle lowercase inputs from frontend
  const upper = r;
  if (["TOP", "JUNGLE", "MID", "BOT", "SUPPORT"].includes(upper)) return upper;
  return r;
}

export async function getLivegameStatsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { participants, region } = body as {
      participants: ParticipantInput[];
      region: string;
    };

    if (!participants || !Array.isArray(participants)) {
      return new Response("Missing participants", { status: 400 });
    }

    const { startTime } = getCurrentSeasonWindow();
    const seasonStart = Number(startTime ?? 0);

    // 1. Resolve riotIds → puuids from users table (no Riot API calls)
    const riotIdToName = new Map<string, { name: string; tag: string }>();
    for (const p of participants) {
      const [name, tag] = (p.riotId ?? "").split("#");
      if (name && tag) riotIdToName.set(p.riotId, { name, tag });
    }

    const names = [...riotIdToName.values()].map((v) => v.name);
    const { data: userRows } = await supabaseAdmin
      .from("users")
      .select("puuid, name, tag")
      .in("name", names);

    // Build riotId → puuid lookup
    const riotIdToPuuid = new Map<string, string>();
    for (const [riotId, { name, tag }] of riotIdToName) {
      const user = (userRows ?? []).find(
        (u) =>
          u.name?.toLowerCase() === name.toLowerCase() &&
          u.tag?.toLowerCase() === tag.toLowerCase()
      );
      if (user?.puuid) riotIdToPuuid.set(riotId, user.puuid);
    }

    const puuids = [...riotIdToPuuid.values()];
    if (puuids.length === 0) {
      return Response.json({ stats: {} });
    }

    // 2. Batch-fetch champion stats + role distribution + season totals in parallel
    const [{ data: champRows }, { data: roleRows }, { data: seasonRows }] = await Promise.all([
      // Champion-specific stats from season aggregates (KDA/CS come free from the same row)
      supabaseMatchAdmin
        .from("season_champion_aggregates")
        .select("puuid, champion, games, wins, total_kills, total_deaths, total_assists, total_cs, total_duration_minutes")
        .eq("season_start", seasonStart)
        .eq("queue_group", "ranked_all")
        .in("puuid", puuids),

      // Role distribution from participants table
      // We need to count games per role per puuid
      supabaseMatchAdmin
        .from("participants")
        .select("puuid, role")
        .in("puuid", puuids)
        .not("role", "is", null)
        .not("role", "eq", ""),

      // Whole-season totals (all champions) for an overall KDA line
      supabaseMatchAdmin
        .from("season_aggregates")
        .select("puuid, games, wins, total_kills, total_deaths, total_assists")
        .eq("season_start", seasonStart)
        .eq("queue_group", "ranked_all")
        .in("puuid", puuids),
    ]);

    // Build puuid → champion stats lookup
    type ChampAgg = {
      games: number; wins: number;
      kills: number; deaths: number; assists: number;
      cs: number; minutes: number;
    };
    const champStatsByPuuid = new Map<string, Map<string, ChampAgg>>();
    for (const row of champRows ?? []) {
      if (!champStatsByPuuid.has(row.puuid)) {
        champStatsByPuuid.set(row.puuid, new Map());
      }
      champStatsByPuuid.get(row.puuid)!.set(row.champion, {
        games: row.games,
        wins: row.wins,
        kills: row.total_kills ?? 0,
        deaths: row.total_deaths ?? 0,
        assists: row.total_assists ?? 0,
        cs: row.total_cs ?? 0,
        minutes: row.total_duration_minutes ?? 0,
      });
    }

    // Build puuid → whole-season totals (all champions)
    const seasonByPuuid = new Map<
      string,
      { games: number; wins: number; kills: number; deaths: number; assists: number }
    >();
    for (const row of seasonRows ?? []) {
      seasonByPuuid.set(row.puuid, {
        games: row.games ?? 0,
        wins: row.wins ?? 0,
        kills: row.total_kills ?? 0,
        deaths: row.total_deaths ?? 0,
        assists: row.total_assists ?? 0,
      });
    }

    // Build puuid → role counts
    const roleCountsByPuuid = new Map<string, Map<string, number>>();
    for (const row of roleRows ?? []) {
      const normalized = normalizeRole(row.role);
      if (!normalized) continue;
      if (!roleCountsByPuuid.has(row.puuid)) {
        roleCountsByPuuid.set(row.puuid, new Map());
      }
      const roles = roleCountsByPuuid.get(row.puuid)!;
      roles.set(normalized, (roles.get(normalized) ?? 0) + 1);
    }

    // 3. Build response
    const stats: Record<string, any> = {};

    for (const p of participants) {
      const puuid = riotIdToPuuid.get(p.riotId);
      if (!puuid) continue;

      // Champion stats
      const champStats = champStatsByPuuid.get(puuid)?.get(p.championName);
      const championGames = champStats?.games ?? 0;
      const championWins = champStats?.wins ?? 0;
      const championWinrate =
        championGames > 0
          ? Math.round((championWins / championGames) * 100)
          : null;

      // Champion KDA / CS-per-min from the same aggregate row
      const round1 = (v: number) => Math.round(v * 10) / 10;
      const championKda =
        championGames > 0 && champStats
          ? round1(
              (champStats.kills + champStats.assists) /
                Math.max(1, champStats.deaths)
            )
          : null;
      const championAvgKills = championGames > 0 && champStats ? round1(champStats.kills / championGames) : null;
      const championAvgDeaths = championGames > 0 && champStats ? round1(champStats.deaths / championGames) : null;
      const championAvgAssists = championGames > 0 && champStats ? round1(champStats.assists / championGames) : null;
      const championCsMin =
        champStats && champStats.minutes > 0
          ? round1(champStats.cs / champStats.minutes)
          : null;

      // Whole-season overall line
      const season = seasonByPuuid.get(puuid);
      const seasonGames = season?.games ?? 0;
      const seasonWinrate =
        season && season.games > 0
          ? Math.round((season.wins / season.games) * 100)
          : null;
      const seasonKda =
        season && season.games > 0
          ? round1((season.kills + season.assists) / Math.max(1, season.deaths))
          : null;

      // Role distribution
      const roleCounts = roleCountsByPuuid.get(puuid);
      const roleGames: Record<string, number> = {};
      const sortedRoles: { role: string; count: number }[] = [];

      if (roleCounts) {
        for (const [role, count] of roleCounts) {
          roleGames[role.toLowerCase()] = count;
          sortedRoles.push({ role: role.toLowerCase(), count });
        }
        sortedRoles.sort((a, b) => b.count - a.count);
      }

      const mainRoles = sortedRoles.slice(0, 2).map((r) => r.role);

      // Filled detection: player is filled if their current role
      // is NOT one of their top 2 most-played roles
      const currentRole = normalizeRole(p.role).toLowerCase();
      const isFilled =
        mainRoles.length > 0 && !mainRoles.includes(currentRole);

      stats[p.riotId] = {
        championGames,
        championWins,
        championWinrate,
        championKda,
        championAvgKills,
        championAvgDeaths,
        championAvgAssists,
        championCsMin,
        seasonGames,
        seasonWinrate,
        seasonKda,
        mainRoles,
        isFilled,
        roleGames,
      };
    }

    return Response.json({ stats });
  } catch (err) {
    console.error("livegame/stats error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
