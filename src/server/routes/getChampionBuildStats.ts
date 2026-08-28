// routes/getChampionBuildStats.ts
//
// POST /api/champion/build-stats  body: { champKey, champion, role?, vs?, patch?, region? }
//
// The "deep stats" companion to /api/champion/build — everything the Build tab
// needs to feel like a real analytics page:
//   • stats   — per-game performance averages for this champion+role
//   • baseline— the SAME metrics averaged across every champion in the role, so
//               the UI can draw "vs role average" comparison bars
//   • laning  — @10 averages (gold/cs/xp/kda/damage)
//   • laningVs— when a lane opponent (vs) is set, the @10 DIFFS against them
//   • gameLength/skillOrder — win-rate-by-length + most-common ability order
//
// PERF: `participants` is ~86M rows and under constant ingest writes, so live
// aggregation over it can't meet a request budget (a single champion+role scan
// is ~20s cold → the endpoint used to time out and 500 under load). The DEFAULT
// cohort (no patch/region filter — the overwhelming majority of traffic) is now
// served from precomputed `cbs_*` summary tables (refreshed by refresh-build-
// stats.ts, ~70s for a full pass) → sub-millisecond reads. Only the rare
// patch/region-filtered cohorts fall back to the live path.

import { getChampRoles } from "./getChampionStats"
import { explorerPool } from "../explorer/pool"

type Cached = { ts: number; payload: unknown }
const cache = new Map<string, Cached>()
// 1h: skillOrder/gameLength keep ACCRUING from ingest, so a shorter TTL lets a
// champ's chart "light up" within ~1h of crossing the sample threshold.
const TTL_MS = 1 * 60 * 60 * 1000

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

// Same cohort, but applied to an already-JOINed `matches m`.
function patchRegionOnM(startIdx: number, fPatch: string | null, fRegion: string | null): { sql: string; params: any[] } {
  const params: any[] = []
  let i = startIdx
  const mp: string[] = []
  if (fPatch) { params.push(fPatch); mp.push(`m.patch = $${i++}`) }
  if (fRegion) { params.push(fRegion); mp.push(`m.platform = $${i++}`) }
  return { sql: mp.length ? ` AND ${mp.join(" AND ")}` : "", params }
}

// 5-min game-length buckets from 15 min (width_bucket index → label/start-min).
const LENGTH_BUCKETS = [
  { b: 1, label: "15-20", min: 15 },
  { b: 2, label: "20-25", min: 20 },
  { b: 3, label: "25-30", min: 25 },
  { b: 4, label: "30-35", min: 30 },
  { b: 5, label: "35-40", min: 35 },
  { b: 6, label: "40+", min: 40 },
]

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

type Out = { stats: any; baseline: any; laning: any; laningVs: any; gameLength: any[] | null; skillOrder: any }

// ── Skill-order shaping shared by both paths (rows: {idx, slot, n}) ──
function shapeSkillOrder(rows: any[]): any {
  if (!rows.length) return null
  const perLevel: number[] = new Array(18).fill(0)
  let sample = 0
  for (const r of rows) {
    const i = Number(r.idx)
    if (i >= 1 && i <= 18) perLevel[i - 1] = Number(r.slot)
    if (i === 1) sample = Number(r.n)
  }
  const fifthAt = (slot: number) => {
    let c = 0
    for (let i = 0; i < perLevel.length; i++) if (perLevel[i] === slot && ++c === 5) return i
    return 99
  }
  const priority = [1, 2, 3].map((s) => ({ s, at: fifthAt(s) })).filter((x) => x.at < 99).sort((a, b) => a.at - b.at).map((x) => x.s)
  return { sample, perLevel, priority }
}
function shapeGameLength(rows: any[]): any[] {
  const byBucket = new Map<number, { games: number; winrate: number }>()
  for (const r of rows) byBucket.set(Number(r.b), { games: Number(r.games), winrate: Number(r.winrate) })
  return LENGTH_BUCKETS.map((bk) => {
    const hit = byBucket.get(bk.b)
    return { label: bk.label, min: bk.min, games: hit?.games ?? 0, winrate: hit ? hit.winrate : null }
  })
}

