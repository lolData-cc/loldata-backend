import { supabase } from "../supabase/client"

export async function getItemBestUtilizersHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const { itemId, tier, role, queues, minGames } = body

    if (!itemId) return new Response("Missing itemId", { status: 400 })

    const { data, error } = await supabase.rpc("item_best_utilizers", {
      p_item_id: Number(itemId),
      p_tier: tier || null,
      p_queue_ids: queues?.length ? queues : [420, 440],
      p_role: role || null,
      p_min_games: minGames ?? 20,
    })

    if (error) {
      console.error("❌ item_best_utilizers RPC error:", error.message)
      return new Response("Errore best utilizers", { status: 500 })
    }

    return Response.json({ rows: data ?? [] })
  } catch (e) {
    console.error("❌ getItemBestUtilizers exception:", e)
    return new Response("Errore interno", { status: 500 })
  }
}
