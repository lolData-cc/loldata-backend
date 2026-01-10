// routes/getChampionItems.ts
import { supabase } from "../supabase/client"

type ChampionItemsRow = {
  legendary_index: number
  item_id: number
  total_games: number
  wins: number
  winrate: number
}

export async function getChampionItemsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const { championName, maxPerSlot = 12 } = body as {
      championName?: string
      maxPerSlot?: number
    }

    if (!championName) {
      return new Response("Missing championName", { status: 400 })
    }

    const { data, error } = await supabase.rpc(
      "champion_legendary_items_per_slot",
      {
        in_champion_name: championName,
        in_max_per_slot: maxPerSlot,
      }
    )

    if (error) {
      console.error("❌ DB error champion_legendary_items_per_slot:", error.message)
      return new Response("DB error", { status: 500 })
    }

    // Cast tipato per TS
    const rows = (data ?? []) as ChampionItemsRow[]

    const slots: Record<string, ChampionItemsRow[]> = {}

    for (const row of rows) {
      const key = String(row.legendary_index)
      if (!slots[key]) slots[key] = []
      slots[key].push(row)
    }

    return Response.json({ championName, slots })
  } catch (e) {
    console.error("Errore in getChampionItemsHandler:", e)
    return new Response("Errore interno", { status: 500 })
  }
}
