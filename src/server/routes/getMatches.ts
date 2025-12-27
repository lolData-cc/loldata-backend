// src/server/routes/getMatches.ts
import { getAccountByRiotId, getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";

function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }

const MAX_TOTAL = 30; // tetto assoluto: dopo 30 stop

export async function getMatchesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, tag, region } = body;

    // nuovi parametri per paging
    const offset = Math.max(0, Number(body?.offset ?? 0));       // 0, 10, 20...
    const limitReq = Math.max(1, Number(body?.limit ?? 10));     // default 10
    const limit = Math.min(10, limitReq);  
    


    if (!name || !tag || !region) {
      console.error("Missing name, tag or region");
      return new Response("Missing name, tag or region", { status: 400 });
    }

    // se abbiamo già servito 30 o più, fermiamoci
    if (offset >= MAX_TOTAL) {  
      return Response.json({
        matches: [],
        topChampions: [],
        seasonTotals: null,
        hasMore: false,
        nextOffset: offset
      });
    }

    const account = await getAccountByRiotId(name, tag, region);

    // Solo ranked della season corrente (420/440)
    const { startTime, endTime } = getCurrentSeasonWindow();

    // Calcola quanti possiamo ancora servire senza superare MAX_TOTAL
    const remaining = Math.max(0, MAX_TOTAL - offset);
    const count = Math.min(limit, remaining);

    // usa start/count per paginare
    const ids = await getMatchIdsByPuuidOpts(account.puuid, region, {
      start: offset,     // 0 per 1–10, 10 per 11–20, 20 per 21–30
      count,             // fino a 10
      type: "ranked",    // ranked (copre 420/440)
      startTime,
      endTime,
    });

    const matchesWithWin: any[] = [];

    for (const matchId of ids) {
      try {
        const match = await getMatchDetails(matchId, region);

        // Normalizza endTimestamp per il frontend
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

        // piccolo respiro per non stressare i rate limit
        await delay(80);
      } catch (err) {
        console.error("❌ Errore nel match ID:", matchId, err);
      }
    }

    const served = matchesWithWin.length;
    const nextOffset = offset + served;

    // hasMore: se abbiamo servito il "pieno" richiesto e non abbiamo superato MAX_TOTAL
    const hasMore = nextOffset < MAX_TOTAL && served === count;

    return Response.json({
      matches: matchesWithWin,
      topChampions: [],      // compat con UI esistente
      seasonTotals: null,    // compat con UI esistente
      hasMore,
      nextOffset,
    });
  } catch (err) {
    console.error("❌ Errore nel backend:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
