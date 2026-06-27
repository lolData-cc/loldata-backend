// routes/getChampionBuildStats.ts
//
// POST /api/champion/build-stats  body: { champKey, champion, role?, vs?, patch?, region? }
//
// The "deep stats" companion to /api/champion/build — everything the Build tab
// needs to feel like a real analytics page, computed live from `participants`:
//   • stats   — per-game performance averages for this champion+role
//   • baseline— the SAME metrics averaged across every champion in the role, so
//               the UI can draw "vs role average" comparison bars
//   • laning  — @10 averages (gold/cs/xp/kda/damage)
//   • laningVs— when a lane opponent (vs) is set, the @10 DIFFS against them
//
// Whole payload cached 6h per cohort; the (expensive, champion-independent) role
// baseline is cached separately per (role,patch,region) so it's reused across
// every champion and recomputed at most ~once per 12h.

import { getChampRoles } from "./getChampionStats"
import { explorerPool } from "../explorer/pool"

type Cached = { ts: number; payload: unknown }
const cache = new Map<string, Cached>()
const TTL_MS = 6 * 60 * 60 * 1000

const baselineCache = new Map<string, { ts: number; value: any }>()
const BASELINE_TTL_MS = 12 * 60 * 60 * 1000

// patch/region cohort → an AND-clause + params, starting at $startIdx.
function patchRegionFilter(startIdx: number, fPatch: string | null, fRegion: string | null): { sql: string; params: any[] } {
  const params: any[] = []
  let i = startIdx
  const mp: string[] = []
  if (fPatch) { params.push(fPatch); mp.push(`patch = $${i++}`) }
  if (fRegion) { params.push(fRegion); mp.push(`platform = $${i++}`) }
  if (!mp.length) return { sql: "", params }
  return { sql: ` AND match_id IN (SELECT match_id FROM matches WHERE ${mp.join(" AND ")})`, params }
}

const STAT_SELECT = `
  count(*)::int AS games,
  round(avg((win)::int) * 100, 2)::float8 AS winrate,
  avg(kills)::float8 AS kills,
  avg(deaths)::float8 AS deaths,
  avg(assists)::float8 AS assists,
  avg(kill_participation)::float8 AS kp,
  avg(damage_share)::float8 AS dmg_share,
  avg(total_damage_to_champions)::float8 AS dmg,
  avg(gold_earned)::float8 AS gold,
  avg(total_cs)::float8 AS cs,
  avg(total_cs::float8 / nullif(time_played, 0) * 60)::float8 AS cspm,
  avg(vision_score)::float8 AS vision,
  avg(solo_kills)::float8 AS solo_kills,
  avg(champ_level)::float8 AS champ_level`

function shapeStats(r: any) {
  if (!r) return null
  return {
    games: Number(r.games ?? 0),
    winrate: r.winrate != null ? Number(r.winrate) : null,
    kills: num(r.kills), deaths: num(r.deaths), assists: num(r.assists),
    killParticipation: r.kp != null ? Number(r.kp) * 100 : null,
    damageShare: r.dmg_share != null ? Number(r.dmg_share) * 100 : null,
    damageToChamps: num(r.dmg),
    gold: num(r.gold),
    cs: num(r.cs),
    csPerMin: num(r.cspm),
    vision: num(r.vision),
    soloKills: num(r.solo_kills),
    champLevel: num(r.champ_level),
  }
}
const num = (v: any) => (v != null ? Number(v) : null)

