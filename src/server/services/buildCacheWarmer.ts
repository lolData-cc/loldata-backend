// src/server/services/buildCacheWarmer.ts
//
// Pre-warms the in-memory cache behind POST /api/champion/build.
//
// Why: the build payload is ~7 heavy aggregations over the (huge) participants
// table — measured 3-7s COLD — but only ~0.2s once cached for 6h. That cache is
// in-process, so it is wiped on every restart/deploy, and each champion also
// expires every 6h. The net effect was that the FIRST visitor of each champion
// (and everyone right after a deploy) stared at a 3-7s spinner on the Build tab.
//
// This mirrors startTierlistNightly()/startScoutPeriodicSweep(): an in-process
// timer that, shortly after boot and then on a fixed interval (< the 6h TTL so
// nothing ever expires), calls getChampionBuildHandler() IN-PROCESS for every
// champion's DEFAULT view — no role/patch/region. The handler then resolves the
// champion's top role itself, producing exactly the cache key the frontend's
// initial Build-tab load hits, so that load becomes a ~0.2s cache hit.
//
// Role switches and patch/region/vs cohorts are intentionally NOT pre-warmed
// (too many combinations); they stay on-demand and warm themselves on first use.
//
// Safety: concurrency is low (default 2, the explorer pool is max 6) and the
// handler's queries already carry a 15s statement_timeout, so the warm burst
// can't starve live API traffic or the ingest. We also wait for the champion
// snapshots to finish loading first — warming before they're ready would cache a
// role-less (and therefore buildPath/preciseRunes-less) payload for 6h.

import { getChampionBuildHandler } from "../routes/getChampionBuild";
import { snapshotsLoaded } from "../routes/getChampionStats";

const BOOT_DELAY_MS = 60_000; // after boot — server warm + snapshots usually loaded
const REFRESH_EVERY_MS = 5 * 60 * 60 * 1000; // 5h: under the handler's 6h TTL → keys never go cold
const CONCURRENCY = Math.max(1, Number(process.env.BUILD_WARM_CONCURRENCY ?? 2));
const SNAP_WAIT_MAX_MS = 5 * 60 * 1000; // give the snapshot preload up to 5 min

let started = false;

type Champ = { key: number; name: string };

// All champions (numeric key + Data Dragon id/name) — same source getTierlist
// uses to fill missing names. Fetched once, then reused across warm cycles.
let _champs: Champ[] | null = null;
async function loadChampions(): Promise<Champ[]> {
  if (_champs) return _champs;
  const vres = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
  const versions = (await vres.json()) as string[];
  const v = versions[0];
  const cres = await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`);
  const cdata = (await cres.json()) as { data: Record<string, { key: string; id: string }> };
  const list = Object.values(cdata.data)
    .map((c) => ({ key: Number(c.key), name: c.id }))
    .filter((c) => Number.isFinite(c.key) && !!c.name);
  _champs = list;
  return list;
}

async function warmOne(c: Champ): Promise<boolean> {
  try {
    const res = await getChampionBuildHandler(
      new Request("http://internal/api/champion/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ champKey: c.key, champion: c.name }),
      })
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForSnapshots(): Promise<boolean> {
  const t0 = Date.now();
  while (!snapshotsLoaded()) {
    if (Date.now() - t0 > SNAP_WAIT_MAX_MS) return false;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return true;
}

async function runWarm(reason: string): Promise<void> {
  if (!(await waitForSnapshots())) {
    console.warn(`[build-warm] snapshots not ready after wait (${reason}); skipping this cycle`);
    return;
  }

  let champs: Champ[];
  try {
    champs = await loadChampions();
  } catch (e) {
    console.error(`[build-warm] could not load champion list (${reason}):`, (e as Error)?.message ?? e);
    return;
  }

  const startedAt = Date.now();
  console.log(`[build-warm] warming ${champs.length} champions (${reason}, concurrency=${CONCURRENCY})…`);

  let idx = 0;
  let ok = 0;
  let fail = 0;
  async function worker() {
    while (idx < champs.length) {
      const c = champs[idx++];
      if (await warmOne(c)) ok++;
      else fail++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[build-warm] done in ${secs}s — ${ok} ok, ${fail} failed`);
}

/** Schedule the build-cache pre-warm: a boot catch-up, then every 5h. */
export function startBuildCacheWarmer(): void {
  if (started) return;
  started = true;

  setTimeout(() => {
    void runWarm("boot catch-up");
    setInterval(() => void runWarm("interval"), REFRESH_EVERY_MS);
  }, BOOT_DELAY_MS);

  console.log(
    `[build-warm] scheduled — boot in ${Math.round(BOOT_DELAY_MS / 1000)}s, then every ${Math.round(
      REFRESH_EVERY_MS / 3_600_000
    )}h (concurrency=${CONCURRENCY})`
  );
}
