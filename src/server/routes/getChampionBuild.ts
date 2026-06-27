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

// Boots. Tier-2 (the classic buy) PLUS the S15+ "Feats of Strength" tier-3
// upgrades, which transform a tier-2 boot in place (new item id, old one gone).
// We must count the upgrades too: in lanes that almost always upgrade (esp. MID),
// the leftover tier-2-only inventories are the rare NON-upgraded — i.e. behind /
// losing — games, so a tier-2-only winrate reads absurdly low. Each tier-3 maps
// back to its tier-2 root so the whole boot LINE aggregates as one.
const BOOTS_T2 = new Set([3005, 3006, 3008, 3009, 3010, 3020, 3047, 3111, 3117, 3158])
const BOOT_T3_TO_T2: Record<number, number> = {
  3013: 3010, 3176: 3010, // Synchronized Souls / Forever Forward → Symbiotic Soles
  3168: 3008,             // Immortal Path → Gluttonous Greaves
  3170: 3009,             // Swiftmarch → Boots of Swiftness
  3171: 3158,             // Crimson Lucidity → Ionian Boots of Lucidity
  3173: 3111,             // Chainlaced Crushers → Mercury's Treads
  3174: 3047,             // Armored Advance → Plated Steelcaps
  3175: 3020,             // Spellslinger's Shoes → Sorcerer's Shoes
}
const ALL_BOOTS = new Set<number>([...BOOTS_T2, ...Object.keys(BOOT_T3_TO_T2).map(Number)])
const bootLineRoot = (id: number): number => BOOT_T3_TO_T2[id] ?? id

// Support quest item — the 5 FINAL forms of the World Atlas line (a support
// specialises into exactly one). Surfaced so the Build tab actually tells a
// support which support item to finish, which the frozen item snapshot never
// listed. We deliberately omit the transitional 3865/3866/3867 (unfinished /
// not-yet-specialised — i.e. early-surrender noise, not a recommendation).
const SUPPORT_ITEMS = new Set([3869, 3870, 3871, 3876, 3877])

