// routes/getItemStats.ts
import { supabase } from "../supabase/client"

export async function getItemStatsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const { itemId, tier, queues, role, championIds } = body as {
      itemId?: number | string
      tier?: string | null
      queues?: number[] | null
      role?: string | null              // TOP | JUNGLE | MIDDLE | BOTTOM | SUPPORT
      championIds?: number[] | null     // array di champion_id
    }

    if (!itemId) return new Response("Missing itemId", { status: 400 })

    const p_item_id = Number(itemId)
    const p_tier = tier && tier.trim() ? tier.toUpperCase() : null
    const p_queue_ids = Array.isArray(queues) && queues.length ? queues : [420, 440]
    const p_role = role && role.trim() ? role.toUpperCase() : null
    const p_champion_ids = Array.isArray(championIds) && championIds.length ? championIds : null

    const { data, error } = await supabase.rpc("item_winrate", {
      p_item_id,
      p_tier,
      p_queue_ids,
      p_role,
      p_champion_ids,
    })

    if (error) {
      console.error("❌ item_winrate RPC error:", error.message)
      return new Response("Errore item stats", { status: 500 })
    }

    const row = Array.isArray(data) ? data[0] : data
    return Response.json({ stats: row })
  } catch (e) {
    console.error("❌ getItemStatsHandler exception:", e)
    return new Response("Errore interno", { status: 500 })
  }
}
