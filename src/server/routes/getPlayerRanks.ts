import { supabaseAdmin } from "../supabase/client";

const RIOT_API_KEY = process.env.RIOT_API_KEY!;

const regionRouting: Record<string, string> = {
  EUW: "euw1.api.riotgames.com",
  NA: "na1.api.riotgames.com",
  KR: "kr.api.riotgames.com",
};

// Cache ranks for 10 minutes
const rankCache = new Map<string, { rank: string; lp: number; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchRankForPuuid(puuid: string, platform: string): Promise<{ rank: string; lp: number } | null> {
  const cached = rankCache.get(puuid);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return { rank: cached.rank, lp: cached.lp };

  const region = platform.toUpperCase().replace("1", "");
  const host = regionRouting[region] ?? regionRouting.EUW;

  try {
    const res = await fetch(
      `https://${host}/lol/league/v4/entries/by-puuid/${puuid}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );
    if (!res.ok) return null;

    const entries = await res.json();
    const solo = entries.find((e: any) => e.queueType === "RANKED_SOLO_5x5");

    const result = solo
      ? { rank: `${solo.tier} ${solo.rank}`, lp: solo.leaguePoints }
      : { rank: "Unranked", lp: 0 };

    rankCache.set(puuid, { ...result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

export async function getPlayerRanksHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { puuids, region } = body;

    if (!Array.isArray(puuids) || puuids.length === 0) {
      return Response.json({ ranks: {} });
    }

    const limited = puuids.slice(0, 10);
    const platform = region ?? "EUW";

    // Fetch all 10 in parallel from Riot
    const results = await Promise.allSettled(
      limited.map(async (puuid: string) => {
        const r = await fetchRankForPuuid(puuid, platform);
        return r ? { puuid, ...r } : null;
      })
    );

    const ranks: Record<string, { rank: string; lp: number }> = {};
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        ranks[r.value.puuid] = { rank: r.value.rank, lp: r.value.lp };
      }
    }

    return Response.json({ ranks });
  } catch (err) {
    console.error("❌ getPlayerRanks error:", err);
    return Response.json({ ranks: {} });
  }
}
