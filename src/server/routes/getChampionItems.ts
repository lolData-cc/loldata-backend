// routes/getChampionItems.ts
import { supabaseAdmin } from "../supabase/client"

type ItemRow = {
  item_id: number
  total_games: number
  wins: number
  winrate: number
  pick_rate?: number
}

export async function getChampionItemsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const { championName, championId, role, tier, maxPerSlot = 12, buildOrder: wantBuildOrder, opponentId } = body as {
      championName?: string
      championId?: number
      role?: string
      tier?: string
      maxPerSlot?: number
      buildOrder?: boolean
      opponentId?: number
    }

    if (!championName && !championId) {
      return new Response("Missing championName or championId", { status: 400 })
    }

    // Try snapshot first (fast path)
    if (championId && role) {
      let snapQuery = supabaseAdmin
        .from("champion_stats_snapshots")
        .select("data")
        .eq("champion_id", championId)
        .eq("role", role === "SUPPORT" ? "UTILITY" : role)
        .order("snapshot_date", { ascending: false })
        .limit(1)

      if (tier) {
        snapQuery = snapQuery.eq("tier", tier)
      } else {
        snapQuery = snapQuery.is("tier", null)
      }

      const { data: snap } = await snapQuery.maybeSingle()
      const items = snap?.data?.items as ItemRow[] | undefined

      if (items?.length) {
        // Return as flat list in slot "0" — frontend displays as "Most Built"
        const slots: Record<string, ItemRow[]> = {
          "0": items.slice(0, maxPerSlot).map(i => ({
            legendary_index: 0,
            item_id: i.item_id,
            total_games: i.total_games ?? i.games,
            wins: i.wins,
            winrate: i.winrate,
            pick_rate: i.pick_rate,
          } as any)),
        }
        return Response.json({
          championName: championName ?? String(championId),
          slots,
          source: "snapshot",
        })
      }
    }

    // VS matchup-specific items (fast, uses mv_lane_opponents)
    if (wantBuildOrder && championId && opponentId) {
      const roleNorm = role === "SUPPORT" ? "UTILITY" : role
      const { data: vsData, error: vsErr } = await supabaseAdmin.rpc(
        "champion_items_by_slot_vs",
        {
          p_champion_id: championId,
          p_opponent_id: opponentId,
          p_role: roleNorm ?? null,
          p_tier: tier ?? null,
          p_max_per_slot: maxPerSlot,
        }
      )
      if (!vsErr && vsData?.length) {
        return Response.json({
          championName: championName ?? String(championId),
          buildOrder: vsData,
          source: "vs_items",
        })
      }
    }

    // Per-slot item winrates (from final inventory, legendary items only)
    if (wantBuildOrder && championId) {
      const roleNorm = role === "SUPPORT" ? "UTILITY" : role
      const { data: slotData, error: slotErr } = await supabaseAdmin.rpc(
        "champion_items_by_slot",
        {
          p_champion_id: championId,
          p_role: roleNorm ?? null,
          p_tier: tier ?? null,
          p_max_per_slot: maxPerSlot,
        }
      )

      if (!slotErr && slotData?.length) {
        return Response.json({
          championName: championName ?? String(championId),
          buildOrder: slotData,
          source: "items_by_slot",
        })
      }
    }

    // Fallback: live query
    if (championName) {
      const { data, error } = await supabaseAdmin.rpc(
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

      const rows = (data ?? []) as any[]
      const slots: Record<string, any[]> = {}
      for (const row of rows) {
        const key = String(row.legendary_index)
        if (!slots[key]) slots[key] = []
        slots[key].push(row)
      }

      return Response.json({ championName, slots })
    }

    return Response.json({ championName: championName ?? "", slots: {} })
  } catch (e) {
    console.error("Errore in getChampionItemsHandler:", e)
    return new Response("Errore interno", { status: 500 })
  }
}
