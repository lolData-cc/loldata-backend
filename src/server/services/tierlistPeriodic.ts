// src/server/services/tierlistPeriodic.ts
// Nightly tier-list snapshot regeneration.
//
// The tier list is served from the `tierlist_snapshots` table (newest
// snapshot_date wins). Nothing was ever scheduled to refresh it — the
// snapshot was only minted by a manual POST /api/tierlist/snapshot — so it
// froze at whatever date someone last ran by hand, drifting staler every day
// as the box keeps ingesting matches the tier list never re-aggregates.
//
// This mirrors startScoutPeriodicSweep(): an in-process timer in the
// already-running backend. generateSnapshotHandler() reads fresh box data via
// supabaseMatchAdmin and is invoked in-process (so it is NOT subject to the
// 120s HTTP idleTimeout, even if the heavy participants-paging fallback runs).
//
//   • a catch-up run shortly after boot, so a freshly-deployed/restarted box
//     refreshes the (currently stale) snapshot right away;
//   • then once every night at 03:30 box-local — deliberately AFTER the 03:00
//     cron ingest, so the night's new matches are already in the box.

import { generateSnapshotHandler } from "../routes/getTierlist";

const NIGHTLY_HOUR = 3;
const NIGHTLY_MIN = 30;
const BOOT_CATCHUP_MS = 120_000; // 2 min after boot, once the server is warm

let started = false;

async function runSnapshot(reason: string): Promise<void> {
  const startedAt = Date.now();
  console.log(`[tierlist-nightly] regenerating snapshot (${reason})…`);
  try {
    const res = await generateSnapshotHandler(
      new Request("http://internal/api/tierlist/snapshot", { method: "POST" })
    );
    let detail = "";
    try {
      const body = (await res.json()) as any;
      detail = body?.snapshot_date
        ? `date=${body.snapshot_date} patch=${body.patch ?? "?"} rows=${body.inserted ?? body.rows ?? "?"}`
        : JSON.stringify(body).slice(0, 160);
    } catch {
      /* non-JSON body — ignore */
    }
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (res.ok) {
      console.log(`[tierlist-nightly] done in ${secs}s — ${detail}`);
    } else {
      console.error(`[tierlist-nightly] handler returned ${res.status} in ${secs}s — ${detail}`);
    }
  } catch (e) {
    console.error("[tierlist-nightly] snapshot crashed:", (e as any)?.message ?? e);
  }
}

// ms from now until the next local HH:MM
function msUntilNext(hour: number, min: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, min, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNightly(): void {
  const wait = msUntilNext(NIGHTLY_HOUR, NIGHTLY_MIN);
  const hrs = (wait / 3_600_000).toFixed(1);
  console.log(`[tierlist-nightly] next run in ${hrs}h (at ${NIGHTLY_HOUR}:${String(NIGHTLY_MIN).padStart(2, "0")} local)`);
  setTimeout(async () => {
    await runSnapshot("nightly");
    scheduleNightly(); // re-arm for the following night
  }, wait);
}

/**
 * Start the nightly tier-list refresh. Safe to call multiple times — extra
 * calls are no-ops. Does a catch-up run ~2 min after boot, then nightly at
 * 03:30 box-local.
 */
export function startTierlistNightly(): void {
  if (started) return;
  started = true;
  console.log("[tierlist-nightly] scheduled: catch-up in 2min, then nightly at 03:30 local");
  setTimeout(() => runSnapshot("boot catch-up"), BOOT_CATCHUP_MS);
  scheduleNightly();
}
