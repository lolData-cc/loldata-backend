// routes/getChampionMatchups.ts
import { supabase } from "../supabase/client"

type Row = {
  champion_id_1: number
  champion_id_2: number
  winrate: number   // riferita a champion_id_1 (0-100)
  notes: string | null
  games: number
}
type ChampRow = { id: number; roles: string[] | null }

function canonRole(r?: string) {
  const s = (r || "").trim().toUpperCase()
  if (!s) return ""
  if (["BOT","BOTTOM","DUO_CARRY","CARRY","MARKSMAN","ADC"].includes(s)) return "ADC"
  if (["SUP","SUPP","UTILITY","DUO_SUPPORT","SUPPORT"].includes(s)) return "SUPPORT"
  if (["MID","MIDDLE"].includes(s)) return "MID"
  if (["JNG","JUNG","JUNGLE"].includes(s)) return "JUNGLE"
  if (["TOP","TOPLANE"].includes(s)) return "TOP"
  return s
}
function canonList(arr?: string[] | null) {
  return Array.from(new Set((arr || []).map(canonRole).filter(Boolean)))
}
function primaryRoleFrom(arr?: string[] | null) {
  const list = canonList(arr)
  return list.length ? list[0] : null  // <-- SOLO PRIMO ROLE
}

export async function getChampionMatchupsHandler(req: Request): Promise<Response> {
  try {
    const { champKey } = await req.json()
    const key = Number(champKey)
    if (!Number.isFinite(key)) return new Response("Missing or invalid champKey", { status: 400 })

    // 1) primo role del champ selezionato
    const { data: me, error: e1 } = await supabase
      .from("champions")
      .select("roles")
      .eq("id", key)
      .single<Pick<ChampRow, "roles">>()
    if (e1) console.error("champions roles fetch error:", e1.message)
    const primaryRole = primaryRoleFrom(me?.roles) // es. "TOP"

    // 2) matchups grezzi
    const { data, error } = await supabase
      .from("matchups")
      .select("champion_id_1, champion_id_2, winrate, notes, games")
      .or(`champion_id_1.eq.${key},champion_id_2.eq.${key}`)
      .order("games", { ascending: false })
    if (error) {
      console.error("❌ getChampionMatchups error:", error.message)
      return new Response("DB error", { status: 500 })
    }

    // 3) normalizza verso champKey e DEDUP (no somma games)
    const byOpp = new Map<number, { opponent_key: number; games: number; winrate: number; notes: string | null }>()
    for (const r of (data || []) as Row[]) {
      const isFirst = r.champion_id_1 === key
      const opponent_key = isFirst ? r.champion_id_2 : r.champion_id_1
      const wr_for_champ = isFirst ? r.winrate : (100 - r.winrate)

      const prev = byOpp.get(opponent_key)
      if (!prev || r.games > prev.games) {
        byOpp.set(opponent_key, {
          opponent_key,
          games: r.games,
          winrate: Math.round(wr_for_champ * 100) / 100,
          notes: r.notes ?? prev?.notes ?? null,
        })
      } else if (!prev.notes && r.notes) {
        prev.notes = r.notes
      }
    }
    let normalized = Array.from(byOpp.values())

    // 4) filtro: opponent con lo STESSO primo role
    const oppKeys = normalized.map(m => m.opponent_key)
    if (oppKeys.length && primaryRole) {
      const { data: opps, error: e2 } = await supabase
        .from("champions")
        .select("id, roles")
        .in("id", oppKeys) as unknown as { data: ChampRow[]; error: any }
      if (!e2 && opps) {
        const oppPrimaryByKey = new Map(opps.map(o => [o.id, primaryRoleFrom(o.roles)]))
        normalized = normalized.filter(m => oppPrimaryByKey.get(m.opponent_key) === primaryRole)
      }
    }

    normalized.sort((a, b) => b.games - a.games)
    return Response.json({ matchups: normalized })
  } catch (e) {
    console.error("❌ getChampionMatchups exception:", e)
    return new Response("Bad request", { status: 400 })
  }
}
