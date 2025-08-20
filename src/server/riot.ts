// src/server/riot.ts
const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const REGION = "europe";

export class RateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message = "Riot rate limit", retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}



const regionRouting = {
  EUW: {
    account: "europe.api.riotgames.com",
    match: "europe.api.riotgames.com",
    platform: "euw1.api.riotgames.com",
  },
  NA: {
    account: "americas.api.riotgames.com",
    match: "americas.api.riotgames.com",
    platform: "na1.api.riotgames.com",
  },
  KR: {
    account: "asia.api.riotgames.com",
    match: "asia.api.riotgames.com",
    platform: "kr.api.riotgames.com",
  },
}



export async function getAccountByRiotId(name: string, tag: string, region: string) {
  const routing = regionRouting[region.toUpperCase()]
  const endpoint = `https://${routing.account}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`

  console.log("🔍 URL chiamato:", endpoint)

  const res = await fetch(endpoint, {
    headers: {
      "X-Riot-Token": RIOT_API_KEY,
    },
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error("❌ Account API failed:", res.status, errorText)
    throw new Error("Account not found")
  }

  return res.json()
}


// src/server/riot.ts

// 👇 opzionale: esponi il tipo per chiarezza
export type MatchIdQueryOpts = {
  start?: number;          // offset
  count?: number;          // <= 100 per call
  queue?: number;          // 420 solo, 440 flex
  type?: "ranked" | "normal" | "tourney" | "tutorial";
  startTime?: number;      // epoch sec
  endTime?: number;        // epoch sec
};

async function riotFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "X-Riot-Token": RIOT_API_KEY,
    },
  });

  if (res.status === 429) {
    // header è in secondi; se assente, metti una fallback “prudente”
    const ra = res.headers.get("Retry-After");
    const retryAfterMs = ra ? Number(ra) * 1000 : 10_000;
    const body = await res.text().catch(() => "");
    console.error("⚠️ Riot 429:", body || "(no body)");
    throw new RateLimitError("Riot rate limit", retryAfterMs);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`❌ Riot API ${res.status} @ ${url}:`, body);
    throw new Error(`Riot API ${res.status}`);
  }

  return res;
}

// -- esistente: lo lasciamo intatto per retrocompatibilità
export async function getMatchIdsByPuuid(puuid: string, region: string, count = 5) {
  const routing = regionRouting[region.toUpperCase()];
  const url = new URL(`https://${routing.match}/lol/match/v5/matches/by-puuid/${puuid}/ids`);
  url.searchParams.set("count", String(count));

  const res = await riotFetch(url.toString());
  return res.json();
}

// ✅ nuova variante con opzioni
export async function getMatchIdsByPuuidOpts(
  puuid: string,
  region: string,
  opts: MatchIdQueryOpts
): Promise<string[]> {
  const routing = regionRouting[region.toUpperCase()];
  const url = new URL(`https://${routing.match}/lol/match/v5/matches/by-puuid/${puuid}/ids`);
  if (opts.start != null) url.searchParams.set("start", String(opts.start));
  if (opts.count != null) url.searchParams.set("count", String(opts.count));
  if (opts.queue != null) url.searchParams.set("queue", String(opts.queue));
  if (opts.type) url.searchParams.set("type", opts.type);
  if (opts.startTime != null) url.searchParams.set("startTime", String(opts.startTime));
  if (opts.endTime != null) url.searchParams.set("endTime", String(opts.endTime));

  const res = await riotFetch(url.toString());
  return res.json() as Promise<string[]>;
}


export async function getRankedDataBySummonerId(summonerId: string, region: string) {
  const routing = regionRouting[region.toUpperCase()];
  if (!routing?.platform) throw new Error(`Unsupported region: ${region}`);

  const url = `https://${routing.platform}/lol/league/v4/entries/by-puuid/${summonerId}`;
  const res = await riotFetch(url);
  return res.json();
}

export async function getMatchDetails(matchId: string, region: string) {
  const routing = regionRouting[region.toUpperCase()];
  const url = `https://${routing.match}/lol/match/v5/matches/${matchId}`;
  const res = await riotFetch(url);
  return res.json();
}

export async function getMatchesWithWin(puuid: string, region: string, count = 5) {
  const matchIds: string[] = await getMatchIdsByPuuid(puuid, region, count)

  const matches = await Promise.all(
    matchIds.map(async (id) => {
      const match = await getMatchDetails(id, region)
      const participant = match.info.participants.find((p: any) => p.puuid === puuid)
      return {
        match,
        win: participant?.win ?? false,
      }
    })
  )

  return matches
}

export async function getLiveGameByPuuid(puuid: string, region: string) {
  const routing = regionRouting[region.toUpperCase()];
  const url = `https://${routing.platform}/lol/spectator/v5/active-games/by-summoner/${puuid}`;

  try {
    const res = await riotFetch(url);
    return res.json();
  } catch (e: any) {
    // se vuoi trattare 404 come "non live", sostituisci riotFetch con fetch+controllo 404
    if (e instanceof RateLimitError) throw e;
    return null;
  }
}

export async function getMatchTimeline(matchId: string, region: string) {
  const routing = regionRouting[region.toUpperCase()];
  const url = `https://${routing.match}/lol/match/v5/matches/${matchId}/timeline`;
  const res = await riotFetch(url);
  return res.json();
}