// ── FAST PATH: default cohort from precomputed cbs_* summary tables ──
async function computeFromSummary(client: any, champion: string, role: string | null, vs: string | null): Promise<Out> {
  // champion stats + laning @10 live in one summary row.
  const cs = await client.query(
    `SELECT * FROM cbs_champion_stats
     WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2)
     ORDER BY games DESC LIMIT 1`,
    [champion, role]
  )
  const crow = cs.rows[0] ?? null
  const stats = shapeStats(crow)
  const laning = crow && Number(crow.ln_n) > 0 ? {
    games: Number(crow.ln_n),
    gold: num(crow.ln_gold), cs: num(crow.ln_cs), xp: num(crow.ln_xp),
    kills: num(crow.ln_k), deaths: num(crow.ln_d), assists: num(crow.ln_a), damage: num(crow.ln_dmg),
  } : null

  let baseline: any = null
  if (role) {
    const b = await client.query(`SELECT * FROM cbs_baseline WHERE role = $1`, [role])
    baseline = shapeStats(b.rows[0])
  }

  const g = await client.query(
    `SELECT bucket AS b, games, winrate FROM cbs_gamelength
     WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2)`,
    [champion, role]
  )
  const gameLength = shapeGameLength(g.rows)

  const sk = await client.query(
    `SELECT idx, slot, n FROM cbs_skillorder
     WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2) ORDER BY idx`,
    [champion, role]
  )
  const skillOrder = shapeSkillOrder(sk.rows)

  // laningVs — role-wide @10 averages differenced against the opponent's. This
  // is an approximation of the per-game paired diff (which needs a 20s self-join
  // over 86M rows), accurate enough for the "who's ahead at 10" comparison bars.
  let laningVs: any = null
  if (vs && role && crow && Number(crow.ln_n) > 0) {
    const o = await client.query(
      `SELECT ln_n, ln_gold, ln_cs, ln_xp, ln_dmg FROM cbs_champion_stats WHERE champion_name = $1 AND role = $2`,
      [vs, role]
    )
    const orow = o.rows[0]
    if (orow && Number(orow.ln_n) > 0) {
      const diff = (a: any, b: any) => (a != null && b != null ? Number(a) - Number(b) : null)
      laningVs = {
        games: Math.min(Number(crow.ln_n), Number(orow.ln_n)),
        goldDiff: diff(crow.ln_gold, orow.ln_gold),
        csDiff: diff(crow.ln_cs, orow.ln_cs),
        xpDiff: diff(crow.ln_xp, orow.ln_xp),
        damageDiff: diff(crow.ln_dmg, orow.ln_dmg),
        approx: true,
      }
    }
  }

  return { stats, baseline, laning, laningVs, gameLength, skillOrder }
}

// ── LIVE PATH: patch/region-filtered cohorts (rare). Aggregates raw
// participants; single-threaded to avoid exhausting the db /dev/shm. ──
async function computeLive(
  client: any, champion: string, role: string | null, vs: string | null,
  fPatch: string | null, fRegion: string | null
): Promise<Out> {
  await client.query("SET max_parallel_workers_per_gather = 0")

  const cf = patchRegionFilter(3, fPatch, fRegion)
  const sres = await client.query(
    `SELECT ${STAT_SELECT} FROM participants
     WHERE champion_name = $1 AND ($2::text IS NULL OR role = $2)${cf.sql}`,
    [champion, role, ...cf.params]
  )
  const stats = shapeStats(sres.rows[0])

  let baseline: any = null
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
  const laning = lr && Number(lr.n) > 0 ? {
    games: Number(lr.n),
    gold: num(lr.gold10), cs: num(lr.cs10), xp: num(lr.xp10),
    kills: num(lr.k10), deaths: num(lr.d10), assists: num(lr.a10), damage: num(lr.dmg10),
  } : null

  let laningVs: any = null
  if (vs && role) {
    const vf = patchRegionFilter(4, fPatch, fRegion)
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

  const gf = patchRegionOnM(3, fPatch, fRegion)
  const gres = await client.query(
    `SELECT width_bucket(m.game_duration_seconds, ARRAY[900,1200,1500,1800,2100,2400]) AS b,
            count(*)::int AS games,
            round(avg((p.win)::int) * 100, 2)::float8 AS winrate
     FROM participants p
     JOIN matches m ON m.match_id = p.match_id
     WHERE p.champion_name = $1 AND ($2::text IS NULL OR p.role = $2)
       AND m.game_duration_seconds >= 900${gf.sql}
     GROUP BY b`,
    [champion, role, ...gf.params]
  )
  const gameLength = shapeGameLength(gres.rows)

  const skf = patchRegionFilter(3, fPatch, fRegion)
  const skres = await client.query(
    `SELECT idx, mode() WITHIN GROUP (ORDER BY slot)::int AS slot, count(*)::int AS n
     FROM participants p, unnest(p.skill_order) WITH ORDINALITY AS u(slot, idx)
     WHERE p.champion_name = $1 AND ($2::text IS NULL OR p.role = $2) AND p.skill_order IS NOT NULL${skf.sql}
     GROUP BY idx ORDER BY idx`,
    [champion, role, ...skf.params]
  )
  const skillOrder = shapeSkillOrder(skres.rows)

  return { stats, baseline, laning, laningVs, gameLength, skillOrder }
}

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

    const defaultCohort = !fPatch && !fRegion
    const client = await explorerPool().connect()
    let out: Out
    try {
      await client.query("SET statement_timeout = 20000")
      out = defaultCohort
        ? await computeFromSummary(client, champion, role, vs)
        : await computeLive(client, champion, role, vs, fPatch, fRegion)
    } finally {
      client.release()
    }

    const payload = { champion, role, vs, ...out }
    cache.set(cacheKey, { ts: Date.now(), payload })
    return Response.json(payload)
  } catch (e: any) {
    console.error("❌ getChampionBuildStats exception:", e?.message ?? e)
    return Response.json({ error: "Failed to compute build stats" }, { status: 500 })
  }
}
