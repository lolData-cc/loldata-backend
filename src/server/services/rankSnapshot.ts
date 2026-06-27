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
 * Composite score expressed in REAL cumulative LP from IRON IV 0.
 *
 * Each tier IRON..DIAMOND has 4 divisions of 100 LP each = 400 LP per tier.
 * MASTER+ has no divisions — LP is unbounded and continues from where
 * DIAMOND I 100 ended.
 *
 *   IRON IV 0          = 0
 *   IRON IV 50         = 50
 *   IRON III 0         = 100
 *   IRON I 99          = 399
 *   BRONZE IV 0        = 400         (one tier above IRON I 100)
 *   PLATINUM I 50      = 4·400 + 3·100 + 50 = 1950
 *   EMERALD IV 50      = 5·400 + 0·100 + 50 = 2050
 *     → PLAT I 50 → EME IV 50 delta = 100  ✓
 *   DIAMOND I 100      = 6·400 + 3·100 + 100 = 2800
 *   MASTER 0           = 7·400 + 0          = 2800
 *   MASTER 150         = 7·400 + 150        = 2950
 *   CHALLENGER 1000    = 7·400 + 1000       = 3800
 *
 * Old formula did tier × 1000 + division × 100 + lp, which inflated
 * every cross-tier delta by 600 LP (since each tier has at most 400
 * LP of room). That's why Plat I 50 → Emerald IV 50 reported as +700.
 */
const LP_PER_DIVISION = 100;
const DIVISIONS_PER_TIER = 4;
const LP_PER_TIER = LP_PER_DIVISION * DIVISIONS_PER_TIER; // 400

export function ladderScore(
  tier: string | null,
  division: string | null,
  lp: number
): number {
  if (!tier) return 0;
  const t = TIER_ORDER.indexOf(tier.toUpperCase());
  if (t < 0) return 0;

  // MASTER+ has no division; LP is uncapped and continues from where
  // DIAMOND I 100 leaves off.
  if (t >= TIER_ORDER.indexOf("MASTER")) {
    return TIER_ORDER.indexOf("MASTER") * LP_PER_TIER + lp;
  }

  // IRON..DIAMOND: division IV=1 (lowest) … I=4 (highest, 0-99 LP).
  // Cumulative offset = (division − 1) × 100, so IV contributes 0 LP,
  // I contributes 300 LP, with the LP value itself adding 0-99.
  const dIdx = division ? DIVISION_ORDER[division.toUpperCase()] ?? 1 : 1;
  return t * LP_PER_TIER + (dIdx - 1) * LP_PER_DIVISION + lp;
}

// Match-v5 queueId → league-v4 queueType. The ONLY place that knows the ranked
// queues we LP-track; extend it to add a queue everywhere at once.
//   420 Solo, 440 Flex. Ranked 5s (relaunched 2026-06-26 weekend queue) has its
//   own separate LP ladder — slot its (queueId → queueType) here once confirmed
//   from live league-v4 / match-v5 data.
export const RANKED_QUEUE_TYPE: Record<number, string> = {
  420: "RANKED_SOLO_5x5",
  440: "RANKED_FLEX_SR",
};

export type MatchLpInput = { matchId: string; queueId: number; gameEndMs: number };

/**
 * Per-match LP delta for a puuid, computed from its rank snapshots with the
 * same before/after matching the scout feed uses (prefer the match_id-linked
 * post-game snapshot, else the first snapshot taken at/after game end; the
 * "before" is the one immediately preceding it). ladderScore delta so promo/
 * demote games count correctly. Returns matchId → lpDelta, or null when there
 * isn't a before+after pair (e.g. non-tracked accounts have no snapshots).
 */
