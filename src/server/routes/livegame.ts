// src/server/routes/getLiveGame.ts
import { getLiveGameByPuuid } from "../riot"
import { saveLiveGame } from "@/server/supabase/queries"

export async function getLiveGameHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { puuid } = body

    if (!puuid) return new Response("Missing puuid", { status: 400 })

    const game = await getLiveGameByPuuid(puuid)
    if (!game) return new Response("No active game", { status: 204 })

    await saveLiveGame(puuid, game.participants)

    return Response.json({ game })
  } catch (err) {
    console.error("❌ Errore live game handler:", err)
    return new Response("Internal error", { status: 500 })
  }
}