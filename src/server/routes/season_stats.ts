// src/server/routes/season_stats.ts
import { getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";
import {
  readSeasonCache,
  writeSeasonCache,
  readStaleSeasonCache,
  buildCacheKey,
  SeasonStatsPayload,
  DEFAULT_SEASON_STATS_LIMIT,
} from "../seasonCache";

const inFlight = new Map<string, Promise<void>>();

const Q_SOLO = 420;
const Q_FLEX = 440;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ HARD LIMIT (per ora, con dev key)
const MAX_MATCHES_FOR_STATS = DEFAULT_SEASON_STATS_LIMIT; // = 20

async function computeSeasonStats(
  puuid: string,
  region: string,
  queueGroup: "ranked_all" | "ranked_solo" | "ranked_flex" = "ranked_all",
  limit: number = MAX_MATCHES_FOR_STATS
): Promise<SeasonStatsPayload> {
  const { startTime, endTime } = getCurrentSeasonWindow();

  const queues =
    queueGroup === "ranked_solo"
      ? [Q_SOLO]
      : queueGroup === "ranked_flex"
        ? [Q_FLEX]
        : [Q_SOLO, Q_FLEX];

  // Prendiamo pochi match -> una sola page basta quasi sempre,
  // ma teniamo PAGE=100 per ridurre chiamate in caso di buchi.
  const PAGE = 100;
  const MAX_IDS = limit; // ✅ stop già qui

  const is429 = (err: any) =>
    err?.status === 429 ||
    err?.response?.status === 429 ||
    /429/.test(String(err?.message ?? ""));

  const seen = new Set<string>();
  let rateLimited = false;

  // ✅ opzionale: distribuzione equa se ranked_all (es. 10 solo + 10 flex)
  const perQueueLimit =
    queueGroup === "ranked_all" ? Math.ceil(MAX_IDS / queues.length) : MAX_IDS;

  for (const q of queues) {
    let start = 0;
    const before = seen.size;

    while (seen.size < MAX_IDS && (seen.size - before) < perQueueLimit && !rateLimited) {
      try {
        const count = Math.min(PAGE, MAX_IDS - seen.size);
        const ids = await getMatchIdsByPuuidOpts(puuid, region, {
          start,
          count,
          queue: q,
          type: "ranked",
          startTime,
          endTime,
        });

        if (!ids || ids.length === 0) break;

        for (const id of ids) {
          seen.add(id);
          if (seen.size >= MAX_IDS) break;
        }

        start += ids.length;

        // micro delay per stare soft
        await delay(80);
      } catch (err: any) {
        if (is429(err)) {
          console.error("❌ Rate limited (429) durante il fetch degli ID. Stop immediato.");
          rateLimited = true;
          break;
        }
        console.error("❌ Errore fetch ID:", err);
        break;
      }
    }

    if (rateLimited || seen.size >= MAX_IDS) break;
  }

  const championStats: Record<
    string,
    {
      games: number;
      wins: number;
      totalGold: number;
      totalKills: number;
      totalDeaths: number;
      totalAssists: number;
      totalCs: number;
      totalGameDurationMinutes: number;
    }
  > = {};

  // ✅ fetch dettagli solo per i primi "limit"
  const idsToProcess = Array.from(seen).slice(0, limit);

  for (const id of idsToProcess) {
    try {
      const match = await getMatchDetails(id, region);

      const qid = match.info.queueId;
      if (!queues.includes(qid)) continue;

      const startTs = match.info.gameStartTimestamp ?? match.info.gameCreation;
      if (startTime && startTs && Math.floor(startTs / 1000) < startTime) continue;

      const me = match.info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;

      const champ = me.championName ?? "Unknown";
      const cs = (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
      const mins = (match.info.gameDuration ?? 0) / 60;

      const b = (championStats[champ] ??= {
        games: 0,
        wins: 0,
        totalGold: 0,
        totalKills: 0,
        totalDeaths: 0,
        totalAssists: 0,
        totalCs: 0,
        totalGameDurationMinutes: 0,
      });

      b.games += 1;
      if (me.win) b.wins += 1;
      b.totalGold += me.goldEarned ?? 0;
      b.totalKills += me.kills ?? 0;
      b.totalDeaths += me.deaths ?? 0;
      b.totalAssists += me.assists ?? 0;
      b.totalCs += cs;
      b.totalGameDurationMinutes += mins;

      await delay(60);
    } catch (err: any) {
      if (is429(err)) {
        console.error("❌ Rate limited (429) durante il fetch dei dettagli. Stop immediato.");
        break;
      }
      console.error("season_stats match error", id, err);
    }
  }

  const championsWithSortKey = Object.entries(championStats)
    .map(([champion, s]) => {
      const rawKda =
        s.totalDeaths > 0 ? (s.totalKills + s.totalAssists) / s.totalDeaths : Infinity;
      const winrate = s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0;

      return {
        champion,
        games: s.games,
        wins: s.wins,
        kills: s.totalKills,
        deaths: s.totalDeaths,
        assists: s.totalAssists,
        winrate,
        avgGold: s.games > 0 ? Math.round(s.totalGold / s.games) : 0,
        avgKda: s.totalDeaths > 0 ? rawKda.toFixed(2) : "Perfect",
        csPerMin:
          s.totalGameDurationMinutes > 0
            ? (s.totalCs / s.totalGameDurationMinutes).toFixed(2)
            : "0.00",
        sortGames: s.games,
        sortWinrate: winrate,
        sortKda: rawKda,
      };
    })
    .sort(
      (a, b) =>
        b.sortGames - a.sortGames ||
        b.sortWinrate - a.sortWinrate ||
        b.sortKda - a.sortKda
    )
    .map(({ sortGames, sortWinrate, sortKda, ...rest }) => rest);

  const seasonTotals = Object.values(championStats).reduce(
    (acc, s) => ({
      games: acc.games + s.games,
      wins: acc.wins + s.wins,
    }),
    { games: 0, wins: 0 }
  );

  return {
    topChampions: championsWithSortKey,
    seasonTotals,
    computedAt: Date.now(),
  };
}

export async function getSeasonStatsHandler(req: Request): Promise<Response> {
  const { puuid, region, queueGroup = "ranked_all" } = await req.json();
  if (!puuid || !region) return new Response("Missing puuid/region", { status: 400 });

  const { startTime } = getCurrentSeasonWindow();
  const startEpoch = Number.isFinite(startTime as number) ? (startTime as number) : 0;

  const limit = MAX_MATCHES_FOR_STATS;
  const cacheKey = buildCacheKey(puuid, startEpoch, queueGroup, limit);

  // 1) cache fresca
  const fresh = await readSeasonCache(cacheKey);
  if (fresh) return Response.json(fresh, { status: 200 });

  // 2) se c’è un job già in corso: NON far partire altro, rispondi 202 con Retry-After
  if (inFlight.has(cacheKey)) {
    return new Response(null, {
      status: 202,
      headers: { "Retry-After": "3" }, // seconds
    });
  }

  // 3) se ho stale, la do subito (così UI non resta vuota), e in parallelo rigenero
  const stale = await readStaleSeasonCache(cacheKey);
  if (stale) {
    const p = (async () => {
      const payload = await computeSeasonStats(puuid, region, queueGroup, limit);
      await writeSeasonCache(cacheKey, payload);
    })().finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, p);

    return Response.json({ ...stale, stale: true }, { status: 200 });
  }

  // 4) PRIMO HIT SENZA CACHE: calcolo SYNC e rispondo 200 (stop al polling infinito)
  const p = (async () => {
    const payload = await computeSeasonStats(puuid, region, queueGroup, limit);
    await writeSeasonCache(cacheKey, payload);
    return payload;
  })().finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, p);

  const payload = await p;
  return Response.json(payload, { status: 200 });
}