export async function computeLpDeltas(
  puuid: string,
  matches: MatchLpInput[]
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!matches.length) return out;
  const queueTypes = [
    ...new Set(matches.map((m) => RANKED_QUEUE_TYPE[m.queueId]).filter(Boolean)),
  ];
  if (!queueTypes.length) return out;

  // Most-RECENT 5000 (DESC + reverse to chronological). An active tracked
  // account can have thousands of snapshots; an ASC limit would return the
  // OLDEST and miss the ones bracketing today's games → lpDelta always null.
  const { data } = await supabaseAdmin
    .from("scout_rank_snapshots")
    .select("queue_type, tier, rank_division, lp, taken_at, match_id")
    .eq("puuid", puuid)
    .in("queue_type", queueTypes)
    .order("taken_at", { ascending: false })
    .limit(5000);

  const byQueue = new Map<string, any[]>();
  for (const s of ((data ?? []) as any[]).slice().reverse()) {
    if (!byQueue.has(s.queue_type)) byQueue.set(s.queue_type, []);
    byQueue.get(s.queue_type)!.push(s);
  }

  for (const m of matches) {
    const qt = RANKED_QUEUE_TYPE[m.queueId];
    const list = qt ? byQueue.get(qt) : undefined;
    if (!list || list.length < 2) {
      out.set(m.matchId, null);
      continue;
    }
    let afterIdx = list.findIndex((s) => s.match_id === m.matchId);
    if (afterIdx === -1) {
      afterIdx = list.findIndex(
        (s) => new Date(s.taken_at).getTime() >= m.gameEndMs
      );
    }
    if (afterIdx <= 0) {
      out.set(m.matchId, null);
      continue;
    }
    const before = list[afterIdx - 1];
    const after = list[afterIdx];
    const delta =
      ladderScore(after.tier, after.rank_division, Number(after.lp ?? 0)) -
      ladderScore(before.tier, before.rank_division, Number(before.lp ?? 0));
    if (delta === 0) {
      const ctx = list
        .slice(Math.max(0, afterIdx - 2), afterIdx + 2)
        .map((s: any) => `${s.lp}lp@${new Date(s.taken_at).toISOString().slice(5, 16)} mid=${(s.match_id || "-").slice(-6)}`)
        .join(" | ");
      console.log(`[lpdiag] m=${m.matchId.slice(-6)} ZERO afterIdx=${afterIdx} byMid=${after.match_id === m.matchId} gameEnd=${new Date(m.gameEndMs).toISOString().slice(5, 16)} ctx=[${ctx}]`);
    }
    out.set(m.matchId, delta);
  }
  return out;
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
  // BOX_READ_ONLY — during the self-host migration the box backend shares
  // the prod Riot key with Railway. Writing a rank snapshot is a Riot
  // side-effect (it fetches league-v4 BEFORE deduping), so the box must
  // no-op here to avoid competing for the shared rate budget. Unset on
  // prod/Railway → full behavior. Covers EVERY caller (periodic sweep,
  // opportunistic lobby-read snapshot, refresh endpoints, post-match hook).
  if (process.env.BOX_READ_ONLY === "true") return;
  const tag = puuid.slice(0, 8);

  // Pre-fetch dedup — skip the league-v4 Riot call ENTIRELY if we already
  // snapshotted this puuid within the dedup window. Snapshots for solo + flex
  // are written together in one call, so a recent row means both queues are
  // already current. Without this, the per-queue dedup further down still ran
  // the (wasted) Riot fetch on every call — which is what stormed league-v4
  // when many scout lobby reads / the periodic sweep hit the same accounts.
  {
    const { data: recent } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("taken_at")
      .eq("puuid", puuid)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (
      recent?.taken_at &&
      Date.now() - new Date(recent.taken_at).getTime() < DEDUPE_WINDOW_MS
    ) {
      return;
    }
  }

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
  let dedupedSkips = 0;
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
      if (sameRank && recent) {
        dedupedSkips++;
        console.log(
          `📸 rank snapshot ${tag}… ${queueType} DEDUPED (last=${lastRow.tier} ${lastRow.rank_division} ${lastRow.lp}lp, current=${tier} ${rank} ${lp}lp, age=${Math.round((Date.now() - new Date(lastRow.taken_at).getTime()) / 1000)}s)`
        );
        continue;
      }
      // Different from last row OR last row is old enough — log the
      // delta we're about to write, so it's easy to follow LP changes
      // in the server log.
      const lastScore = lastRow.tier ? ladderScore(lastRow.tier, lastRow.rank_division, Number(lastRow.lp ?? 0)) : 0;
      const newScore = ladderScore(tier, rank, lp);
      const delta = newScore - lastScore;
      console.log(
        `📸 rank snapshot ${tag}… ${queueType} CHANGE: ${lastRow.tier} ${lastRow.rank_division} ${lastRow.lp}lp → ${tier} ${rank} ${lp}lp (Δ=${delta >= 0 ? "+" : ""}${delta})`
      );
    } else {
      console.log(
        `📸 rank snapshot ${tag}… ${queueType} FIRST SNAPSHOT: ${tier} ${rank} ${lp}lp`
      );
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

  console.log(
    `📸 rank snapshot ${tag}… ${region} done: wrote=${written} deduped=${dedupedSkips}`
  );
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
