import { supabase } from '../supabase/client'
import { ingestQuickThenBackground } from '../services/matchIngest'

const regionRouting = {
    EUW: {
        account: "europe.api.riotgames.com",
        platform: "euw1.api.riotgames.com"
    },
    NA: {
        account: "americas.api.riotgames.com",
        platform: "na1.api.riotgames.com"
    },
    KR: {
        account: "asia.api.riotgames.com",
        platform: "kr.api.riotgames.com"
    }
}

function rankToScore(tier: string, division: string | undefined, lp: number): number {
    const tierOrder = [
        "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
        "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"
    ]
    const divisionOrder: Record<string, number> = {
        "IV": 1,
        "III": 2,
        "II": 3,
        "I": 4,
    }

    const base = tierOrder.indexOf(tier.toUpperCase()) * 1000
    const divisionScore = division ? (divisionOrder[division.toUpperCase()] ?? 0) : 0
    return base + divisionScore * 100 + lp
}
export async function getSummonerHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { name, tag, region } = body
    if (!name || !tag || !region) {
      return new Response("Missing name, tag or region", { status: 400 })
    }

    const routing = regionRouting[region.toUpperCase()]
    if (!routing) return new Response("Invalid region", { status: 400 })

    const RIOT_API_KEY = process.env.RIOT_API_KEY
    if (!RIOT_API_KEY) throw new Error("Missing Riot API key")

    const nameLower = name.toLowerCase()
    const tagLower  = tag.toLowerCase()

    // 0) Global cooldown check — if updated within 180s, return cached data
    const COOLDOWN_S = 180
    {
      const { data: cachedUser } = await supabase
        .from("users")
        .select("name, tag, puuid, icon_id, rank, lp, peak_rank, peak_lp, flex_rank, flex_lp, peak_flex_rank, peak_flex_lp, last_searched_at, region")
        .eq("name", name).eq("tag", tag)
        .single()

      if (cachedUser?.last_searched_at) {
        const elapsed = (Date.now() - new Date(cachedUser.last_searched_at).getTime()) / 1000
        if (elapsed < COOLDOWN_S) {
          // Fetch avatar_url for cached response
          let avatarUrl: string | null = null
          if (cachedUser.puuid) {
            const { data: row } = await supabase
              .from("profile_players")
              .select("avatar_url")
              .eq("puuid", cachedUser.puuid)
              .maybeSingle()
            avatarUrl = row?.avatar_url ?? null
          }

          const summoner = {
            name: cachedUser.name,
            puuid: cachedUser.puuid,
            tag: cachedUser.tag,
            rank: cachedUser.rank ?? "Unranked",
            lp: cachedUser.lp ?? 0,
            wins: 0,
            losses: 0,
            profileIconId: cachedUser.icon_id,
            level: 0,
            live: false,
            peakRank: cachedUser.peak_rank ?? "Unranked",
            peakLp: cachedUser.peak_lp ?? 0,
            flexRank: cachedUser.flex_rank ?? "Unranked",
            flexLp: cachedUser.flex_lp ?? 0,
            peakFlexRank: cachedUser.peak_flex_rank ?? "Unranked",
            peakFlexLp: cachedUser.peak_flex_lp ?? 0,
            avatar_url: avatarUrl,
          }

          return Response.json({
            summoner,
            saved: true,
            cooldownRemaining: Math.ceil(COOLDOWN_S - elapsed),
          })
        }
      }
    }

    // 1) Account -> PUUID
    const accountRes = await fetch(
      `https://${routing.account}/riot/account/v1/accounts/by-riot-id/${nameLower}/${tagLower}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    )
    if (!accountRes.ok) {
      const err = await accountRes.text()
      console.error("❌ Errore account:", err)
      return new Response("Errore nella richiesta account", { status: 500 })
    }
    const account = await accountRes.json()

    // 2-4) Summoner profile, Live, Ranked — ALL IN PARALLEL
    const [summonerRes, liveRes, rankedRes] = await Promise.all([
      fetch(
        `https://${routing.platform}/lol/summoner/v4/summoners/by-puuid/${account.puuid}`,
        { headers: { "X-Riot-Token": RIOT_API_KEY } }
      ),
      fetch(
        `https://${routing.platform}/lol/spectator/v5/active-games/by-summoner/${account.puuid}`,
        { headers: { "X-Riot-Token": RIOT_API_KEY } }
      ),
      fetch(
        `https://${routing.platform}/lol/league/v4/entries/by-puuid/${account.puuid}`,
        { headers: { "X-Riot-Token": RIOT_API_KEY } }
      ),
    ])

    if (!summonerRes.ok) {
      const err = await summonerRes.text()
      console.error("❌ Errore profilo:", err)
      return new Response("Errore nella richiesta profilo", { status: 500 })
    }
    const summonerData = await summonerRes.json()

    const isLive = liveRes.status === 200

    if (!rankedRes.ok) {
      const err = await rankedRes.text()
      console.error("❌ Errore ranked:", err)
      return new Response("Errore nella richiesta ranked", { status: 500 })
    }
    const rankedData = await rankedRes.json()
    const soloQueue = rankedData.find((e: any) => e.queueType === "RANKED_SOLO_5x5")
    const flexQueue = rankedData.find((e: any) => e.queueType === "RANKED_FLEX_SR")

    // ---- Parallel: profile sync + avatar fetch + peak rank fetch ----
    const nametag = `${account.gameName}#${account.tagLine}`

    // Fire-and-forget profile sync (non-blocking)
    supabase
      .from("profile_players")
      .update({ puuid: account.puuid })
      .eq("nametag", nametag)
      .eq("region", region.toLowerCase())
      .is("puuid", null)
      .then(({ error }) => { if (error) console.warn("⚠️ update puuid:", error.message) })

    supabase
      .from("profile_players")
      .update({ nametag })
      .eq("puuid", account.puuid)
      .neq("nametag", nametag)
      .then(({ error }) => { if (error) console.warn("⚠️ update nametag:", error.message) })

    // Parallel: avatar + peak rank
    const [avatarResult, peakResult] = await Promise.all([
      // Avatar: try by puuid first, fall back to nametag
      supabase
        .from("profile_players")
        .select("avatar_url")
        .eq("puuid", account.puuid)
        .maybeSingle()
        .then(async ({ data, error }) => {
          if (error) console.warn("⚠️ select avatar by puuid:", error.message)
          if (data?.avatar_url) return data.avatar_url
          // Fallback
          const { data: rowByName, error: e2 } = await supabase
            .from("profile_players")
            .select("avatar_url")
            .eq("nametag", nametag)
            .eq("region", region.toLowerCase())
            .maybeSingle()
          if (e2) console.warn("⚠️ select avatar by nametag:", e2.message)
          return rowByName?.avatar_url ?? null
        }),
      // Peak rank
      supabase
        .from("users")
        .select("peak_rank, peak_lp, peak_flex_rank, peak_flex_lp")
        .eq("name", account.gameName)
        .eq("tag", account.tagLine)
        .single(),
    ])

    const avatarUrl: string | null = avatarResult
    const existingUser = peakResult.data

    // Peak rank logic
    let peakRank = soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked"
    let peakLP   = soloQueue?.leaguePoints ?? 0
    let peakFlexRank = flexQueue ? `${flexQueue.tier} ${flexQueue.rank}` : "Unranked"
    let peakFlexLP   = flexQueue?.leaguePoints ?? 0

    {

      // Solo peak
      if (soloQueue && existingUser?.peak_rank) {
        const [savedTier, savedDivision] = existingUser.peak_rank.split(" ")
        const savedLP = existingUser.peak_lp ?? 0
        const currentScore = rankToScore(soloQueue.tier, soloQueue.rank, soloQueue.leaguePoints)
        const savedScore   = rankToScore(savedTier, savedDivision, savedLP)
        if (savedScore >= currentScore) {
          peakRank = existingUser.peak_rank
          peakLP   = savedLP
        }
      }

      // Flex peak
      if (flexQueue && existingUser?.peak_flex_rank) {
        const [savedTier, savedDivision] = existingUser.peak_flex_rank.split(" ")
        const savedLP = existingUser.peak_flex_lp ?? 0
        const currentScore = rankToScore(flexQueue.tier, flexQueue.rank, flexQueue.leaguePoints)
        const savedScore   = rankToScore(savedTier, savedDivision, savedLP)
        if (savedScore >= currentScore) {
          peakFlexRank = existingUser.peak_flex_rank
          peakFlexLP   = savedLP
        }
      }
    }

    // Risposta al frontend (🔸 includo avatar_url)
    const summoner = {
      name:  account.gameName,
      puuid: account.puuid,
      tag:   account.tagLine,
      rank:  soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked",
      lp:    soloQueue?.leaguePoints ?? 0,
      wins:  soloQueue?.wins ?? 0,
      losses: soloQueue?.losses ?? 0,
      profileIconId: summonerData.profileIconId,
      level:         summonerData.summonerLevel,
      live:          isLive,
      peakRank,
      peakLp: peakLP,
      flexRank: flexQueue ? `${flexQueue.tier} ${flexQueue.rank}` : "Unranked",
      flexLp:   flexQueue?.leaguePoints ?? 0,
      peakFlexRank: peakFlexRank,
      peakFlexLp:   peakFlexLP,
      avatar_url: avatarUrl, // ← NEW
    }

    // Upsert utente (come prima)
    const { error } = await supabase.from("users").upsert({
      name:  account.gameName,
      tag:   account.tagLine,
      puuid: account.puuid,
      icon_id:  summonerData.profileIconId,
      rank:     summoner.rank,
      lp:       soloQueue?.leaguePoints ?? 0,
      peak_rank: peakRank,
      peak_lp:   peakLP,
      flex_rank: summoner.flexRank,
      flex_lp:   flexQueue?.leaguePoints ?? 0,
      peak_flex_rank: peakFlexRank,
      peak_flex_lp:   peakFlexLP,
      last_searched_at: new Date().toISOString(),
      region: region.toUpperCase(),
    }, { onConflict: 'name,tag' })
    if (error) console.error("❌ Errore salvataggio Supabase:", error.message)

    // Fire ingestion in background — don't block the summoner response.
    // The frontend polls /api/matches with ingesting flag until matches appear.
    ingestQuickThenBackground(account.puuid, region).catch((e) =>
      console.error("⚠️ Quick ingestion error:", e)
    );

    return Response.json({ summoner, saved: true, cooldownRemaining: COOLDOWN_S })

  } catch (err) {
    console.error("Errore in getSummonerHandler:", err)
    return new Response("Errore interno", { status: 500 })
  }
}