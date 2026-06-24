// routes/getChampionBuild.ts
//
// POST /api/champion/build  body: { champKey: number, champion: string }
//
// One comprehensive payload for the champion Build tab: core stats, best rune
// pages, best summoner-spell pairs, items split into boots / core / situational,
// and the top players. Snapshot data (items/runes/core) is reused from the
// preloaded stats snapshot; spells + top players are queried live on the box pg
// pool. Cached per champion for 6h.

import { getSnap, getChampRoles } from "./getChampionStats"
import { explorerPool } from "../explorer/pool"

// Tier-2 boots item ids (stable across patches).
const BOOTS = new Set([3006, 3009, 3010, 3020, 3047, 3111, 3117, 3158])

type Cached = { ts: number; payload: unknown }
const cache = new Map<number, Cached>()
const TTL_MS = 6 * 60 * 60 * 1000

type SnapItem = { item_id: number; winrate: number; pick_rate?: number; games?: number; total_games?: number; wins?: number }
type SnapRune = { perk_keystone: number; perk_primary_style: number; perk_sub_style: number; winrate: number; pick_rate?: number; games?: number }

export async function getChampionBuildHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const champKey = Number(body?.champKey)
    const champion = String(body?.champion ?? "").trim()
    if (!Number.isFinite(champKey) || !champion) {
      return Response.json({ error: "champKey and champion (name) are required" }, { status: 400 })
    }

    const hit = cache.get(champKey)
    if (hit && Date.now() - hit.ts < TTL_MS) return Response.json(hit.payload)

    // main role + snapshot
    const roles = getChampRoles(champKey)
    const role = roles.length ? roles[0].role : null
    const snap: any = role ? getSnap(champKey, role, null) : null
    const core = snap?.core ?? null
    const cohort = Number(core?.gamesAnalyzed ?? 0) || 0

    const allItems = (snap?.items ?? []) as SnapItem[]
    const g = (i: SnapItem) => Number(i.total_games ?? i.games ?? 0)
    const boots = allItems.filter((i) => BOOTS.has(i.item_id)).slice(0, 3)
    const legendaries = allItems.filter((i) => !BOOTS.has(i.item_id))
    const coreItems = legendaries.slice(0, 6) // snapshot is ordered by pick rate
    const coreIds = new Set(coreItems.slice(0, 3).map((i) => i.item_id))
    const situational = legendaries
      .filter((i) => !coreIds.has(i.item_id) && g(i) >= 200)
      .sort((a, b) => b.winrate - a.winrate)
      .slice(0, 6)

    const runes = (snap?.runes ?? []).slice(0, 3).map((r: SnapRune) => ({
      keystone: r.perk_keystone,
      primary: r.perk_primary_style,
      sub: r.perk_sub_style,
      winrate: r.winrate,
      pickrate: r.pick_rate ?? null,
      games: Number(r.games ?? 0),
    }))

    // live: summoner spells (top pairs) + top players
    let spells: any[] = []
    let topPlayers: any[] = []
    const client = await explorerPool().connect()
    try {
      await client.query("SET statement_timeout = 12000")
      const sp = await client.query(
        `SELECT least(summoner1_id, summoner2_id) AS s1,
                greatest(summoner1_id, summoner2_id) AS s2,
                count(*)::int AS games,
                round(avg((win)::int) * 100, 2)::float8 AS winrate
         FROM participants
         WHERE champion_name = $1 AND summoner1_id IS NOT NULL AND summoner2_id IS NOT NULL
         GROUP BY 1, 2 ORDER BY games DESC LIMIT 3`,
        [champion]
      )
      spells = sp.rows.map((r: any) => ({
        spell1: Number(r.s1),
        spell2: Number(r.s2),
        games: Number(r.games),
        winrate: Number(r.winrate),
        pickrate: cohort ? Math.round((Number(r.games) / cohort) * 1000) / 10 : null,
      }))

      const tp = await client.query(
        `SELECT riot_id_game_name AS name, riot_id_tagline AS tag,
                count(*)::int AS games,
                round(avg((win)::int) * 100, 1)::float8 AS winrate
         FROM participants
         WHERE champion_name = $1 AND riot_id_game_name IS NOT NULL AND riot_id_game_name <> ''
         GROUP BY puuid, riot_id_game_name, riot_id_tagline
         HAVING count(*) >= 30
         ORDER BY winrate DESC, games DESC LIMIT 10`,
        [champion]
      )
      topPlayers = tp.rows.map((r: any) => ({
        name: r.name as string,
        tag: r.tag as string,
        games: Number(r.games),
        winrate: Number(r.winrate),
      }))
    } finally {
      client.release()
    }

    const payload = {
      champion,
      role,
      core: core
        ? {
            winrate: core.winrate,
            pickrate: core.pickrate,
            banrate: core.banrate,
            games: cohort,
            kda: core.avgKDA,
            avgGold: core.avgGold,
            avgDamage: core.avgDamage,
          }
        : null,
      runes,
      spells,
      items: { boots, core: coreItems, situational },
      topPlayers,
    }
    cache.set(champKey, { ts: Date.now(), payload })
    return Response.json(payload)
  } catch (e: any) {
    console.error("❌ getChampionBuild exception:", e?.message ?? e)
    return Response.json({ error: "Failed to compute build" }, { status: 500 })
  }
}
