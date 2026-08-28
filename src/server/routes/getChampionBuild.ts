// routes/getChampionBuild.ts
//
// POST /api/champion/build  body: { champKey: number, champion: string }
//
// One comprehensive payload for the champion Build tab: core stats, best rune
// pages, best summoner-spell pairs, items split into boots / core / situational,
// and the top players. Snapshot data (core/items/runes) is reused from the
// preloaded stats snapshot (in-memory, instant); the live enrichment (spells,
// boots, top players, precise runes, build path) aggregates the ~86M-row
// `participants` table and is far too slow to run per request under load.
//
// PERF: the live enrichment for the DEFAULT cohort is served from a persistent
// L2 cache (`cbs_build_live`, refreshed nightly by refresh-build.ts and written
// through on any live compute). This makes the common path a single indexed
// jsonb read instead of 8 heavy aggregations. Only rare patch/region/vs cohorts
// (or a not-yet-warmed champion) fall back to the live compute.

import { getSnap, getChampRoles } from "./getChampionStats"
import { explorerPool } from "../explorer/pool"

// Boots. Tier-2 (the classic buy) PLUS the S15+ "Feats of Strength" tier-3
// upgrades, which transform a tier-2 boot in place (new item id, old one gone).
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

// Support quest item — the 5 FINAL forms of the World Atlas line.
const SUPPORT_ITEMS = new Set([3869, 3870, 3871, 3876, 3877])

type Cached = { ts: number; payload: unknown }
const cache = new Map<string, Cached>()
const TTL_MS = 6 * 60 * 60 * 1000

// L2 (cbs_build_live) freshness. Refreshed nightly, so this is always a hit in
// practice; the window just tolerates a missed refresh before we recompute live.
const L2_FRESH = "2 days"

type SnapItem = { item_id: number; winrate: number; pick_rate?: number; games?: number; total_games?: number; wins?: number }
type SnapRune = { perk_keystone: number; perk_primary_style: number; perk_sub_style: number; winrate: number; pick_rate?: number; games?: number }

export type LiveBuild = {
  spells: any[]
  bootsRows: any[]
  supportRows: any[]
  jungleRows: any[]
  topPlayers: any[]
  preciseRunes: any
  buildPath: any[]
  bootsSlot: number | null
}

// patch/region/vs cohort narrowing shared by every live query.
function makeCohortFilter(role: string | null, vs: string | null, fPatch: string | null, fRegion: string | null) {
  return (startIdx: number): { sql: string; params: any[] } => {
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
}

// The heavy live enrichment: 8 aggregations over `participants`. Exported so the
// nightly warm job (refresh-build.ts) can precompute it with a long timeout.
export async function computeLiveBuild(
  client: any, champion: string, role: string | null,
  vs: string | null = null, fPatch: string | null = null, fRegion: string | null = null,
  opts: { parallel?: number } = {}
): Promise<LiveBuild> {
  const cohortFilter = makeCohortFilter(role, vs, fPatch, fRegion)
  // Request path: single-threaded, since parallel workers exhaust the supabase-db
  // container's 64MB /dev/shm under concurrent load ("could not resize shared
  // memory segment"). The nightly warm (sequential, no concurrent heavy queries)
  // passes a small worker count to go faster.
  await client.query(`SET max_parallel_workers_per_gather = ${Math.max(0, Math.min(4, opts.parallel ?? 0))}`)

  let spells: any[] = []
  let bootsRows: any[] = []
  let supportRows: any[] = []
  let jungleRows: any[] = []
  let topPlayers: any[] = []
  let preciseRunes: any = null
  let buildPath: any[] = []
  let bootsSlot: number | null = null

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
    spell1: Number(r.s1), spell2: Number(r.s2),
    games: Number(r.games), winrate: Number(r.winrate),
    pickrate: r.pickrate != null ? Number(r.pickrate) : null,
  }))

  const fb = cohortFilter(4)
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
      e.wWr += games * winrate
    }
    const totalBoots = [...lines.values()].reduce((s, e) => s + e.games, 0)
    bootsRows = [...lines.values()]
      .map((e) => {
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

  if (role === "JUNGLE") {
    const fj = cohortFilter(2)
    const ju = await client.query(
      `SELECT jungle_pet AS item, count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate,
              round(count(*)::numeric / nullif(sum(count(*)) over (), 0) * 100, 1)::float8 AS pickrate
       FROM participants
       WHERE champion_name = $1 AND role = 'JUNGLE' AND jungle_pet IS NOT NULL${fj.sql}
       GROUP BY jungle_pet ORDER BY games DESC`,
      [champion, ...fj.params]
    )
    const rows = ju.rows.map((r: any) => ({ item_id: Number(r.item), games: Number(r.games), winrate: Number(r.winrate), pickrate: r.pickrate != null ? Number(r.pickrate) : null }))
    const total = rows.reduce((s: number, r: any) => s + r.games, 0)
    if (total >= 20) jungleRows = rows.filter((r: any) => r.games >= 5)
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
    name: r.name as string, tag: r.tag as string,
    games: Number(r.games), winrate: Number(r.winrate),
  }))

  if (role) {
    const f = cohortFilter(3)
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
      const sample = (slotR.rows as any[])
        .filter((r) => r.slot === "P1")
        .reduce((s, r) => s + Number(r.games), 0)
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
        sample, pages,
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

  return { spells, bootsRows, supportRows, jungleRows, topPlayers, preciseRunes, buildPath, bootsSlot }
}

