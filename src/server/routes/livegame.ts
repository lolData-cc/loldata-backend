import { getLiveGameByPuuid } from "../riot"

export async function getLiveGameHandler(req: Request): Promise<Response> {
  try {
    const { puuid, region } = await req.json()

    if (!puuid || !region) {
      return new Response("Missing puuid or region", { status: 400 })
    }

    const game = await getLiveGameByPuuid(puuid, region)
    if (!game) return new Response("No active game", { status: 204 })


    return Response.json({ game })
  } catch (err) {
    console.error("❌ Errore live game  handler:", err)
    return new Response("Internal error", { status: 500 })
  }
}
