// src/server/routes/getMatches.ts
import { getAccountByRiotId, getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";

function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

export async function getMatchesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, tag, region } = body;

    if (!name || !tag || !region) {
      console.error("Missing name, tag or region");
      return new Response("Missing name, tag or region", { status: 400 });
    }

    const account = await getAccountByRiotId(name, tag, region);

    // ✅ Solo ranked della season corrente, ma solo 10 ID (fast path)
    const { startTime, endTime } = getCurrentSeasonWindow();
    const ids = await getMatchIdsByPuuidOpts(account.puuid, region, {
      count: 10,              // mostriamo sempre 10 in pagina
      type: "ranked",         // ranked (copre 420/440)
      startTime,              // 29 Apr 2025 00:00:00 UTC = 1745884800
      endTime,                // opzionale, spesso undefined
    });

    const matchesWithWin: any[] = [];

    for (const matchId of ids) {
      try {
        const match = await getMatchDetails(matchId, region);

        // Normalizza endTimestamp per il componente
        const startTs = match.info.gameStartTimestamp ?? match.info.gameCreation;
        if (startTs && match.info.gameDuration) {
          match.info.gameEndTimestamp = startTs + match.info.gameDuration * 1000;
        }

        // Safety net: accetta solo ranked (420/440) e >= startTime
        const qid = match.info.queueId;
        if (qid !== 420 && qid !== 440) continue;
        if (startTime && startTs && Math.floor(startTs / 1000) < startTime) continue;

        const participant = match.info.participants.find((p: any) => p.puuid === account.puuid);
        if (!participant) continue;

        const championName = participant.championName ?? "Unknown";
        matchesWithWin.push({ match, win: !!participant.win, championName });

        // piccolo respiro per limit (10 chiamate => sei tranquillo)
        await delay(80);
      } catch (err) {
        console.error("❌ Errore nel match ID:", matchId, err);
      }
    }

    // Compat frontend: niente stats qui (arriveranno da /api/season_stats)
    return Response.json({
      matches: matchesWithWin,
      topChampions: [],      // placeholder per non rompere la UI esistente
      seasonTotals: null,    // idem
    });
  } catch (err) {
    console.error("❌ Errore nel backend:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
