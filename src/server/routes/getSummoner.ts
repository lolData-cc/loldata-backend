import { supabase } from '../supabase/client'

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
        }

        console.log("📦 Risposta summoner:", summoner)

        // Salvataggio normalizzato (lowercase)
        const { error } = await supabase.from("users").upsert({
            name: account.gameName.toLowerCase(),
            tag: account.tagLine.toLowerCase(),
            icon_id: summonerData.profileIconId,
            rank: soloQueue ? `${soloQueue.tier} ${soloQueue.rank}` : "Unranked",
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
