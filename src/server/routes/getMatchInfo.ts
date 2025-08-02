// src/server/routes/getMatchInfo.ts
import { getMatchDetails } from "../riot"

export async function getMatchInfoHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { matchId, region } = body

    if (!matchId || !region) {
      console.error("❌ Missing matchId or region")
      return new Response("Missing matchId or region", { status: 400 })
    }

    const match = await getMatchDetails(matchId, region)

    return Response.json({ match })
  } catch (err) {
    console.error("❌ Error in getMatchInfoHandler:", err)
    return new Response("Internal server error", { status: 500 })
  }
}
