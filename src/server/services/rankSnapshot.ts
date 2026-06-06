// src/server/services/rankSnapshot.ts
// Persists rank snapshots for puuids that appear in any scout lobby. Hooked
// after each match ingestion + on lobby create/update for baselining.

import { getRankedDataBySummonerId } from "../riot";
import { supabaseAdmin } from "../supabase/client";

const QUEUE_SOLO = "RANKED_SOLO_5x5";
const QUEUE_FLEX = "RANKED_FLEX_SR";

const TIER_ORDER = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
];
const DIVISION_ORDER: Record<string, number> = { IV: 1, III: 2, II: 3, I: 4 };

/**
 * Composite score for ranking. Sums tier (×1000) + division (×100) + lp.
 * Lets us compute LP gain across tier transitions safely.
 *   IRON IV 0   = 0
 *   GOLD IV 0   = 3000  + 100 = 3100
 *   MASTER 150  = 7000  + 100 + 150 = 7250
 *   CHALLENGER 4000 = 9000 + 100 + 4000 = 13100
 */
export function ladderScore(
  tier: string | null,
  division: string | null,
  lp: number
): number {
  if (!tier) return 0;
  const t = TIER_ORDER.indexOf(tier.toUpperCase());
  if (t < 0) return 0;
  const d = division ? DIVISION_ORDER[division.toUpperCase()] ?? 0 : 0;
  return t * 1000 + d * 100 + lp;
}

// Anti-spam: don't write a new snapshot if the latest existing one for this
// (puuid, queue) is identical and was taken in the last N minutes.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Fetch current ranked data and write a snapshot for solo + flex queues.
 * Idempotent within DEDUPE_WINDOW_MS — no-op if recent identical snapshot
 * already exists for the same puuid/queue/lp.
 *
 * Fire-and-forget friendly: catches errors internally.
 */
export async function writeRankSnapshot(
  puuid: string,
  region: string,
  matchId: string | null = null
): Promise<void> {
  const tag = puuid.slice(0, 8);
  let entries: any[];
  try {
    entries = await getRankedDataBySummonerId(puuid, region);
  } catch (err) {
    console.warn(
      `📸 rank snapshot ${tag}… Riot fetch FAILED:`,
      (err as any)?.message ?? err
    );
    return;
  }
  if (!Array.isArray(entries)) {
    console.warn(`📸 rank snapshot ${tag}… Riot returned non-array`);
    return;
  }
  if (entries.length === 0) {
    console.log(
      `📸 rank snapshot ${tag}… UNRANKED (Riot returned no league entries)`
    );
    return;
  }

  let written = 0;
  for (const e of entries) {
    const queueType = e?.queueType;
    if (queueType !== QUEUE_SOLO && queueType !== QUEUE_FLEX) continue;

    const tier: string | null = e?.tier ?? null;
    const rank: string | null = e?.rank ?? null;     // I / II / III / IV
    const lp: number = Number(e?.leaguePoints ?? 0);
    const wins: number = Number(e?.wins ?? 0);
    const losses: number = Number(e?.losses ?? 0);

    if (!tier) continue;

    // Dedupe — skip if a row identical to this one was taken recently.
    const { data: lastRow } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("tier, rank_division, lp, taken_at")
      .eq("puuid", puuid)
      .eq("queue_type", queueType)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastRow) {
      const sameRank =
        lastRow.tier === tier &&
        lastRow.rank_division === rank &&
        Number(lastRow.lp ?? 0) === lp;
      const recent =
        Date.now() - new Date(lastRow.taken_at).getTime() < DEDUPE_WINDOW_MS;
      if (sameRank && recent) continue;
    }

    const { error } = await supabaseAdmin.from("scout_rank_snapshots").insert({
      puuid,
      region: region.toUpperCase(),
      queue_type: queueType,
      tier,
      rank_division: rank,
      lp,
      wins,
      losses,
      match_id: matchId,
    });
    if (error) {
      console.warn(
        `📸 rank snapshot ${tag}… ${queueType} INSERT FAILED:`,
        error.message
      );
    } else {
      written++;
    }
  }

  if (written > 0) {
    console.log(
      `📸 rank snapshot ${tag}… ${region} wrote ${written} entries`
    );
  }
}

// Is this puuid currently in at least one scout lobby? Cheap lookup used to
// gate snapshot writes during match ingestion (we only track lobby accounts).
//
// Cache TTL was 60s — way too long: when you create a lobby and immediately
// play a game, the post-match snapshotIfTracked call hits a `false` cache
// entry (the puuid wasn't in any lobby ~60s ago) and silently skips the
// write. Dropping to 10s makes the window much narrower, AND we expose
// `invalidatePuuidLobbyCache` so scout routes can poke holes in the cache
// when a lobby is created/updated/refreshed.
const puuidInLobbyCache = new Map<string, { value: boolean; ts: number }>();
const PUUID_LOBBY_TTL = 10 * 1000; // 10s (was 60s — too stale)

/**
 * Drop one puuid from the cache (or wipe everything if no puuid passed).
 * Call this whenever the lobby↔puuid membership changes so the very next
 * snapshotIfTracked() reflects reality.
 */
export function invalidatePuuidLobbyCache(puuid?: string): void {
  if (puuid) puuidInLobbyCache.delete(puuid);
  else puuidInLobbyCache.clear();
}

export async function isPuuidInAnyLobby(puuid: string): Promise<boolean> {
  const cached = puuidInLobbyCache.get(puuid);
  if (cached && Date.now() - cached.ts < PUUID_LOBBY_TTL) {
    return cached.value;
  }
  const { data } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select("id")
    .eq("puuid", puuid)
    .limit(1)
    .maybeSingle();
  const value = !!data;
  puuidInLobbyCache.set(puuid, { value, ts: Date.now() });
  return value;
}

/**
 * Convenience: snapshot a puuid only if it's in some lobby. Fire-and-forget.
 *
 * Verbose-on-skip: we used to be silent when the puuid wasn't tracked,
 * which made it impossible to diagnose "LP isn't being tracked" complaints
 * from the outside. The skip log is one line per skipped puuid + matchId,
 * which is cheap and easy to grep.
 */
export async function snapshotIfTracked(
  puuid: string,
  region: string,
  matchId: string | null = null
): Promise<void> {
  const tag = puuid.slice(0, 8);
  try {
    const tracked = await isPuuidInAnyLobby(puuid);
    if (!tracked) {
      console.log(
        `📸 snapshotIfTracked ${tag}… match=${matchId ?? "-"} SKIPPED (not in any lobby)`
      );
      return;
    }
    await writeRankSnapshot(puuid, region, matchId);
  } catch (err) {
    console.warn(`📸 snapshotIfTracked ${tag}… error:`, err);
  }
}
