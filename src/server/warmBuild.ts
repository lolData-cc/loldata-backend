// src/server/warmBuild.ts
//
// Warms the persistent L2 caches for the champion Build + Duos tabs so those
// endpoints read a jsonb row instead of aggregating the ~86M-row participants
// table per request:
//   • cbs_duos       — one Explorer ally-ranking per champion
//   • cbs_build_live — the heavy live enrichment per (champion, role)
// Popular/duos first, single-threaded (the supabase-db container's 64MB /dev/shm
// can't fit parallel hash workers), resumable via a 12h skip window.
//
// Run on the box:  bun run src/server/warmBuild.ts
// Nightly: invoked by scripts/refresh-cbs.sh after the cbs_* stats rebuild.

import { explorerPool } from "./explorer/pool"
import { computeLiveBuild, upsertBuildLive } from "./routes/getChampionBuild"
import { computeDuos, upsertDuosL2 } from "./routes/getChampionDuos"

// Duos has been failing 100% of the time (the Explorer self-join outruns the
// statement timeout for every champion). At 120s a pop that is ~5.6h of pure
// waste, which is what starved the build warm below: systemd killed the unit at
// its 2h TimeoutStartSec before build_live was ever touched. Two guards now:
// a much shorter per-champion timeout so a failure costs 25s instead of 120,
// and a hard wall-clock budget for the whole stage.
const DUO_STATEMENT_TIMEOUT_MS = 25_000
const DUO_STAGE_BUDGET_MS = 20 * 60 * 1000
const SKIP_DUOS = process.env.WARM_SKIP_DUOS === "1"

async function warmDuos(pool: ReturnType<typeof explorerPool>) {
  // ── duos (169 champions), popularity-ordered, N concurrent ──
  // Each compute is single-threaded (parallel=0, /dev/shm-safe); concurrency is
  // at the connection level, so a handful run at once to cut wall-clock ~4x.
  const champs = await pool.query(
    `SELECT c.id, c.name FROM champions c
     LEFT JOIN (SELECT champion_name, sum(games) AS g FROM cbs_champion_stats GROUP BY champion_name) cs
       ON cs.champion_name = c.name
     WHERE NOT EXISTS (
       SELECT 1 FROM cbs_duos d WHERE d.champ_key = c.id AND d.computed_at > now() - interval '12 hours'
     )
     ORDER BY cs.g DESC NULLS LAST`
  )
  const DUO_CONC = 1 // sequential: the box starves >1 concurrent Explorer self-join (→120s timeout)
  console.log(`[warmBuild] warming duos for ${champs.rows.length} champions (concurrency ${DUO_CONC})`)
  let dok = 0, dfail = 0
  const td = Date.now()
  let dcursor = 0
  const duoWorker = async () => {
    while (true) {
      const i = dcursor++
      if (i >= champs.rows.length) break
      if (Date.now() - td > DUO_STAGE_BUDGET_MS) {
        console.warn("[warmBuild] duos budget spent — stopping this stage")
        break
      }
      const c = champs.rows[i] as any
      const client = await pool.connect()
      try {
        await client.query(`SET statement_timeout = ${DUO_STATEMENT_TIMEOUT_MS}`)
        await client.query("SET max_parallel_workers_per_gather = 0")
        const payload = await computeDuos(client, Number(c.id), String(c.name))
        await upsertDuosL2(client, Number(c.id), payload)
        dok++
      } catch (e: any) {
        dfail++
        console.error(`[warmBuild] duos FAIL ${c.name}: ${e?.message ?? e}`)
      } finally {
        client.release()
      }
      if ((dok + dfail) % 25 === 0) console.log(`[warmBuild] duos ${dok} ok / ${dfail} fail / ${champs.rows.length}`)
    }
  }
  await Promise.all(Array.from({ length: DUO_CONC }, () => duoWorker()))
  console.log(`[warmBuild] duos DONE: ${dok} ok, ${dfail} fail in ${((Date.now() - td) / 1000).toFixed(0)}s`)
}

async function warmBuildLive(pool: ReturnType<typeof explorerPool>) {
  // ── build_live (per champion+role, popular first) ──
  const { rows } = await pool.query(
    `SELECT cs.champion_name, cs.role, cs.games
     FROM cbs_champion_stats cs
     WHERE cs.games >= 20
       AND NOT EXISTS (
         SELECT 1 FROM cbs_build_live b
         WHERE b.champion_name = cs.champion_name AND b.role = cs.role
           AND b.computed_at > now() - interval '12 hours'
       )
     ORDER BY cs.games DESC`
  )
  console.log(`[warmBuild] warming ${rows.length} (champion,role) build pairs`)
  let ok = 0, fail = 0
  const t0 = Date.now()
  for (const r of rows as any[]) {
    const client = await pool.connect()
    try {
      await client.query("SET statement_timeout = 120000")
      // Single-threaded (parallel workers exhaust the 64MB /dev/shm); high private
      // work_mem keeps the champion hash-aggregates in RAM instead of spilling.
      await client.query("SET work_mem = '128MB'")
      const live = await computeLiveBuild(client, r.champion_name, r.role, null, null, null, { parallel: 0 })
      await upsertBuildLive(client, r.champion_name, r.role, live)
      ok++
    } catch (e: any) {
      fail++
      console.error(`[warmBuild] build FAIL ${r.champion_name}/${r.role}: ${e?.message ?? e}`)
    } finally {
      client.release()
    }
    if ((ok + fail) % 25 === 0) {
      const rate = (ok + fail) / ((Date.now() - t0) / 1000)
      console.log(`[warmBuild] build ${ok} ok / ${fail} fail / ${rows.length} — ${rate.toFixed(2)}/s`)
    }
  }
  console.log(`[warmBuild] build DONE: ${ok} ok, ${fail} fail in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

async function main() {
  const pool = explorerPool()

  // ORDER MATTERS. build_live backs the champion Build tab, which is what a
  // user actually waits on; duos backs a secondary tab. Warming duos first
  // meant one broken stage could — and did — leave the Build tab reading live
  // from participants and timing out.
  await warmBuildLive(pool)

  if (SKIP_DUOS) {
    console.log("[warmBuild] duos skipped (WARM_SKIP_DUOS=1)")
  } else {
    await warmDuos(pool)
  }

  process.exit(0)
}

main().catch((e) => { console.error("[warmBuild] fatal:", e); process.exit(1) })
