// src/server/routes/leaderboard.ts
import {
  RateLimitError,
  QueueApi,
  getTopLadder,
  getSummonerByEncryptedId,
  getSummonerByPuuid,
  getAccountByPuuid,
} from "../riot";

const LADDER_TTL_MS = 60_000;      // cache lista base (CH+GM+M) 1 min
const ENRICH_TTL_MS = 3_600_000;   // cache enrichment 1 h
const CONCURRENCY = 2;             // prudente per 429
const MAX_ATTEMPTS = 3;            // retry per singolo player

type LadderCacheVal = { ts: number; body: any };
const ladderCache = new Map<string, LadderCacheVal>();

type EnrichVal = {
  ts: number;
  nametag: string | null;
  profileIconId: number | null;
  puuid: string | null;
};
// chiave: `${region}:puuid:${puuid}` oppure `${region}:sid:${summonerId}`
const enrichCache = new Map<string, EnrichVal>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const cur = idx++;
      if (cur >= arr.length) break;
      out[cur] = await fn(arr[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

async function withRetries<T>(op: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await op();
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        const wait = Math.max(1000, e.retryAfterMs ?? 1000);
        await sleep(wait);
      } else if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
      } else {
        throw e;
      }
    }
  }
}

export async function getLeaderboardHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const region = String(body.region ?? "EUW").toUpperCase();
    const queue: QueueApi = (body.queue ?? "RANKED_SOLO_5x5") as QueueApi;
    const pageReq = Math.max(1, Number(body.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize ?? 10)));   // 👈 default 10
    const search: string | undefined = body.search ? String(body.search) : undefined;
    const enrich = Boolean(body.enrich ?? true); // 👈 se false: NO enrichment (solo ids/base)

    const cacheKey = `${region}:${queue}`;
    const now = Date.now();

    // 1) base ladder cached
    let payload: any;
    const cached = ladderCache.get(cacheKey);
    if (cached && now - cached.ts < LADDER_TTL_MS) {
      payload = cached.body;
    } else {
      const entries = await getTopLadder(queue, region);
      payload = {
        region,
        queue,
        total: entries.length,
        rawEntries: entries.map((e: any, i: number) => ({
          rank: i + 1,
          // alcune entries hanno puuid, altre summonerId (encrypted)
          summonerId: e.summonerId ?? null,
          puuid: e.puuid ?? null,
          summonerName: e.summonerName ?? null, // legacy fallback
          leaguePoints: e.leaguePoints,
          wins: e.wins,
          losses: e.losses,
          winrate: e.winrate,
          tier: e.tier,
        })),
      };
      ladderCache.set(cacheKey, { ts: now, body: payload });
    }

    // 2) filtro server-side (sul legacy name) prima della paginazione
    let baseRows: any[] = payload.rawEntries;
    if (search) {
      const s = search.toLowerCase();
      baseRows = baseRows.filter(r => String(r.summonerName || "").toLowerCase().includes(s));
    }

    // 3) paging
    const total = baseRows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pageReq, totalPages);
    const start = (page - 1) * pageSize;
    const slice = baseRows.slice(start, start + pageSize);

    // 4) se enrich=false: ritorna il "grezzo" (nessuna call extra)
    if (!enrich) {
      return Response.json({
        region,
        queue,
        page,
        pageSize,
        total,
        totalPages,
        entries: slice.map((row) => ({
          rank: row.rank,
          leaguePoints: row.leaguePoints,
          wins: row.wins,
          losses: row.losses,
          winrate: row.winrate,
          tier: row.tier,
          // identità solo per enrichment client-initiated
          puuid: row.puuid ?? null,
          summonerId: row.summonerId ?? null,
          // nessun nametag/profileIconId qui
          nametag: null,
          profileIconId: null,
        })),
        cachedAt: new Date().toISOString(),
        ttlMs: LADDER_TTL_MS,
      });
    }

    // 5) enrichment SOLO per la pagina richiesta
    const enriched = await mapLimit(slice, CONCURRENCY, async (row) => {
      const baseOut = {
        rank: row.rank,
        leaguePoints: row.leaguePoints,
        wins: row.wins,
        losses: row.losses,
        winrate: row.winrate,
        tier: row.tier as "CHALLENGER" | "GRANDMASTER" | "MASTER",
        nametag: null as string | null,
        profileIconId: null as number | null,
        puuid: (row.puuid ?? null) as string | null,
        summonerId: (row.summonerId ?? null) as string | null,
      };

      const idKey =
        baseOut.puuid ? `puuid:${baseOut.puuid}` :
        baseOut.summonerId ? `sid:${baseOut.summonerId}` :
        `rank:${baseOut.rank}`;
      const enrichKey = `${region}:${idKey}`;

      const c = enrichCache.get(enrichKey);
      if (c && now - c.ts < ENRICH_TTL_MS) {
        return { ...baseOut, nametag: c.nametag, profileIconId: c.profileIconId, puuid: c.puuid ?? baseOut.puuid };
      }

      try {
        let nametag: string | null = null;
        let profileIconId: number | null = null;
        let puuid: string | null = baseOut.puuid;

        if (baseOut.puuid) {
          const summ = await withRetries(() => getSummonerByPuuid(baseOut.puuid!, region));
          profileIconId = summ?.profileIconId ?? null;

          const acc = await withRetries(() => getAccountByPuuid(baseOut.puuid!, region));
          nametag = acc?.gameName && acc?.tagLine ? `${acc.gameName}#${acc.tagLine}` : row.summonerName ?? null;
        } else if (baseOut.summonerId) {
          const summ = await withRetries(() => getSummonerByEncryptedId(baseOut.summonerId!, region));
          puuid = summ?.puuid ?? null;
          profileIconId = summ?.profileIconId ?? null;

          if (puuid) {
            const acc = await withRetries(() => getAccountByPuuid(puuid!, region));
            nametag = acc?.gameName && acc?.tagLine ? `${acc.gameName}#${acc.tagLine}` : row.summonerName ?? null;
          } else {
            nametag = row.summonerName ?? null;
          }
        } else {
          nametag = row.summonerName ?? null;
        }

        const out = { ...baseOut, nametag, profileIconId, puuid };
        enrichCache.set(enrichKey, { ts: Date.now(), nametag, profileIconId, puuid });
        return out;
      } catch {
        const out = { ...baseOut, nametag: row.summonerName ?? null };
        enrichCache.set(enrichKey, { ts: Date.now(), nametag: out.nametag, profileIconId: null, puuid: out.puuid });
        return out;
      }
    });

    return Response.json({
      region,
      queue,
      page,
      pageSize,
      total,
      totalPages,
      entries: enriched,
      cachedAt: new Date().toISOString(),
      ttlMs: LADDER_TTL_MS,
    });
  } catch (err: any) {
    if (err instanceof RateLimitError) {
      return new Response(
        JSON.stringify({ error: "rate_limited", retryAfterMs: err.retryAfterMs }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("Errore getLeaderboardHandler:", err);
    return new Response("Errore interno", { status: 500 });
  }
}
