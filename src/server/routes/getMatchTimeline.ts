import { getMatchTimeline } from "../riot"

export async function getMatchTimelineHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { matchId, region } = body

    if (!matchId || !region) {
      console.error("❌ Missing matchId or region")
      return new Response("Missing matchId or region", { status: 400 })
    }

    const timeline = await getMatchTimeline(matchId, region)
    return Response.json({ timeline })
  } catch (err) {
    console.error("❌ Error in getMatchTimelineHandler:", err)
    return new Response("Internal server error", { status: 500 })
  }
}