/**
 * Read the L2 row REGARDLESS of age, reporting how stale it is.
 *
 * The freshness window used to be part of the query, so an old row was simply
 * invisible and every request fell through to computeLiveBuild — which no
 * longer fits inside the statement timeout on a 14M-match participants table.
 * The result was a 15s 500 on the Build tab. A build from last month is a far
 * better answer than an error, so staleness now decides whether to REFRESH,
 * not whether to SERVE.
 */
async function readBuildLive(
  client: any,
  champion: string,
  role: string
): Promise<{ payload: LiveBuild; stale: boolean } | null> {
  const r = await client.query(
    `SELECT payload, computed_at < now() - interval '${L2_FRESH}' AS stale
       FROM cbs_build_live
      WHERE champion_name = $1 AND role = $2`,
    [champion, role]
  )
  const row = r.rows[0]
  if (!row?.payload) return null
  return { payload: row.payload as LiveBuild, stale: Boolean(row.stale) }
}

// Champion/role pairs currently being recomputed in the background, so a burst
// of requests for the same stale build triggers one refresh, not twenty.
const refreshing = new Set<string>()

// GLOBAL cap, not just per-pair. Each recompute is a heavy aggregate with its
// own 128MB work_mem; letting one fire per stale request turned twelve page
// views into twelve concurrent scans that starved the very requests they were
// meant to speed up (0.2s responses became 30-60s). Background work must lose
// to user traffic, always — a skipped refresh just means the row stays stale
// and gets another chance on the next request or the nightly warm.
const MAX_CONCURRENT_REFRESH = 1
let refreshInFlight = 0

/** Recompute a stale L2 row out of band. Never awaited by a request. */
function refreshBuildLiveInBackground(champion: string, role: string): void {
  const key = `${champion}:${role}`
  if (refreshing.has(key)) return
  if (refreshInFlight >= MAX_CONCURRENT_REFRESH) return
  refreshing.add(key)
  refreshInFlight++
  void (async () => {
    // connect() INSIDE the try: if the pool is saturated it rejects, and with
    // the acquire outside we would leak the `refreshing` key and silently never
    // retry that pair again for the life of the process.
    let client: any = null
    try {
      client = await explorerPool().connect()
      // Generous here precisely because nobody is waiting on it.
      await client.query("SET statement_timeout = 120000")
      await client.query("SET max_parallel_workers_per_gather = 0")
      await client.query("SET work_mem = '128MB'")
      const live = await computeLiveBuild(client, champion, role, null, null, null, { parallel: 0 })
      await upsertBuildLive(client, champion, role, live)
      console.log(`[build] refreshed L2 ${champion}/${role}`)
    } catch (e: any) {
      console.warn(`[build] background refresh failed ${champion}/${role}:`, e?.message ?? e)
    } finally {
      client?.release()
      refreshing.delete(key)
      refreshInFlight--
    }
  })()
}

export async function upsertBuildLive(client: any, champion: string, role: string, live: LiveBuild): Promise<void> {
  await client.query(
    `INSERT INTO cbs_build_live (champion_name, role, payload, computed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (champion_name, role) DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()`,
    [champion, role, JSON.stringify(live)]
  )
}

/** Top jungle routes for a champion, straight off the nightly summary table.
 *  One indexed lookup on a few thousand rows — never an aggregate at request
 *  time. Returns null for non-junglers and when the summary has nothing yet. */
