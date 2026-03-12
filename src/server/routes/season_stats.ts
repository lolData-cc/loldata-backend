// src/server/routes/season_stats.ts
import { getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";
import type { SeasonStatsPayload } from "../seasonCache"; // se ce l'hai già
import { supabaseAdmin } from "../supabase/client"; // <-- ✅ usa il tuo path reale

const Q_SOLO = 420;
const Q_FLEX = 440;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function queuesFor(group: "ranked_all" | "ranked_solo" | "ranked_flex") {
  if (group === "ranked_solo") return [Q_SOLO];
  if (group === "ranked_flex") return [Q_FLEX];
  return [Q_SOLO, Q_FLEX];
}

async function tryAdvisoryLock(key: string) {
  const { data, error } = await supabaseAdmin.rpc("pg_try_advisory_lock_hashtext", {
    key_text: key,
  });
  if (error) throw error;
  return Boolean(data);
}

async function advisoryUnlock(key: string) {
  try {
    const { error } = await supabaseAdmin.rpc("pg_advisory_unlock_hashtext", {
      key_text: key,
    });
    if (error) console.warn("advisory unlock error:", error.message);
  } catch (e) {
    console.warn("advisory unlock exception:", e);
  }
}


/**
 * Incremental updater: scarica solo i match nuovi (stop early quando trova un match già processato)
 * e fa += sugli aggregati.
 */
async function incrementalUpdateSeasonStats(opts: {
  puuid: string;
  region: string;
  queueGroup: "ranked_all" | "ranked_solo" | "ranked_flex";
  maxNewMatches?: number; // safety per request
}) {
  const { puuid, region, queueGroup } = opts;
  const maxNewMatches = opts.maxNewMatches ?? 80;

  const { startTime, endTime } = getCurrentSeasonWindow();
  const seasonStart = Number(startTime ?? 0);
  const seasonEnd = endTime ?? null;

  const queues = queuesFor(queueGroup);
  const lockKey = `season:${puuid}:${seasonStart}:${queueGroup}`;

  const locked = await tryAdvisoryLock(lockKey);
  if (!locked) return; // qualcuno sta già aggiornando

  try {
    // Ensure season aggregate row exists
    await supabaseAdmin.from("season_aggregates").upsert(
      {
        puuid,
        region,
        season_start: seasonStart,
        season_end: seasonEnd,
        queue_group: queueGroup,
        status: "backfilling",
      },
      { onConflict: "puuid,season_start,queue_group" }
    );

    const PAGE = 100;
    const newIds: string[] = [];

    // Fetch newest IDs per queue; stop early when we hit an already processed match
    for (const q of queues) {
      let start = 0;
      let stop = false;

      while (!stop && newIds.length < maxNewMatches) {
        const count = Math.min(PAGE, maxNewMatches - newIds.length);

        const ids = await getMatchIdsByPuuidOpts(puuid, region, {
          start,
          count,
          queue: q,
          type: "ranked",
          startTime,
          endTime,
        });

        if (!ids?.length) break;

        // Batch check which are already processed
        const { data: existing, error } = await supabaseAdmin
          .from("season_processed_matches")
          .select("match_id")
          .eq("puuid", puuid)
          .eq("season_start", seasonStart)
          .eq("queue_group", queueGroup)
          .in("match_id", ids);

        if (error) throw error;

        const seen = new Set((existing ?? []).map((r) => r.match_id));

        for (const id of ids) {
          if (seen.has(id)) {
            stop = true; // stop early: from here onward are older
            break;
          }
          newIds.push(id);
          if (newIds.length >= maxNewMatches) break;
        }

        if (ids.length < PAGE) break;
        start += ids.length;

        await delay(60);
      }

      if (newIds.length >= maxNewMatches) break;
    }

    if (newIds.length === 0) {
      await supabaseAdmin
        .from("season_aggregates")
        .update({
          last_scan_at: new Date().toISOString(),
          computed_at: new Date().toISOString(),
          status: "ok",
        })
        .eq("puuid", puuid)
        .eq("season_start", seasonStart)
        .eq("queue_group", queueGroup);
      return;
    }

    // Process from older -> newer for stability
    for (const matchId of newIds.reverse()) {
      const match = await getMatchDetails(matchId, region);

      if (!queues.includes(match.info.queueId)) continue;

      const me = match.info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;

      const champ = me.championName ?? "Unknown";
      const cs = (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
      const mins = (match.info.gameDuration ?? 0) / 60;
      const gameStart = match.info.gameStartTimestamp ?? match.info.gameCreation ?? 0;

      // Insert processed match (unique). If duplicate -> skip.
      const { error: insErr } = await supabaseAdmin.from("season_processed_matches").insert({
        puuid,
        region,
        season_start: seasonStart,
        queue_group: queueGroup,
        match_id: matchId,
        game_start: gameStart,
        queue_id: match.info.queueId,
      });

      // Unique violation (already processed)
      if (insErr) {
        const code = (insErr as any).code;
        const msg = String((insErr as any).message ?? "").toLowerCase();
        if (code === "23505" || msg.includes("duplicate")) continue;
        throw insErr;
      }

      // Apply totals delta (atomic in DB)
      await supabaseAdmin.rpc("season_apply_delta", {
        p_puuid: puuid,
        p_season_start: seasonStart,
        p_queue_group: queueGroup,
        p_region: region,
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

      // Apply champion delta (atomic upsert)
      await supabaseAdmin.rpc("season_apply_champion_delta", {
        p_puuid: puuid,
        p_season_start: seasonStart,
        p_queue_group: queueGroup,
        p_region: region,
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

      // Apply matchup delta — find lane opponent by same position on enemy team
      const myRole = me.teamPosition || me.individualPosition || "";
      if (myRole) {
        const enemyTeamId = me.teamId === 100 ? 200 : 100;
        const laneOpponent = match.info.participants.find(
          (p: any) =>
            p.teamId === enemyTeamId &&
            (p.teamPosition || p.individualPosition || "") === myRole
        );
        if (laneOpponent) {
          const oppChamp = laneOpponent.championName ?? "Unknown";
          await supabaseAdmin.rpc("season_apply_matchup_delta", {
            p_puuid: puuid,
            p_season_start: seasonStart,
            p_queue_group: queueGroup,
            p_region: region,
            p_champion: champ,
            p_opponent: oppChamp,
            p_games: 1,
            p_wins: me.win ? 1 : 0,
            p_kills: me.kills ?? 0,
            p_deaths: me.deaths ?? 0,
            p_assists: me.assists ?? 0,
          }).catch(() => {}); // non-fatal if table doesn't exist yet
        }
      }

      await delay(40);
    }

    await supabaseAdmin
      .from("season_aggregates")
      .update({
        last_scan_at: new Date().toISOString(),
        computed_at: new Date().toISOString(),
        status: "ok",
      })
      .eq("puuid", puuid)
      .eq("season_start", seasonStart)
      .eq("queue_group", queueGroup);
  } finally {
    await advisoryUnlock(lockKey);
  }
}

/**
 * Legge dal DB gli aggregati per champion e li converte nel formato del tuo frontend.
 */
async function readSeasonStatsFromDb(opts: {
  puuid: string;
  region: string;
  queueGroup: "ranked_all" | "ranked_solo" | "ranked_flex";
}): Promise<SeasonStatsPayload & { updating?: boolean }> {
  const { puuid, region, queueGroup } = opts;

  const { startTime } = getCurrentSeasonWindow();
  const seasonStart = Number(startTime ?? 0);

  const { data: aggRow } = await supabaseAdmin
    .from("season_aggregates")
    .select("status, computed_at")
    .eq("puuid", puuid)
    .eq("season_start", seasonStart)
    .eq("queue_group", queueGroup)
    .maybeSingle();

  const updating = aggRow?.status === "backfilling";

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

      const avgGold = c.games > 0 ? Math.round((c.total_gold ?? 0) / c.games) : 0;
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
        // per sorting stabile
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
      .select("champion,opponent,games,wins,total_kills,total_deaths,total_assists")
      .eq("puuid", puuid)
      .eq("season_start", seasonStart)
      .eq("queue_group", queueGroup);

    if (matchupRows) {
      // Group by champion, sort by games desc, take top 3
      for (const r of matchupRows) {
        if (!matchups[r.champion]) matchups[r.champion] = [];
        const deaths = r.total_deaths ?? 0;
        const kills = r.total_kills ?? 0;
        const assists = r.total_assists ?? 0;
        const kda = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : "Perfect";
        const wr = r.games > 0 ? Math.round((r.wins / r.games) * 100) : 0;

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
      // Sort each champion's matchups by games desc, keep top 3
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
    ...(updating ? { updating: true } : {}),
  };
}

/**
 * Route handler (compat col tuo frontend)
 * - Risponde subito dal DB
 * - Lancia in parallelo l'update incrementale
 */
export async function getSeasonStatsHandler(req: Request): Promise<Response> {
  const { puuid, region, queueGroup = "ranked_all" } = await req.json();

  if (!puuid || !region) return new Response("Missing puuid/region", { status: 400 });

  // 1) rispondi subito dal DB
  let payload: SeasonStatsPayload & { updating?: boolean };
  try {
    payload = await readSeasonStatsFromDb({ puuid, region, queueGroup });
  } catch (err) {
    console.error("season_stats DB read error:", err);
    // fallback safe
    payload = { topChampions: [], seasonTotals: { games: 0, wins: 0 }, computedAt: Date.now() };
  }

  // 2) update in background (non await)
  incrementalUpdateSeasonStats({ puuid, region, queueGroup }).catch((e) =>
    console.error("season_stats incremental update error:", e)
  );

  // Se non hai ancora nulla in DB, per UX puoi far capire che sta aggiornando:
  // (il tuo frontend oggi non lo usa, ma non rompe nulla)
  const isEmpty = !payload.topChampions || payload.topChampions.length === 0;
  if (isEmpty) {
    // opzionale: invece di 200/202, rispondi comunque 200 con empty + updating
    return Response.json({ ...payload, updating: true }, { status: 200 });
  }

  return Response.json(payload, { status: 200 });
}
