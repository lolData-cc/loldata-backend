import { supabase } from '../supabase/client'

function rankToScore(tier: string, division: string, lp: number): number {
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
    const divisionScore = divisionOrder[division.toUpperCase()] ?? 0
    return base + divisionScore * 100 + lp // division pesa 100, lp è minore
}

export async function getSummonerHandler(req: Request): Promise<Response> {
    try {
        const body = await req.json()
        const { name, tag } = body

        if (!name || !tag) {
            return new Response("Missing name or tag", { status: 400 })
        }

        const RIOT_API_KEY = process.env.RIOT_API_KEY
        if (!RIOT_API_KEY) throw new Error("Missing Riot API key")

        // Normalizza input per fetch
        const nameLower = name.toLowerCase()
        const tagLower = tag.toLowerCase()

        // Step 1: prendi il puuid
        const accountRes = await fetch(
            `https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${nameLower}/${tagLower}`,
            {
                headers: {
                    "X-Riot-Token": RIOT_API_KEY,
                },
            }
        )

        if (!accountRes.ok) {
            const err = await accountRes.text()
            console.error("❌ Errore account:", err)
            return new Response("Errore nella richiesta account", { status: 500 })
        }

        const account = await accountRes.json()

        const summonerRes = await fetch(
            `https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`,
            {
                headers: {
                    "X-Riot-Token": RIOT_API_KEY,
                },
            }
        )

        if (!summonerRes.ok) {
            const err = await summonerRes.text()
            console.error("❌ Errore profilo:", err)
            return new Response("Errore nella richiesta profilo", { status: 500 })
        }

        const summonerData = await summonerRes.json()

        const liveRes = await fetch(
            `https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${account.puuid}`,
            {
                headers: {
                    "X-Riot-Token": RIOT_API_KEY,
                },
            }
        )

        console.log("🎮 Spectator response:", liveRes.status, await liveRes.text())

        const isLive = liveRes.status === 200

        const rankedRes = await fetch(
            `https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`,
            {
                headers: {
                    "X-Riot-Token": RIOT_API_KEY,
                },
            }
        )

        if (!rankedRes.ok) {
            const err = await rankedRes.text()
            console.error("❌ Errore ranked:", err)
            return new Response("Errore nella richiesta ranked", { status: 500 })
        }

        const rankedData = await rankedRes.json()
        const soloQueue = rankedData.find((entry: any) => entry.queueType === "RANKED_SOLO_5x5")



        let peakRank = soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked"
        let peakLP = soloQueue?.leaguePoints ?? 0

        if (soloQueue) {
            const { data: existingUser, error: fetchError } = await supabase
                .from("users")
                .select("peak_rank, peak_lp")
                .eq("name", account.gameName)
                .eq("tag", account.tagLine)
                .single()

            if (!fetchError && existingUser?.peak_rank) {
                const [savedTier, savedDivision] = existingUser.peak_rank.split(" ")
                const savedLP = existingUser.peak_lp ?? 0

                const currentScore = rankToScore(soloQueue.tier, soloQueue.rank, soloQueue.leaguePoints)
                const savedScore = rankToScore(savedTier, savedDivision, savedLP)

                if (savedScore >= currentScore) {
                    peakRank = existingUser.peak_rank
                    peakLP = savedLP
                }
            }
        }



        const summoner = {
            name: account.gameName,
            puuid: account.puuid,
            tag: account.tagLine,
            rank: soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked",
            lp: soloQueue?.leaguePoints ?? 0,
            wins: soloQueue?.wins ?? 0,
            losses: soloQueue?.losses ?? 0,
            profileIconId: summonerData.profileIconId,
            level: summonerData.summonerLevel,
            live: isLive,
            peakRank: peakRank,
            peakLp: peakLP,
        }

        const { error } = await supabase.from("users").upsert({
            name: account.gameName,
            tag: account.tagLine,
            icon_id: summonerData.profileIconId,
            rank: soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked",
            peak_rank: peakRank,
            peak_lp: peakLP,
            last_searched_at: new Date().toISOString(),
        }, {
            onConflict: 'name,tag',
        })

        if (error) {
            console.error("❌ Errore salvataggio Supabase:", error.message)
        }


        return Response.json({ summoner, saved: true })

    } catch (err) {
        console.error("Errore in getSummonerHandler:", err)
        return new Response("Errore interno", { status: 500 })
    }
}
