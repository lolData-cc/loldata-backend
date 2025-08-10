// src/server/routes/getMatches.ts
import { getAccountByRiotId, getMatchIdsByPuuid, getMatchDetails } from "../riot"

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function getMatchesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { name, tag, region } = body

    if (!name || !tag || !region) {
  console.error("Missing name, tag or region")
  return new Response("Missing name, tag or region", { status: 400 })
}

    const account = await getAccountByRiotId(name, tag, region)
    const matchIds = await getMatchIdsByPuuid(account.puuid, region, 10)

    const matchesWithWin = []
    const championStats: Record<string, {
      games: number
      wins: number
      totalGold: number
      totalKills: number
      totalDeaths: number
      totalAssists: number
      totalCs: number
      totalGameDurationMinutes: number
    }> = {}

    for (const matchId of matchIds) {
      try {
        const match = await getMatchDetails(matchId, region)

        const startTs = match.info.gameStartTimestamp ?? match.info.gameCreation;
        if (startTs && match.info.gameDuration) {
          match.info.gameEndTimestamp = startTs + match.info.gameDuration * 1000;
        }

        const participant = match.info.participants.find(
          (p: any) => p.puuid === account.puuid
        )

        if (!participant) continue

        const {
          win,
          championName = "Unknown",
          goldEarned = 0,
          kills = 0,
          deaths = 0,
          assists = 0,
          totalMinionsKilled = 0,
          neutralMinionsKilled = 0,
        } = participant

        const cs = totalMinionsKilled + neutralMinionsKilled
        const gameDurationMinutes = (match.info.gameDuration ?? 0) / 60

        if (!championStats[championName]) {
          championStats[championName] = {
            games: 0,
            wins: 0,
            totalGold: 0,
            totalKills: 0,
            totalDeaths: 0,
            totalAssists: 0,
            totalCs: 0,
            totalGameDurationMinutes: 0
          }
        }

        const stats = championStats[championName]
        stats.games += 1
        if (win) stats.wins += 1
        stats.totalGold += goldEarned
        stats.totalKills += kills
        stats.totalDeaths += deaths
        stats.totalAssists += assists
        stats.totalCs += cs
        stats.totalGameDurationMinutes += gameDurationMinutes

        matchesWithWin.push({ match, win, championName })

        await delay(150) // 🔁 Respects rate limits
      } catch (err) {
        console.error("❌ Errore nel match ID:", matchId, err)
      }
    }

    const championsWithSortKey = Object.entries(championStats).map(([champion, stats]) => {
      const rawKda = stats.totalDeaths > 0
        ? (stats.totalKills + stats.totalAssists) / stats.totalDeaths
        : Infinity

      const winrate = Math.round((stats.wins / stats.games) * 100)

      return {
        champion,
        games: stats.games,
        wins: stats.wins,
        kills: stats.totalKills,
        deaths: stats.totalDeaths,
        assists: stats.totalAssists,
        winrate,
        avgGold: Math.round(stats.totalGold / stats.games),
        avgKda: stats.totalDeaths > 0 ? rawKda.toFixed(2) : "Perfect",
        csPerMin: (stats.totalCs / stats.totalGameDurationMinutes).toFixed(2),
        sortGames: stats.games,
        sortWinrate: winrate,
        sortKda: rawKda
      }
    })

    championsWithSortKey.sort((a, b) => {
      if (b.sortGames !== a.sortGames) return b.sortGames - a.sortGames
      if (b.sortWinrate !== a.sortWinrate) return b.sortWinrate - a.sortWinrate
      return b.sortKda - a.sortKda
    })

    const topChampions = championsWithSortKey.map(({ sortGames, sortWinrate, sortKda, ...rest }) => rest)




    return Response.json({ matches: matchesWithWin, topChampions })
  } catch (err) {
    console.error("❌ Errore nel backend:", err)
    return new Response("Internal server error", { status: 500 })
  }
}
