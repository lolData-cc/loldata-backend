// src/server/services/scoutPeriodic.ts
// Periodic background sweep over every puuid that's in any scout lobby.
//
// Purpose: keep rank snapshots flowing even when nobody is viewing the
// lobby. Without this, LP deltas in the feed get computed against a
// stale baseline because the only thing writing snapshots was the
// interactive REFRESH button. Players grind through 15 games at night,
// nobody opens the dashboard → no snapshots → no LP deltas displayed
// the next morning.
//
// What it does each cycle:
//   1. SELECT every (puuid, region) pair from scout_lobby_accounts
//   2. Dedupe (a single puuid can be in N lobbies)
//   3. For each puuid: writeRankSnapshot — a single league-v4 call that
//      no-ops if rank hasn't moved since the last snapshot
//   4. Pace calls so we don't burn through the Riot quota
//
// Match ingestion is intentionally NOT in here — the feed pulls fresh
// match-v5 data on every render via the Riot-direct path. Snapshots
// are the only piece the cron needs to babysit.

import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client";
import { writeRankSnapshot } from "./rankSnapshot";
import { ensureDailyBounty } from "./scoutBounty";
import { sweepScoutWebhooks } from "./scoutWebhookSweep";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;     // 5 min cadence
const PER_CALL_DELAY_MS = 250;                // ~4 calls/sec safety pace
const INITIAL_DELAY_MS = 30_000;               // give the server time to warm up

let started = false;

async function sweepOnce(): Promise<void> {
  const startedAt = Date.now();

  const { data: rows, error } = await supabaseMatchAdmin
    .from("scout_lobby_accounts")
    .select("puuid, region");

  if (error) {
    console.error("[scout-periodic] account list error:", error.message);
    return;
  }
  if (!rows || rows.length === 0) {
    return;
  }

  // Dedupe — same puuid can sit in many lobbies. First region wins.
  const puuidToRegion = new Map<string, string>();
  for (const r of rows as Array<{ puuid: string; region: string }>) {
    if (!puuidToRegion.has(r.puuid)) puuidToRegion.set(r.puuid, r.region);
  }

  // ALSO snapshot every PREMIUM/ELITE user's linked account — their LP is now
  // tracked across ALL their ranked games (surfaced per-match on the summoner
  // page), not just inside scout lobbies. Same writeRankSnapshot path + dedupe.
  let premiumAdded = 0;
  {
    const { data: premium, error: pErr } = await supabaseAdmin
      .from("profile_players")
      .select("puuid, region")
      .in("plan", ["premium", "elite"])
      .not("puuid", "is", null);
    if (pErr) {
      console.warn("[scout-periodic] premium account list error:", pErr.message);
    } else {
      for (const r of (premium ?? []) as Array<{ puuid: string; region: string }>) {
        if (r.puuid && r.region && !puuidToRegion.has(r.puuid)) {
          puuidToRegion.set(r.puuid, r.region);
          premiumAdded++;
        }
      }
    }
  }
  if (premiumAdded > 0) {
    console.log(`[scout-periodic] +${premiumAdded} premium/elite accounts to snapshot`);
  }

  const total = puuidToRegion.size;
  let ok = 0;
  let failed = 0;

  for (const [puuid, region] of puuidToRegion) {
    try {
      await writeRankSnapshot(puuid, region);
      ok++;
    } catch (e) {
      failed++;
      console.warn(
        `[scout-periodic] ${puuid.slice(0, 8)}… snapshot failed:`,
        (e as any)?.message ?? e
      );
    }
    // Pace ourselves. writeRankSnapshot's internal dedupe will keep
    // wasted work down but we still want spacing between Riot calls.
    if (PER_CALL_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
    }
  }

  // Roll today's daily bounty for every recently-active lobby. The /today
  // read is otherwise the ONLY thing that mints a bounty, so a lobby nobody
  // opens right at local midnight would stay frozen on yesterday's. Cheap +
  // idempotent: a fast-path SELECT on the days the row already exists.
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: lobbies } = await supabaseMatchAdmin
      .from("scout_lobbies")
      .select("slug, last_active_at")
      .gte("last_active_at", sevenDaysAgo);
    let bountyOk = 0;
    for (const l of (lobbies ?? []) as Array<{ slug: string }>) {
      try {
        await ensureDailyBounty(l.slug);
        bountyOk++;
      } catch (e) {
        console.warn(
          `[scout-periodic] bounty ensure failed for ${l.slug}:`,
          (e as any)?.message ?? e
        );
      }
    }
    if (lobbies && lobbies.length > 0) {
      console.log(
        `[scout-periodic] bounties ensured: ${bountyOk}/${lobbies.length} active lobbies`
      );
    }
  } catch (e) {
    console.warn(
      "[scout-periodic] bounty ensure sweep failed:",
      (e as any)?.message ?? e
    );
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[scout-periodic] sweep done: ${ok}/${total} ok, ${failed} failed in ${(elapsedMs / 1000).toFixed(1)}s`
  );

  // Discord webhook delivery — polls for freshly finished games in lobbies
  // that opted in, then posts the feed-style embed. Isolated in its own try
  // so a webhook problem can never abort the snapshot sweep above.
  try {
    await sweepScoutWebhooks();
  } catch (e) {
    console.error("[scout-periodic] webhook sweep crashed:", e);
  }
}

async function loop(): Promise<void> {
  try {
    await sweepOnce();
  } catch (e) {
    console.error("[scout-periodic] sweep crashed:", e);
  } finally {
    setTimeout(loop, SWEEP_INTERVAL_MS);
  }
}

/**
 * Start the periodic sweep. Safe to call multiple times — extra calls
 * are no-ops. Schedules the first run after INITIAL_DELAY_MS so the
 * server boot stays clean.
 */
export function startScoutPeriodicSweep(): void {
  if (started) return;
  started = true;
  console.log(
    `[scout-periodic] scheduled: first sweep in ${INITIAL_DELAY_MS / 1000}s, then every ${SWEEP_INTERVAL_MS / 1000}s`
  );
  setTimeout(loop, INITIAL_DELAY_MS);
}