type Cached = { ts: number; payload: unknown }
const cache = new Map<string, Cached>()
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

    // Optional role override (the UI passes "UTILITY" for support). Without it
    // we fall back to the champion's most-played role. This is what lets a flex
    // pick (e.g. a support that's ALSO played mid) show the RIGHT items instead
    // of always the #1 role's — the support-items fix.
    const reqRole = body?.role ? String(body.role).toUpperCase() : null
    const reqRoleNorm = reqRole === "SUPPORT" ? "UTILITY" : reqRole

    // available roles for this champion (sorted by games desc) — returned so the
    // UI can render a role switcher.
    const roles = getChampRoles(champKey)
    const role =
      reqRoleNorm && roles.some((r) => r.role === reqRoleNorm)
        ? reqRoleNorm
        : roles.length
          ? roles[0].role
          : null

    // Optional cohort filters: vs (lane-opponent champion name), patch, region
    // (platform, e.g. "euw1"). vs uses the lane shortcut: role is unique per team,
    // so "matches where champion X also played this role" = the lane opponent.
    const vs = typeof body?.vs === "string" && body.vs.trim() ? body.vs.trim() : null
    const fPatch = typeof body?.patch === "string" && body.patch.trim() ? body.patch.trim() : null
    const fRegion = typeof body?.region === "string" && body.region.trim() ? body.region.trim() : null
    const cohortFilter = (startIdx: number): { sql: string; params: any[] } => {
      const parts: string[] = []; const params: any[] = []; let i = startIdx
      if (fPatch || fRegion) {
        const mp: string[] = []
        if (fPatch) { params.push(fPatch); mp.push(`patch = $${i++}`) }
        if (fRegion) { params.push(fRegion); mp.push(`platform = $${i++}`) }
        parts.push(`match_id IN (SELECT match_id FROM matches WHERE ${mp.join(" AND ")})`)
      }
      if (vs && role) {
        params.push(role, vs)
        parts.push(`match_id IN (SELECT match_id FROM participants WHERE role = $${i++} AND champion_name = $${i++})`)
      }
      return { sql: parts.length ? " AND " + parts.join(" AND ") : "", params }
    }

    const cacheKey = `${champKey}:${role ?? "none"}:${vs ?? ""}:${fPatch ?? ""}:${fRegion ?? ""}`
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.ts < TTL_MS) return Response.json(hit.payload)

    const snap: any = role ? getSnap(champKey, role, null) : null
    const core = snap?.core ?? null
    const cohort = Number(core?.gamesAnalyzed ?? 0) || 0

    const allItems = (snap?.items ?? []) as SnapItem[]
    const g = (i: SnapItem) => Number(i.total_games ?? i.games ?? 0)
    const legendaries = allItems.filter((i) => !ALL_BOOTS.has(i.item_id))
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

    // live: summoner spells (top pairs) + boots + top players
    let spells: any[] = []
    let bootsRows: any[] = []
    let supportRows: any[] = []
    let topPlayers: any[] = []
    let preciseRunes: any = null
    let buildPath: any[] = []
    let bootsSlot: number | null = null // typical build position of boots (1-indexed)
    const client = await explorerPool().connect()
    try {
      await client.query("SET statement_timeout = 15000")
      // Disable parallel-gather: these aggregations are indexed + cached, and
      // parallel workers exhaust the supabase-db container's small /dev/shm under
      // concurrent load (warmer + live traffic) → "could not resize shared memory
      // segment" 500s. Single-threaded is plenty fast here.
      await client.query("SET max_parallel_workers_per_gather = 0")
      const sp = await client.query(
        `SELECT s1, s2, games, winrate,
                round(games::numeric / nullif(sum(games) over (), 0) * 100, 1)::float8 AS pickrate
         FROM (
           SELECT least(summoner1_id, summoner2_id) AS s1,
                  greatest(summoner1_id, summoner2_id) AS s2,
                  count(*)::int AS games,
                  round(avg((win)::int) * 100, 2)::float8 AS winrate
           FROM participants
           WHERE champion_name = $1 AND summoner1_id IS NOT NULL AND summoner2_id IS NOT NULL
           GROUP BY 1, 2
         ) t
         ORDER BY games DESC LIMIT 3`,
        [champion]
      )
      spells = sp.rows.map((r: any) => ({
        spell1: Number(r.s1),
        spell2: Number(r.s2),
        games: Number(r.games),
        winrate: Number(r.winrate),
        pickrate: r.pickrate != null ? Number(r.pickrate) : null,
      }))

      const fb = cohortFilter(4)
      // All boots (tier-2 + tier-3 upgrades); grouped into LINES below so each
      // boot's winrate counts upgraded AND non-upgraded games as one.
      const bt = await client.query(
        `SELECT item, count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate
         FROM (
           SELECT unnest(ARRAY[item0,item1,item2,item3,item4,item5,item6]) AS item, win
           FROM participants WHERE champion_name = $1 AND ($3::text IS NULL OR role = $3)${fb.sql}
         ) u
         WHERE item = ANY($2::int[])
         GROUP BY item`,
        [champion, [...ALL_BOOTS], role, ...fb.params]
      )
      {
        type V = { item: number; games: number; winrate: number }
        const lines = new Map<number, { variants: V[]; games: number; wWr: number }>()
        for (const r of bt.rows as any[]) {
          const item = Number(r.item), games = Number(r.games), winrate = Number(r.winrate)
          const root = bootLineRoot(item)
          let e = lines.get(root)
          if (!e) { e = { variants: [], games: 0, wWr: 0 }; lines.set(root, e) }
          e.variants.push({ item, games, winrate })
          e.games += games
          e.wWr += games * winrate // games-weighted winrate sum → exact combined WR
        }
        const totalBoots = [...lines.values()].reduce((s, e) => s + e.games, 0)
        bootsRows = [...lines.values()]
          .map((e) => {
            // show the variant players actually END on: tier-3 where the upgrade
            // is near-universal (mid), tier-2 where it isn't.
            const display = e.variants.slice().sort((a, b) => b.games - a.games)[0]
            return {
              item_id: display.item,
              games: e.games,
              winrate: Math.round((e.wWr / e.games) * 10) / 10,
              pickrate: totalBoots ? Math.round((e.games / totalBoots) * 1000) / 10 : null,
            }
          })
          .sort((a, b) => b.games - a.games)
          .slice(0, 4)
      }

      // Support quest item (UTILITY only) — which finished World Atlas item to build.
      if (role === "UTILITY") {
        const fs = cohortFilter(4)
        const su = await client.query(
          `SELECT item, count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate,
                  round(count(*)::numeric / nullif(sum(count(*)) over (), 0) * 100, 1)::float8 AS pickrate
           FROM (
             SELECT unnest(ARRAY[item0,item1,item2,item3,item4,item5,item6]) AS item, win
             FROM participants WHERE champion_name = $1 AND ($3::text IS NULL OR role = $3)${fs.sql}
           ) u
           WHERE item = ANY($2::int[])
           GROUP BY item
           ORDER BY games DESC LIMIT 3`,
          [champion, [...SUPPORT_ITEMS], role, ...fs.params]
        )
        supportRows = su.rows.map((r: any) => ({ item_id: Number(r.item), games: Number(r.games), winrate: Number(r.winrate), pickrate: r.pickrate != null ? Number(r.pickrate) : null }))
      }

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

      // ── PRECISE runes (full page + per-slot alternatives) + BUILD PATH order.
      // From the new perk_*/legendary_order arrays — only matches ingested since
      // the overhaul have them, so the sample is a growing subset; the UI falls
      // back to the keystone-level `runes` when `preciseRunes.sample` is thin.
      if (role) {
        const f = cohortFilter(3) // patch/region/vs narrowing — all 4 queries below are [champion,role,…]
        const [pageR, slotR, bpR, bsR] = await Promise.all([
          client.query(
            `SELECT perk_keystone AS keystone, perk_primary_style AS primary_style, perk_sub_style AS sub_style,
                    perk_primary, perk_secondary, stat_perks,
                    count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate
             FROM participants
             WHERE champion_name = $1 AND role = $2 AND perk_primary IS NOT NULL AND perk_primary_style IS NOT NULL${f.sql}
             GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY games DESC LIMIT 5`,
            [champion, role, ...f.params]
          ),
          client.query(
            `WITH base AS (
               SELECT win, perk_primary, perk_secondary, stat_perks
               FROM participants
               WHERE champion_name = $1 AND role = $2 AND perk_primary IS NOT NULL${f.sql}
             ), slots AS (
               SELECT win, 'P' || i AS slot, perk_primary[i]   AS perk FROM base, generate_subscripts(perk_primary, 1)   i
               UNION ALL
               SELECT win, 'S' || i, perk_secondary[i]               FROM base, generate_subscripts(perk_secondary, 1) i
               UNION ALL
               SELECT win, 'T' || i, stat_perks[i]                   FROM base, generate_subscripts(stat_perks, 1)     i
             )
             SELECT slot, perk, count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate
             FROM slots WHERE perk IS NOT NULL AND perk > 0
             GROUP BY slot, perk ORDER BY slot, games DESC`,
            [champion, role, ...f.params]
          ),
          client.query(
            `SELECT slot, legendary_order[slot] AS item,
                    count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate
             FROM participants, generate_subscripts(legendary_order, 1) AS slot
             WHERE champion_name = $1 AND role = $2 AND legendary_order IS NOT NULL AND slot <= 5${f.sql}
             GROUP BY slot, item ORDER BY slot, games DESC`,
            [champion, role, ...f.params]
          ),
          client.query(
            `SELECT boots_slot, count(*)::int AS n
             FROM participants
             WHERE champion_name = $1 AND role = $2 AND boots_slot IS NOT NULL${f.sql}
             GROUP BY boots_slot ORDER BY n DESC LIMIT 1`,
            [champion, role, ...f.params]
          ),
        ])
        const bsRow = (bsR.rows as any[])[0]
        bootsSlot = bsRow ? Number(bsRow.boots_slot) : null

        if (pageR.rows.length > 0) {
          const bySlot = new Map<string, { perk: number; games: number; winrate: number }[]>()
          for (const r of slotR.rows as any[]) {
            const k = String(r.slot)
            if (!bySlot.has(k)) bySlot.set(k, [])
            bySlot.get(k)!.push({ perk: Number(r.perk), games: Number(r.games), winrate: Number(r.winrate) })
          }
          // total precise-rune games = sum of the keystone slot (each row has exactly one P1)
          const sample = (slotR.rows as any[])
            .filter((r) => r.slot === "P1")
            .reduce((s, r) => s + Number(r.games), 0)
          // top N full pages → the "recommended builds" variant list; each renders
          // as a standard LoL rune page on the front end.
          const pages = (pageR.rows as any[]).map((p) => ({
            keystone: Number(p.keystone),
            primaryStyle: Number(p.primary_style),
            subStyle: Number(p.sub_style),
            primary: (p.perk_primary as number[]) ?? [],
            secondary: (p.perk_secondary as number[]) ?? [],
            shards: (p.stat_perks as number[]) ?? [],
            games: Number(p.games),
            winrate: Number(p.winrate),
          }))
          preciseRunes = {
            sample,
            pages,
            slots: [...bySlot.entries()].map(([slot, options]) => ({ slot, options })),
          }
        }

        const byBuildSlot = new Map<number, { item: number; games: number; winrate: number }[]>()
        for (const r of bpR.rows as any[]) {
          const s = Number(r.slot)
          if (!byBuildSlot.has(s)) byBuildSlot.set(s, [])
          byBuildSlot.get(s)!.push({ item: Number(r.item), games: Number(r.games), winrate: Number(r.winrate) })
        }
        buildPath = [...byBuildSlot.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([slot, items]) => ({ slot, items }))
      }
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
      preciseRunes,
      buildPath,
      bootsSlot,
      spells,
      items: { boots: bootsRows, core: coreItems, situational, support: supportRows },
      topPlayers,
      availableRoles: roles.map((r) => ({ role: r.role, games: r.games })),
    }
    cache.set(cacheKey, { ts: Date.now(), payload })
    return Response.json(payload)
  } catch (e: any) {
    console.error("❌ getChampionBuild exception:", e?.message ?? e)
    return Response.json({ error: "Failed to compute build" }, { status: 500 })
  }
}
