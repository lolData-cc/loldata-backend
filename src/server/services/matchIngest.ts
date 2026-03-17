// src/server/services/matchIngest.ts
// Shared ingestion service: fetches matches from Riot API, stores structured
// data in DB, and updates season aggregates atomically.
// Does NOT store raw JSON — match details are fetched on-demand by getMatches.

import { getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";
import { supabaseAdmin } from "../supabase/client";

const Q_SOLO = 420;
const Q_FLEX = 440;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Checks if season aggregates exist for the current season_start.
 * If not, rebuilds them from participants + matches already in DB.
 * This handles the case where SEASON_START_EPOCH is updated (new season).
 */
async function ensureSeasonAggregates(
  puuid: string,
  region: string,
  matchIds: string[],
  seasonStart: number,
  seasonEnd: number | null
) {
  // Check which matches have already been processed for this season
  const { data: processedRows } = await supabaseAdmin
    .from("season_processed_matches")
    .select("match_id")
    .eq("puuid", puuid)
    .eq("season_start", seasonStart)
    .eq("queue_group", "ranked_all");

  const processedIds = new Set((processedRows ?? []).map((r) => r.match_id));
  const unprocessedIds = matchIds.filter((id) => !processedIds.has(id));

  if (unprocessedIds.length === 0) return; // All matches already processed

  console.log(`🔄 Rebuilding season aggregates for ${puuid} (season_start=${seasonStart}, ${unprocessedIds.length} unprocessed matches)`);

  // Get participants for unprocessed matches only
  const { data: partRows } = await supabaseAdmin
    .from("participants")
    .select("match_id, champion_name, role, win, kills, deaths, assists, gold_earned, total_damage_to_champions, vision_score")
    .eq("puuid", puuid)
    .in("match_id", unprocessedIds);

  if (!partRows || partRows.length === 0) return;

  // Get match metadata for queue_id and duration
  const { data: matchMeta } = await supabaseAdmin
    .from("matches")
    .select("match_id, queue_id, game_duration_seconds, game_creation")
    .in("match_id", unprocessedIds)
    .in("queue_id", [Q_SOLO, Q_FLEX]);

  if (!matchMeta || matchMeta.length === 0) return;

  const metaLookup = new Map(matchMeta.map((m) => [m.match_id, m]));

  // Also need CS data — participants table doesn't store cs directly,
  // so we'll need to fetch from Riot API for each match.
  // Instead, let's use what we have and set cs/duration to 0 where unavailable.

  // Create aggregate rows first
  for (const qg of ["ranked_all", "ranked_solo", "ranked_flex"] as const) {
    await supabaseAdmin.from("season_aggregates").upsert(
      {
        puuid,
        region: region.toUpperCase(),
        season_start: seasonStart,
        season_end: seasonEnd,
        queue_group: qg,
        status: "ok",
        last_scan_at: new Date().toISOString(),
        computed_at: new Date().toISOString(),
      },
      { onConflict: "puuid,season_start,queue_group" }
    );
  }

  // Process each match
  for (const part of partRows) {
    const meta = metaLookup.get(part.match_id);
    if (!meta) continue;

    const qid = meta.queue_id;
    const queueGroup = qid === Q_SOLO ? "ranked_solo" : "ranked_flex";
    const durationSec = meta.game_duration_seconds ?? 0;
    const mins = durationSec / 60;
    const gameStart = meta.game_creation ? new Date(meta.game_creation).getTime() : 0;
    const champ = part.champion_name ?? "Unknown";

    for (const qg of ["ranked_all", queueGroup] as const) {
      // Insert processed match record (skip if duplicate)
      const { error: insErr } = await supabaseAdmin
        .from("season_processed_matches")
        .insert({
          puuid,
          region: region.toUpperCase(),
          season_start: seasonStart,
          queue_group: qg,
          match_id: part.match_id,
          game_start: gameStart,
          queue_id: qid,
        });

      if (insErr) {
        const code = (insErr as any).code;
        const msg = String((insErr as any).message ?? "").toLowerCase();
        if (code === "23505" || msg.includes("duplicate")) continue;
        console.error("season rebuild insert error:", insErr);
        continue;
      }

      // Apply season totals delta
      await supabaseAdmin.rpc("season_apply_delta", {
        p_puuid: puuid,
        p_season_start: seasonStart,
        p_queue_group: qg,
        p_region: region.toUpperCase(),
        p_games: 1,
        p_wins: part.win ? 1 : 0,
        p_gold: part.gold_earned ?? 0,
        p_kills: part.kills ?? 0,
        p_deaths: part.deaths ?? 0,
        p_assists: part.assists ?? 0,
        p_cs: 0, // CS not stored in participants table
        p_duration_min: mins,
        p_last_game_start: gameStart,
      });

      // Apply champion delta
      await supabaseAdmin.rpc("season_apply_champion_delta", {
        p_puuid: puuid,
        p_season_start: seasonStart,
        p_queue_group: qg,
        p_region: region.toUpperCase(),
        p_champion: champ,
        p_games: 1,
        p_wins: part.win ? 1 : 0,
        p_gold: part.gold_earned ?? 0,
        p_kills: part.kills ?? 0,
        p_deaths: part.deaths ?? 0,
        p_assists: part.assists ?? 0,
        p_cs: 0,
        p_duration_min: mins,
      });
    }
  }

  console.log(`✅ Season aggregates rebuilt for ${puuid}: ${partRows.length} matches processed`);
}

/**
 * Ingest a single match into DB + season aggregates.
 * Extracted so it can be reused by both quick and full ingestion.
 */
async function ingestSingleMatch(
  matchId: string,
  puuid: string,
  region: string,
  seasonStart: number,
  seasonEnd: number | null
): Promise<boolean> {
  const match = await getMatchDetails(matchId, region);

  const qid = match.info.queueId;
  if (qid !== Q_SOLO && qid !== Q_FLEX) return false;

  // Normalize gameEndTimestamp
  const startTs =
    match.info.gameStartTimestamp ?? match.info.gameCreation;
  if (startTs && match.info.gameDuration) {
    match.info.gameEndTimestamp =
      startTs + match.info.gameDuration * 1000;
  }

  const me = match.info.participants.find(
    (p: any) => p.puuid === puuid
  );
  if (!me) return false;

  const platform =
    matchId.split("_")[0]?.toLowerCase() ?? region.toLowerCase();

  let durationSec = match.info.gameDuration ?? 0;
  if (durationSec > 100_000) durationSec = Math.floor(durationSec / 1000);

  const gameStart =
    match.info.gameStartTimestamp ?? match.info.gameCreation ?? 0;
  const gameCreationIso = gameStart
    ? new Date(gameStart).toISOString()
    : new Date().toISOString();

  // Upsert match row
  await supabaseAdmin.from("matches").upsert(
    {
      match_id: matchId,
      platform,
      game_creation: gameCreationIso,
      game_duration_seconds: durationSec,
      game_version: match.info.gameVersion ?? null,
      queue_id: qid,
    },
    { onConflict: "match_id" }
  );

  // Upsert match_teams
  const teamRows = (match.info.teams ?? []).map((t: any) => ({
    match_id: matchId,
    team_id: t.teamId,
    win: t.win,
    first_dragon: t.objectives?.dragon?.first ?? null,
    first_baron: t.objectives?.baron?.first ?? null,
    towers_destroyed: t.objectives?.tower?.kills ?? null,
    dragons: t.objectives?.dragon?.kills ?? null,
    barons: t.objectives?.baron?.kills ?? null,
  }));

  if (teamRows.length > 0) {
    await supabaseAdmin
      .from("match_teams")
      .upsert(teamRows, { onConflict: "match_id,team_id" });
  }

  // Upsert participants
  const participantRows = match.info.participants.map(
    (p: any, idx: number) => ({
      match_id: matchId,
      participant_id: idx + 1,
      puuid: p.puuid ?? null,
      summoner_name: p.riotIdGameName ?? p.summonerName ?? null,
      team_id: p.teamId ?? null,
      champion_id: p.championId ?? null,
      champion_name: p.championName ?? null,
      role: p.teamPosition || p.individualPosition || null,
      lane: p.lane ?? null,
      win: !!p.win,
      kills: p.kills ?? 0,
      deaths: p.deaths ?? 0,
      assists: p.assists ?? 0,
      gold_earned: p.goldEarned ?? 0,
      total_damage_to_champions: p.totalDamageDealtToChampions ?? 0,
      vision_score: p.visionScore ?? 0,
      item0: p.item0 ?? 0,
      item1: p.item1 ?? 0,
      item2: p.item2 ?? 0,
      item3: p.item3 ?? 0,
      item4: p.item4 ?? 0,
      item5: p.item5 ?? 0,
      item6: p.item6 ?? 0,
    })
  );

  if (participantRows.length > 0) {
    await supabaseAdmin
      .from("participants")
      .upsert(participantRows, {
        onConflict: "match_id,participant_id",
      });
  }

  // Season aggregation
  const champ = me.championName ?? "Unknown";
  const cs =
    (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
  const mins = durationSec / 60;
  const queueGroup = qid === Q_SOLO ? "ranked_solo" : "ranked_flex";

  for (const qg of ["ranked_all", queueGroup] as const) {
    await supabaseAdmin.from("season_aggregates").upsert(
      {
        puuid,
        region: region.toUpperCase(),
        season_start: seasonStart,
        season_end: seasonEnd,
        queue_group: qg,
        status: "ok",
      },
      { onConflict: "puuid,season_start,queue_group" }
    );

    const { error: insErr } = await supabaseAdmin
      .from("season_processed_matches")
      .insert({
        puuid,
        region: region.toUpperCase(),
        season_start: seasonStart,
        queue_group: qg,
        match_id: matchId,
        game_start: gameStart,
        queue_id: qid,
      });

    if (insErr) {
      const code = (insErr as any).code;
      const msg = String((insErr as any).message ?? "").toLowerCase();
      if (code === "23505" || msg.includes("duplicate")) continue;
      console.error("season_processed_matches insert error:", insErr);
      continue;
    }

    await supabaseAdmin.rpc("season_apply_delta", {
      p_puuid: puuid,
      p_season_start: seasonStart,
      p_queue_group: qg,
      p_region: region.toUpperCase(),
      p_games: 1,
      p_wins: me.win ? 1 : 0,
      p_gold: me.goldEarned ?? 0,
      p_kills: me.kills ?? 0,
      p_deaths: me.deaths ?? 0,
      p_assists: me.assists ?? 0,
      p_cs: cs,
      p_duration_min: mins,
      p_last_game_start: gameStart,
    });

    await supabaseAdmin.rpc("season_apply_champion_delta", {
      p_puuid: puuid,
      p_season_start: seasonStart,
      p_queue_group: qg,
      p_region: region.toUpperCase(),
      p_champion: champ,
      p_games: 1,
      p_wins: me.win ? 1 : 0,
      p_gold: me.goldEarned ?? 0,
      p_kills: me.kills ?? 0,
      p_deaths: me.deaths ?? 0,
      p_assists: me.assists ?? 0,
      p_cs: cs,
      p_duration_min: mins,
    });

    // Apply matchup delta
    const myRole = me.teamPosition || me.individualPosition || "";
    if (myRole) {
      const enemyTeamId = me.teamId === 100 ? 200 : 100;
      const laneOpponent = match.info.participants.find(
        (p: any) =>
          p.teamId === enemyTeamId &&
          (p.teamPosition || p.individualPosition || "") === myRole
      );
      if (laneOpponent) {
        try {
          await supabaseAdmin.rpc("season_apply_matchup_delta", {
            p_puuid: puuid,
            p_season_start: seasonStart,
            p_queue_group: qg,
            p_region: region.toUpperCase(),
            p_champion: champ,
            p_opponent: laneOpponent.championName ?? "Unknown",
            p_games: 1,
            p_wins: me.win ? 1 : 0,
            p_kills: me.kills ?? 0,
            p_deaths: me.deaths ?? 0,
            p_assists: me.assists ?? 0,
          });
        } catch {
          // non-fatal if table/function doesn't exist yet
        }
      }
    }
  }

  return true;
}

/**
 * Ingest all ranked matches for a player into the DB.
 * - Fetches match IDs from Riot (current season, ranked)
 * - Skips matches already in DB
 * - Stores structured data in matches/participants/match_teams
 * - Updates season aggregates via RPCs
 *
 * Returns { newMatches, totalInDb }
 */
export async function ingestPlayerMatches(
  puuid: string,
  region: string
): Promise<{ newMatches: number; totalInDb: number }> {
  const { startTime, endTime } = getCurrentSeasonWindow();
  const seasonStart = Number(startTime ?? 0);
  const seasonEnd = endTime ?? null;

  // 1. Fetch ALL ranked match IDs from Riot (current season)
  const allMatchIds: string[] = [];
  const PAGE = 100;

  let start = 0;
  while (true) {
    const ids = await getMatchIdsByPuuidOpts(puuid, region, {
      start,
      count: PAGE,
      type: "ranked",
      startTime,
      endTime,
    });

    if (!ids?.length) break;
    allMatchIds.push(...ids);
    start += ids.length;
    if (ids.length < PAGE) break;
    await delay(60);
  }

  if (allMatchIds.length === 0) {
    return { newMatches: 0, totalInDb: 0 };
  }

  // 2. Check which matches already exist in DB (by match_id in participants for this puuid)
  const { data: existingRows } = await supabaseAdmin
    .from("participants")
    .select("match_id")
    .eq("puuid", puuid)
    .in("match_id", allMatchIds);

  const existingIds = new Set((existingRows ?? []).map((r) => r.match_id));
  const newIds = allMatchIds.filter((id) => !existingIds.has(id));

  // Always ensure season aggregates exist for existing matches (handles season_start changes)
  if (existingIds.size > 0) {
    await ensureSeasonAggregates(puuid, region, [...existingIds], seasonStart, seasonEnd);
  }

  if (newIds.length === 0) {
    return { newMatches: 0, totalInDb: existingIds.size };
  }

  // 3. Process new matches (newest first so recent matches appear immediately)
  let ingested = 0;
  for (const matchId of newIds) {
    try {
      const ok = await ingestSingleMatch(matchId, puuid, region, seasonStart, seasonEnd);
      if (ok) ingested++;
      await delay(80);
    } catch (err) {
      console.error(`❌ Error ingesting match ${matchId}:`, err);
    }
  }

  // Update season_aggregates status + timestamps
  for (const qg of ["ranked_all", "ranked_solo", "ranked_flex"]) {
    await supabaseAdmin
      .from("season_aggregates")
      .update({
        last_scan_at: new Date().toISOString(),
        computed_at: new Date().toISOString(),
        status: "ok",
      })
      .eq("puuid", puuid)
      .eq("season_start", seasonStart)
      .eq("queue_group", qg);
  }

  const totalInDb = existingIds.size + ingested;

  console.log(
    `✅ Ingested ${ingested} new matches for ${puuid} (${totalInDb} total in DB)`
  );

  return { newMatches: ingested, totalInDb };
}

/**
 * Quick ingestion: fetches match IDs, awaits the first QUICK_BATCH newest
 * matches synchronously so they're in DB immediately, then continues
 * ingesting the rest in the background.
 *
 * Call this from getSummoner so the frontend's first fetchMatches
 * call already sees the most recent games.
 */
const QUICK_BATCH = 10;

export async function ingestQuickThenBackground(
  puuid: string,
  region: string
): Promise<void> {
  const { startTime, endTime } = getCurrentSeasonWindow();
  const seasonStart = Number(startTime ?? 0);
  const seasonEnd = endTime ?? null;

  // 1. Fetch first page of match IDs from Riot (newest first)
  const firstPageIds = await getMatchIdsByPuuidOpts(puuid, region, {
    start: 0,
    count: QUICK_BATCH,
    type: "ranked",
    startTime,
    endTime,
  });

  if (!firstPageIds?.length) return;

  // 2. Check which of these already exist in DB
  const { data: existingRows } = await supabaseAdmin
    .from("participants")
    .select("match_id")
    .eq("puuid", puuid)
    .in("match_id", firstPageIds);

  const existingIds = new Set((existingRows ?? []).map((r) => r.match_id));
  const newQuickIds = firstPageIds.filter((id) => !existingIds.has(id));

  // 3. Ingest the new ones synchronously (awaited — blocks getSummoner response)
  if (newQuickIds.length > 0) {
    console.log(`⚡ Quick-ingesting ${newQuickIds.length} newest matches for ${puuid}`);
    for (const matchId of newQuickIds) {
      try {
        await ingestSingleMatch(matchId, puuid, region, seasonStart, seasonEnd);
        await delay(50);
      } catch (err) {
        console.error(`❌ Quick ingest error for ${matchId}:`, err);
      }
    }
  }

  // 4. Full ingestion in background (will skip already-ingested matches)
  ingestPlayerMatches(puuid, region).catch((e) =>
    console.error("⚠️ Background match ingestion error:", e)
  );
}
