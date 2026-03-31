// src/server/routes/getChampionOtpRanking.ts
// Returns top 50 OTP players for a given champion, per region, ordered by LP.
// Queries participants table directly (has all 104k+ matches).
// An OTP has >= 25% of their ranked games on that champion with >= 5 games minimum.

import { supabaseAdmin } from "../supabase/client";
import { getAccountByPuuid, getRankedDataBySummonerId } from "../riot";
// Season window not needed — all data from DB

const OTP_THRESHOLD = 0.25;
const MIN_CHAMP_GAMES = 5;
const LIMIT = 50;

const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getChampionOtpRankingHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { championName, region } = body;

    if (!championName) {
      return new Response("Missing championName", { status: 400 });
    }

    const regionKey = (region ?? "ALL").toUpperCase();

    // Always compute/cache ALL first, then filter by region
    const allCacheKey = `${championName}:ALL`;
    let allCached = cache.get(allCacheKey);
    if (!allCached || Date.now() - allCached.ts >= CACHE_TTL) {
      const allResponse = await fallbackOtpRanking(championName, "ALL", allCacheKey);
      const allData = await allResponse.json();
      cache.set(allCacheKey, { data: allData, ts: Date.now() });
      allCached = cache.get(allCacheKey)!;
    }

    if (regionKey === "ALL") {
      return Response.json(allCached.data);
    }

    // Filter ALL results by region
    const filtered = (allCached.data.players ?? [])
      .filter((p: any) => (p.region ?? "").toUpperCase() === regionKey)
      .map((p: any, i: number) => ({ ...p, rank: i + 1 }));

    return Response.json({
      champion: championName,
      region: regionKey,
      players: filtered,
      totalOtps: filtered.length,
    });

  } catch (err) {
    console.error("OTP ranking error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}

/** Main implementation using raw Supabase queries */
async function fallbackOtpRanking(championName: string, regionKey: string, cacheKey?: string): Promise<Response> {
  // Step 1: Get all puuids who played this champion with aggregated stats
  // Increase limit to get all matches (default is 1000)
  const { data: champRows, error: e1 } = await supabaseAdmin
    .from("participants")
    .select("puuid, match_id, win, kills, deaths, assists, perk_keystone, perk_sub_style, summoner_name")
    .eq("champion_name", championName)
    .not("puuid", "is", null)
    .limit(50000);

  if (e1 || !champRows || champRows.length === 0) {
    return Response.json({ champion: championName, region: regionKey, players: [], totalOtps: 0 });
  }

  // Extract region from match ID prefix (EUW1_xxx → EUW, NA1_xxx → NA, KR_xxx → KR)
  const MATCH_PREFIX_TO_REGION: Record<string, string> = {
    EUW1: "EUW", EUW: "EUW", NA1: "NA", NA: "NA", KR: "KR",
  };
  function regionFromMatchId(matchId: string): string {
    const prefix = (matchId ?? "").split("_")[0]?.toUpperCase() ?? "";
    return MATCH_PREFIX_TO_REGION[prefix] ?? "EUW";
  }

  // Aggregate per puuid
  const champAgg = new Map<string, {
    games: number; wins: number; kills: number; deaths: number; assists: number;
    keystones: Map<string, number>;
    lastSummonerName: string;
    region: string;
  }>();

  for (const r of champRows) {
    if (!r.puuid) continue;
    let agg = champAgg.get(r.puuid);
    if (!agg) {
      agg = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, keystones: new Map(), lastSummonerName: "", region: "" };
      champAgg.set(r.puuid, agg);
    }
    agg.games++;
    if (r.win) agg.wins++;
    agg.kills += r.kills ?? 0;
    agg.deaths += r.deaths ?? 0;
    agg.assists += r.assists ?? 0;
    if (r.summoner_name) agg.lastSummonerName = r.summoner_name;
    if (r.match_id && !agg.region) agg.region = regionFromMatchId(r.match_id);
    if (r.perk_keystone) {
      const key = `${r.perk_keystone}:${r.perk_sub_style ?? 0}`;
      agg.keystones.set(key, (agg.keystones.get(key) ?? 0) + 1);
    }
  }

  // Filter: min games
  const qualifiedPuuids = [...champAgg.entries()]
    .filter(([, a]) => a.games >= MIN_CHAMP_GAMES)
    .map(([puuid]) => puuid);

  if (qualifiedPuuids.length === 0) {
    return Response.json({ champion: championName, region: regionKey, players: [], totalOtps: 0 });
  }

  // Step 2: Get total games per puuid (all champions)
  // Batch in chunks to avoid query size limits
  const { data: totalRows } = await supabaseAdmin
    .from("participants")
    .select("puuid")
    .in("puuid", qualifiedPuuids)
    .limit(100000);

  const totalGamesMap = new Map<string, number>();
  for (const r of totalRows ?? []) {
    if (!r.puuid) continue;
    totalGamesMap.set(r.puuid, (totalGamesMap.get(r.puuid) ?? 0) + 1);
  }

  // Step 3: Filter OTPs
  const otpPuuids = qualifiedPuuids.filter(puuid => {
    const champGames = champAgg.get(puuid)?.games ?? 0;
    const total = totalGamesMap.get(puuid) ?? 0;
    return total > 0 && (champGames / total) >= OTP_THRESHOLD;
  });

  if (otpPuuids.length === 0) {
    return Response.json({ champion: championName, region: regionKey, players: [], totalOtps: 0 });
  }

  // Step 4: Get user info — always fetch ALL regions from users table (don't filter region here)
  const { data: userRows } = await supabaseAdmin
    .from("users")
    .select("puuid, name, tag, rank, lp, region, icon_id")
    .in("puuid", otpPuuids);

  const userMap = new Map((userRows ?? []).map(u => [u.puuid, u]));

  // Region map: already resolved from match_id prefix during aggregation step
  const puuidRegionMap = new Map<string, string>();
  for (const [puuid, agg] of champAgg) {
    if (agg.region) puuidRegionMap.set(puuid, agg.region);
  }
  // Override with users table if available
  for (const puuid of otpPuuids) {
    const user = userMap.get(puuid);
    if (user?.region) puuidRegionMap.set(puuid, user.region.toUpperCase());
  }

  // Step 5: Build ranked list for ALL OTPs first (region filter applied AFTER rank resolution)
  const MASTER_PLUS = new Set(["CHALLENGER", "GRANDMASTER", "MASTER"]);
  const players = otpPuuids
    .map(puuid => {
      const agg = champAgg.get(puuid);
      const total = totalGamesMap.get(puuid) ?? 0;
      if (!agg) return null;

      const user = userMap.get(puuid);

      // Most common keystone
      let bestKeystoneKey = "", maxCount = 0;
      for (const [k, v] of agg.keystones) {
        if (v > maxCount) { bestKeystoneKey = k; maxCount = v; }
      }
      const [ks, ss] = bestKeystoneKey ? bestKeystoneKey.split(":").map(Number) : [null, null];

      // Use users table data if available, fallback to participant summoner_name
      const rawName = user?.name ?? (agg as any).lastSummonerName ?? "";
      // summoner_name from Riot often has format "GameName" (no tag)
      const name = rawName || "Unknown";
      const tag = user?.tag ?? "";
      const rankParts = (user?.rank ?? "Unranked").split(" ");
      const tier = rankParts[0] ?? "Unranked";

      return {
        puuid,
        name,
        tag,
        tier,
        lp: user?.lp ?? 0,
        profileIconId: user?.icon_id ?? 29,
        champGames: agg.games,
        champWins: agg.wins,
        champWinrate: agg.games > 0 ? Math.round((agg.wins / agg.games) * 1000) / 10 : 0,
        totalGames: total,
        champPlayrate: total > 0 ? Math.round((agg.games / total) * 1000) / 10 : 0,
        avgKills: agg.games > 0 ? Math.round((agg.kills / agg.games) * 10) / 10 : 0,
        avgDeaths: agg.games > 0 ? Math.round((agg.deaths / agg.games) * 10) / 10 : 0,
        avgAssists: agg.games > 0 ? Math.round((agg.assists / agg.games) * 10) / 10 : 0,
        kda: agg.deaths > 0 ? Math.round(((agg.kills + agg.assists) / agg.deaths) * 100) / 100 : 99,
        keystone: ks,
        secondaryStyle: ss,
        region: puuidRegionMap.get(puuid) ?? user?.region ?? "",
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const tierWeight = (t: string) => {
        const order = ["CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND", "EMERALD", "PLATINUM", "GOLD", "SILVER", "BRONZE", "IRON"];
        const idx = order.indexOf(t.toUpperCase());
        return idx === -1 ? 999 : idx;
      };
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      return b.lp - a.lp;
    })
    .slice(0, LIMIT)
    .map((p: any, i: number) => ({ ...p, rank: i + 1 }));

  // Step 6: Resolve names + ranks for players NOT in users table
  // This is deterministic: resolve ALL missing players (not a random subset)
  const playersNeedingInfo = players.filter((p: any) =>
    (!p.name || p.name === "Unknown") || p.tier === "Unranked"
  );

  // Resolve ALL of them (not just first 30) — but use the player's known region
  if (playersNeedingInfo.length > 0) {
    const resolveResults = await Promise.allSettled(
      playersNeedingInfo.map(async (p: any) => {
        const result: any = { puuid: p.puuid };
        const reg = p.region || "EUW";

        // Resolve name
        if (!p.name || p.name === "Unknown") {
          try {
            const acc = await getAccountByPuuid(p.puuid, reg);
            result.name = acc.gameName;
            result.tag = acc.tagLine;
          } catch { /* skip */ }
        }

        // Resolve rank
        if (p.tier === "Unranked") {
          try {
            const ranked = await getRankedDataBySummonerId(p.puuid, reg);
            const solo = ranked.find?.((e: any) => e.queueType === "RANKED_SOLO_5x5");
            if (solo) {
              result.tier = solo.tier;
              result.lp = solo.leaguePoints;
            }
          } catch { /* skip */ }
        }

        return result;
      })
    );

    for (const r of resolveResults) {
      if (r.status === "fulfilled" && r.value) {
        const p = players.find((x: any) => x.puuid === r.value.puuid);
        if (p) {
          if (r.value.name) (p as any).name = r.value.name;
          if (r.value.tag) (p as any).tag = r.value.tag;
          if (r.value.tier) (p as any).tier = r.value.tier;
          if (r.value.lp != null) (p as any).lp = r.value.lp;

          // Persist to users table (fire-and-forget)
          const finalName = r.value.name || (p as any).name;
          const finalTag = r.value.tag || (p as any).tag;
          const finalTier = r.value.tier || (p as any).tier;
          if (finalName && finalTag && finalTier !== "Unranked") {
            supabaseAdmin.from("users").upsert({
              puuid: p.puuid,
              name: finalName,
              tag: finalTag,
              rank: `${finalTier} I`,
              lp: r.value.lp ?? (p as any).lp ?? 0,
              region: (p as any).region || "EUW",
            }, { onConflict: "name,tag" }).then(() => {});
          }
        }
      }
    }

    // Re-sort after resolution
    players.sort((a: any, b: any) => {
      const tierWeight = (t: string) => {
        const order = ["CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND", "EMERALD", "PLATINUM", "GOLD", "SILVER", "BRONZE", "IRON"];
        const idx = order.indexOf(t?.toUpperCase?.() ?? "");
        return idx === -1 ? 999 : idx;
      };
      const tw = tierWeight(a.tier) - tierWeight(b.tier);
      if (tw !== 0) return tw;
      return b.lp - a.lp;
    });
    players.forEach((p: any, i: number) => { p.rank = i + 1; });
  }

  // Filter: only Master+ players, then apply region filter
  const masterPlusPlayers = players
    .filter((p: any) => MASTER_PLUS.has(p.tier?.toUpperCase?.()))
    .filter((p: any) => {
      if (regionKey === "ALL") return true;
      const pRegion = (p.region || puuidRegionMap.get(p.puuid) || "").toUpperCase();
      return pRegion === regionKey.toUpperCase();
    })
    .map((p: any, i: number) => ({ ...p, rank: i + 1 }));

  // Runes + items come from DB (perk_keystone, perk_sub_style columns populated by cron)
  // No Riot API calls needed — data is deterministic from DB.

  const result = {
    champion: championName,
    region: regionKey,
    players: masterPlusPlayers,
    totalOtps: masterPlusPlayers.length,
  };

  if (cacheKey) cache.set(cacheKey, { data: result, ts: Date.now() });
  return Response.json(result);
}