async function readJunglePath(
  client: any,
  champion: string
): Promise<{
  totalGames: number
  routes: {
    route: number[]
    games: number
    winrate: number
    /** The reset that ends this opening: when it lands and what gets bought.
     *  Null until enough games carry it - see MIN_BACK_SAMPLE. */
    back: { atSeconds: number; sample: number; items: { id: number; pct: number }[] } | null
  }[]
} | null> {
  // participants.first_back_* is only captured from 2026-08-22 and cannot be
  // backfilled (timelines are not stored), so early on a route can have tens of
  // thousands of games behind it and a handful of observed resets. Publishing
  // "84% buy Long Sword" off six games would be worse than publishing nothing.
  const MIN_BACK_SAMPLE = 20
  try {
    const r = await client.query(
      `SELECT route, games, winrate, champ_games,
              back_sample, back_s, back_items, back_item_pct
         FROM cbs_jungle_path
        WHERE champion_name = $1
        ORDER BY rn`,
      [champion]
    )
    if (!r.rows.length) return null
    return {
      totalGames: Number(r.rows[0].champ_games ?? 0),
      routes: r.rows.map((x: any) => {
        const sample = Number(x.back_sample ?? 0)
        const ids: number[] = x.back_items ?? []
        const pcts: number[] = x.back_item_pct ?? []
        return {
          route: (x.route ?? []).map(Number),
          games: Number(x.games),
          winrate: Number(x.winrate),
          back:
            sample >= MIN_BACK_SAMPLE && x.back_s != null && ids.length
              ? {
                  atSeconds: Number(x.back_s),
                  sample,
                  items: ids.map((id, i) => ({ id: Number(id), pct: Number(pcts[i] ?? 0) })),
                }
              : null,
        }
      }),
    }
  } catch {
    // Summary table may not exist yet on a fresh box — the Build tab must not
    // fail because a secondary panel has no data.
    return null
  }
}

export async function getChampionBuildHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}))
    const champKey = Number(body?.champKey)
    const champion = String(body?.champion ?? "").trim()
    if (!Number.isFinite(champKey) || !champion) {
      return Response.json({ error: "champKey and champion (name) are required" }, { status: 400 })
    }

    const reqRole = body?.role ? String(body.role).toUpperCase() : null
    const reqRoleNorm = reqRole === "SUPPORT" ? "UTILITY" : reqRole
    const roles = getChampRoles(champKey)
    const role =
      reqRoleNorm && roles.some((r) => r.role === reqRoleNorm) ? reqRoleNorm
      : roles.length ? roles[0].role : null

    const vs = typeof body?.vs === "string" && body.vs.trim() ? body.vs.trim() : null
    const fPatch = typeof body?.patch === "string" && body.patch.trim() ? body.patch.trim() : null
    const fRegion = typeof body?.region === "string" && body.region.trim() ? body.region.trim() : null

    const cacheKey = `${champKey}:${role ?? "none"}:${vs ?? ""}:${fPatch ?? ""}:${fRegion ?? ""}`
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.ts < TTL_MS) return Response.json(hit.payload)

    // ── snapshot parts (in-memory, instant): core, items, keystone runes ──
    const snap: any = role ? getSnap(champKey, role, null) : null
    const core = snap?.core ?? null
    const cohort = Number(core?.gamesAnalyzed ?? 0) || 0

    const allItems = (snap?.items ?? []) as SnapItem[]
    const g = (i: SnapItem) => Number(i.total_games ?? i.games ?? 0)
    const legendaries = allItems.filter((i) => !ALL_BOOTS.has(i.item_id))
    const coreItems = legendaries.slice(0, 6)
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

    // ── live enrichment: L2 (cbs_build_live) for the default cohort, else live ──
    const defaultCohort = !vs && !fPatch && !fRegion
    let live: LiveBuild
    let junglePath: Awaited<ReturnType<typeof readJunglePath>> = null
    const client = await explorerPool().connect()
    try {
      await client.query("SET statement_timeout = 15000")
      const cached = defaultCohort && role ? await readBuildLive(client, champion, role) : null
      if (cached) {
        // Serve now, refresh after — the user never waits on a recompute.
        live = cached.payload
        if (cached.stale) refreshBuildLiveInBackground(champion, role)
      } else {
        live = await computeLiveBuild(client, champion, role, vs, fPatch, fRegion)
        // write-through so the next request (and post-restart) is instant
        if (defaultCohort && role) {
          try { await upsertBuildLive(client, champion, role, live) } catch { /* non-fatal */ }
        }
      }
      // Jungle routes ride along on the same connection — a single indexed
      // read, so the panel costs nothing extra in round trips.
      if (role === "JUNGLE") {
        junglePath = await readJunglePath(client, champion)
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
      preciseRunes: live.preciseRunes,
      buildPath: live.buildPath,
      bootsSlot: live.bootsSlot,
      spells: live.spells,
      items: { boots: live.bootsRows, core: coreItems, situational, support: live.supportRows, jungle: live.jungleRows },
      topPlayers: live.topPlayers,
      availableRoles: roles.map((r) => ({ role: r.role, games: r.games })),
      junglePath,
    }
    cache.set(cacheKey, { ts: Date.now(), payload })
    return Response.json(payload)
  } catch (e: any) {
    console.error("❌ getChampionBuild exception:", e?.message ?? e)
    return Response.json({ error: "Failed to compute build" }, { status: 500 })
  }
}
