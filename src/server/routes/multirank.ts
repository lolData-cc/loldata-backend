// src/server/routes/multirank.ts
import { getAccountByRiotId, getRankedDataBySummonerId } from "../riot"

export async function getMultiRankHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { riotIds, region } = body as { riotIds: string[]; region: string }

    if (!riotIds || !Array.isArray(riotIds)) {
      return new Response("Invalid riotIds", { status: 400 })
    }

    const results = await Promise.all(
      riotIds.map(async (fullRiotId) => {
        const [name, tag] = fullRiotId.split("#")
        try {
          const account = await getAccountByRiotId(name, tag, region)
          console.log("📦 account result:", account.puuid)

          const rankedData = await getRankedDataBySummonerId(account.puuid, region)
          const solo = rankedData.find((entry: any) => entry.queueType === "RANKED_SOLO_5x5")

          return {
            riotId: fullRiotId,
            rank: solo ? `${solo.tier} ${solo.rank}` : "Unranked",
            wins: solo?.wins ?? 0,
            losses: solo?.losses ?? 0,
            lp: solo?.leaguePoints ?? 0,
          }
        } catch (err) {
          console.error(`❌ Failed to get rank for ${fullRiotId}:`, err)
          return {
            riotId: fullRiotId,
            rank: "Error",
            wins: 0,
            losses: 0,
          }
        }
      })
    )

    return Response.json({ ranks: results })
  } catch (err) {
    console.error("❌ Error in getMultiRankHandler:", err)
    return new Response("Internal error", { status: 500 })
  }
}