export async function getChampionBuildStatsHandler(req: Request): Promise<Response> {
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

    const client = await explorerPool().connect()
    let stats: any = null
    let baseline: any = null
    let laning: any = null
    let laningVs: any = null
    try {
      await client.query("SET statement_timeout = 20000")
      // Single-threaded: parallel-gather workers exhaust the supabase-db /dev/shm
      // under concurrent load (the role baseline scans 7M+ rows). Indexed + cached.
      await client.query("SET max_parallel_workers_per_gather = 0")

      // ── champion stats ──
      const cf = patchRegionFilter(3, fPatch, fRegion)
      const sres = await client.query(
        `SELECT ${STAT_SELECT} FROM participants
         WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2)${cf.sql}`,
        [champion, role, ...cf.params]
      )
      stats = shapeStats(sres.rows[0])

      // ── role baseline (champion-independent → cached separately, reused) ──
      if (role) {
        const bKey = `${role}:${fPatch ?? ""}:${fRegion ?? ""}`
        const bHit = baselineCache.get(bKey)
        if (bHit && Date.now() - bHit.ts < BASELINE_TTL_MS) {
          baseline = bHit.value
        } else {
          const bf = patchRegionFilter(2, fPatch, fRegion)
          const bres = await client.query(
            `SELECT ${STAT_SELECT} FROM participants WHERE ($1::text IS NULL OR role = $1)${bf.sql}`,
            [role, ...bf.params]
          )
          baseline = shapeStats(bres.rows[0])
          baselineCache.set(bKey, { ts: Date.now(), value: baseline })
        }
      }

      // ── laning @10 ──
      const lf = patchRegionFilter(3, fPatch, fRegion)
      const lres = await client.query(
        `SELECT count(gold_at_10)::int AS n,
                avg(gold_at_10)::float8 AS gold10, avg(cs_at_10)::float8 AS cs10, avg(xp_at_10)::float8 AS xp10,
                avg(kills_at_10)::float8 AS k10, avg(deaths_at_10)::float8 AS d10, avg(assists_at_10)::float8 AS a10,
                avg(damage_at_10)::float8 AS dmg10
         FROM participants WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2)${lf.sql}`,
        [champion, role, ...lf.params]
      )
      const lr = lres.rows[0]
      laning = lr && Number(lr.n) > 0 ? {
        games: Number(lr.n),
        gold: num(lr.gold10), cs: num(lr.cs10), xp: num(lr.xp10),
        kills: num(lr.k10), deaths: num(lr.d10), assists: num(lr.a10), damage: num(lr.dmg10),
      } : null

      // ── laning DIFFS vs the lane opponent (same role, enemy team) ──
      if (vs && role) {
        const vf = patchRegionFilter(4, fPatch, fRegion) // applies to me.match_id
        const vsSql = vf.sql.replace("match_id IN", "me.match_id IN")
        const vres = await client.query(
          `SELECT count(*)::int AS games,
                  avg(me.gold_at_10 - opp.gold_at_10)::float8 AS gold_diff,
                  avg(me.cs_at_10   - opp.cs_at_10)::float8   AS cs_diff,
                  avg(me.xp_at_10   - opp.xp_at_10)::float8   AS xp_diff,
                  avg(me.damage_at_10 - opp.damage_at_10)::float8 AS dmg_diff
           FROM participants me
           JOIN participants opp
             ON opp.match_id = me.match_id AND opp.role = me.role
            AND opp.team_id <> me.team_id AND opp.champion_name = $3
           WHERE me.champion_name = $1 AND me.role = $2
             AND me.gold_at_10 IS NOT NULL AND opp.gold_at_10 IS NOT NULL${vsSql}`,
          [champion, role, vs, ...vf.params]
        )
        const vr = vres.rows[0]
        laningVs = vr && Number(vr.games) > 0 ? {
          games: Number(vr.games),
          goldDiff: num(vr.gold_diff), csDiff: num(vr.cs_diff),
          xpDiff: num(vr.xp_diff), damageDiff: num(vr.dmg_diff),
        } : null
      }
    } finally {
      client.release()
    }

    const payload = { champion, role, vs, stats, baseline, laning, laningVs }
    cache.set(cacheKey, { ts: Date.now(), payload })
    return Response.json(payload)
  } catch (e: any) {
    console.error("❌ getChampionBuildStats exception:", e?.message ?? e)
    return Response.json({ error: "Failed to compute build stats" }, { status: 500 })
  }
}
