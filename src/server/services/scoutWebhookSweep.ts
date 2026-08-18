// src/server/services/scoutWebhookSweep.ts
//
// The "a lobby member just finished a game" detector that feeds the Discord
// webhooks. Runs from the scout periodic sweep.
//
// Why a detector is needed at all: nothing server-side watched for new matches
// before — the lobby feed pulls match-v5 live on every render, so a game only
// "existed" once a human opened the page. A webhook has to fire with nobody
// watching, hence this poll.
//
// Riot budget: only lobbies that ACTUALLY have an enabled webhook are polled
// (opt-in), one match-ids call per account per cycle, paced. A lobby with 5
// accounts costs 5 calls / 5 min — negligible next to the ingest.
//
// Ordering guarantees:
//   • dedupe ledger keyed (webhook_id, match_id) → a match posts at most once
//     per webhook, even if the sweep overlaps or several members shared it
//   • a first-ever sweep for a webhook back-fills nothing: matches older than
//     the webhook row are marked as posted without sending, so enabling an
//     integration never dumps history into the channel

import { supabaseAdmin } from "../supabase/client";
import { getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { ladderScore } from "./rankSnapshot";
import { lookupBadgeIdentities } from "./proBadges";
import {
  buildMatchEmbeds,
  postToWebhook,
  type WebhookMatchPayload,
  type WebhookNotable,
  type WebhookPlayerLine,
} from "./scoutWebhook";

const PER_CALL_DELAY_MS = 300;
// How far back to look for "just finished" games. Generous vs the 5-min sweep
// so a slow Riot index or a skipped cycle can't lose a game.
const LOOKBACK_MS = 3 * 60 * 60 * 1000;   // 3h
const MAX_MATCHES_PER_ACCOUNT = 5;
const MAX_POSTS_PER_SWEEP = 12;           // channel flood guard
const AUTO_DISABLE_AFTER = 10;            // consecutive failures

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type WebhookRow = {
  id: string;
  lobby_slug: string;
  url: string;
  enabled: boolean;
  queue_filter: number[] | null;
  min_duration_s: number;
  created_at: string;
  fail_count: number;
  username: string | null;
  avatar_url: string | null;
};

type AccountRow = {
  puuid: string;
  region: string;
  lobby_player_id: string;
  scout_lobby_players: {
    id: string;
    display_name: string;
    lobby_slug: string;
  } | null;
};

/** Average ladder score over the participants we have a rank for. */
async function averageLobbyElo(puuids: string[]): Promise<number | null> {
  if (puuids.length === 0) return null;
  // Latest solo snapshot per puuid — cheap, already collected by the sweep.
  const { data, error } = await supabaseAdmin
    .from("scout_rank_snapshots")
    .select("puuid, tier, rank_division, lp, created_at")
    .in("puuid", puuids)
    .eq("queue_type", "RANKED_SOLO_5x5")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data || data.length === 0) return null;

  const seen = new Set<string>();
  const scores: number[] = [];
  for (const r of data as any[]) {
    if (seen.has(r.puuid)) continue;
    seen.add(r.puuid);
    const s = ladderScore(r.tier ?? null, r.rank_division ?? null, r.lp ?? 0);
    if (s > 0) scores.push(s);
  }
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

type LpResult = {
  lpDelta: number | null;
  tier: string | null;
  division: string | null;
  lp: number | null;
  rankChange: "PROMOTION" | "DEMOTION" | null;
};

const NO_LP: LpResult = {
  lpDelta: null, tier: null, division: null, lp: null, rankChange: null,
};

/**
 * LP change for one player in one game, using the SAME rule as the scout feed
 * (`readScoutFeedHandler`): find the post-match rank snapshot — by its
 * `match_id` link, else the first one taken at/after the game ended — and diff
 * it against the snapshot before it.
 *
 * The delta always goes through ladderScore, never `after.lp - before.lp`: on a
 * promotion/demotion the raw LP numbers reset (EMERALD III 0 LP → EMERALD IV
 * 75 LP is a real −25, not +75).
 *
 * Only ranked queues have LP. Returns nulls rather than guessing — the snapshot
 * pair genuinely may not exist yet.
 */
async function resolveLp(
  puuid: string,
  matchId: string,
  queueId: number | null,
  gameEndMs: number
): Promise<LpResult> {
  const queueType =
    queueId === 420 ? "RANKED_SOLO_5x5" : queueId === 440 ? "RANKED_FLEX_SR" : null;
  if (!queueType) return NO_LP;

  // A narrow window around the game is enough to find the before/after pair —
  // the snapshot sweep runs every 5 min, so they are dense. (The feed pages
  // through a player's whole history because it resolves many games at once.)
  const { data, error } = await supabaseAdmin
    .from("scout_rank_snapshots")
    .select("tier, rank_division, lp, taken_at, match_id")
    .eq("puuid", puuid)
    .eq("queue_type", queueType)
    .gte("taken_at", new Date(gameEndMs - 12 * 60 * 60 * 1000).toISOString())
    .lte("taken_at", new Date(gameEndMs + 60 * 60 * 1000).toISOString())
    .order("taken_at", { ascending: true })
    .limit(500);

  if (error || !data || data.length < 2) return NO_LP;
  const list = data as any[];

  // Prefer the snapshot explicitly linked to this match; fall back to the
  // first one taken at/after the game ended.
  let afterIdx = list.findIndex((s) => s.match_id === matchId);
  if (afterIdx === -1) {
    afterIdx = list.findIndex((s) => new Date(s.taken_at).getTime() >= gameEndMs);
  }
  if (afterIdx <= 0) return NO_LP; // need a snapshot before it too

  const before = list[afterIdx - 1];
  const after = list[afterIdx];
  const beforeScore = ladderScore(before.tier, before.rank_division ?? null, before.lp ?? 0);
  const afterScore = ladderScore(after.tier, after.rank_division ?? null, after.lp ?? 0);

  const sameTierDiv =
    before.tier === after.tier && before.rank_division === after.rank_division;

  return {
    lpDelta: afterScore - beforeScore,
    tier: after.tier ?? null,
    division: after.rank_division ?? null,
    lp: after.lp ?? null,
    rankChange: sameTierDiv ? null : afterScore > beforeScore ? "PROMOTION" : "DEMOTION",
  };
}

async function markPosted(webhookId: string, matchIds: string[]): Promise<void> {
  if (matchIds.length === 0) return;
  await supabaseAdmin
    .from("scout_webhook_posted")
    .upsert(
      matchIds.map((m) => ({ webhook_id: webhookId, match_id: m })),
      { onConflict: "webhook_id,match_id", ignoreDuplicates: true }
    );
}

async function recordFailure(w: WebhookRow, error: string, permanent: boolean): Promise<void> {
  const nextCount = (w.fail_count ?? 0) + 1;
  const disable = permanent || nextCount >= AUTO_DISABLE_AFTER;
  await supabaseAdmin
    .from("scout_lobby_webhooks")
    .update({
      last_error: permanent ? `${error} (auto-disabled)` : error,
      last_error_at: new Date().toISOString(),
      fail_count: nextCount,
      ...(disable ? { enabled: false } : {}),
    })
    .eq("id", w.id);
}

async function recordSuccess(webhookId: string): Promise<void> {
  await supabaseAdmin
    .from("scout_lobby_webhooks")
    .update({ last_posted_at: new Date().toISOString(), fail_count: 0, last_error: null })
    .eq("id", webhookId);
}

/** Process one webhook: find new matches for its lobby, post embeds. */
async function processWebhook(w: WebhookRow): Promise<number> {
  // 1. the lobby's accounts
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select("puuid, region, lobby_player_id, scout_lobby_players!inner(id, display_name, lobby_slug)")
    .eq("scout_lobby_players.lobby_slug", w.lobby_slug);

  if (accErr || !accounts || accounts.length === 0) return 0;

  const rows = accounts as unknown as AccountRow[];
  const nameByPuuid = new Map<string, string>();
  const regionByPuuid = new Map<string, string>();
  for (const a of rows) {
    if (!nameByPuuid.has(a.puuid)) {
      nameByPuuid.set(a.puuid, a.scout_lobby_players?.display_name ?? "Unknown");
      regionByPuuid.set(a.puuid, a.region);
    }
  }

  // 2. recent match ids per account
  const startTimeSec = Math.floor((Date.now() - LOOKBACK_MS) / 1000);
  const matchToPuuids = new Map<string, string[]>();

  for (const [puuid, region] of regionByPuuid) {
    try {
      const ids = await getMatchIdsByPuuidOpts(puuid, region, {
        count: MAX_MATCHES_PER_ACCOUNT,
        startTime: startTimeSec,
      });
      for (const id of ids) {
        const arr = matchToPuuids.get(id) ?? [];
        arr.push(puuid);
        matchToPuuids.set(id, arr);
      }
    } catch (e) {
      console.warn(`[scout-webhook] match ids failed for ${puuid.slice(0, 8)}:`, (e as any)?.message ?? e);
    }
    await sleep(PER_CALL_DELAY_MS);
  }

  if (matchToPuuids.size === 0) return 0;

  // 3. drop the ones already posted
  const candidateIds = [...matchToPuuids.keys()];
  const { data: already } = await supabaseAdmin
    .from("scout_webhook_posted")
    .select("match_id")
    .eq("webhook_id", w.id)
    .in("match_id", candidateIds);
  const posted = new Set((already ?? []).map((r: any) => r.match_id));

  let fresh = candidateIds.filter((id) => !posted.has(id));
  if (fresh.length === 0) return 0;

  // 4. FIRST RUN: never back-fill history into a freshly connected channel —
  //    mark everything seen and start clean from the next cycle.
  //
  //    "First run" must be asked of the WHOLE ledger, not just the current
  //    candidates: a lobby that goes quiet for longer than LOOKBACK_MS has no
  //    overlap with what it posted before, and a candidate-scoped check would
  //    read that as a first run and silently swallow the comeback games.
  const { count: everPosted } = await supabaseAdmin
    .from("scout_webhook_posted")
    .select("match_id", { count: "exact", head: true })
    .eq("webhook_id", w.id);
  if ((everPosted ?? 0) === 0) {
    await markPosted(w.id, fresh);
    console.log(`[scout-webhook] ${w.lobby_slug}: first run, baselined ${fresh.length} matches (no posts)`);
    return 0;
  }

  // newest last → post in chronological order
  fresh = fresh.sort().slice(-MAX_POSTS_PER_SWEEP);

  let sent = 0;
  for (const matchId of fresh) {
    // Whose match list surfaced this game — used only to pick a region.
    const discoveredBy = matchToPuuids.get(matchId) ?? [];
    const region = regionByPuuid.get(discoveredBy[0]) ?? "euw1";

    let match: any;
    try {
      match = await getMatchDetails(matchId, region);
    } catch (e) {
      console.warn(`[scout-webhook] match details failed ${matchId}:`, (e as any)?.message ?? e);
      continue;
    }
    await sleep(PER_CALL_DELAY_MS);

    const info = match?.info;
    if (!info?.participants) continue;

    // Squad membership comes from the PARTICIPANT LIST, not from the union of
    // the per-account match lists.
    //
    // Riot indexes match-v5 per account and the lists do NOT update atomically:
    // a duo that finished together can show up for one member a minute before
    // the other. Deriving the squad from discovery meant whoever Riot indexed
    // first "claimed" the game, the embed went out with a single player, and
    // the (webhook_id, match_id) ledger locked that in forever — the partner
    // could never be added on a later sweep. Reading the 10 participants is
    // authoritative and immune to that lag.
    const puuids = (info.participants as any[])
      .filter((p) => regionByPuuid.has(p.puuid))
      .map((p) => p.puuid);

    const durationSec = info.gameDuration ?? 0;
    const queueId = info.queueId ?? null;

    // filters — mark as posted anyway so we don't re-evaluate them forever
    const queueOk = !w.queue_filter?.length || (queueId != null && w.queue_filter.includes(queueId));
    const durationOk = durationSec >= (w.min_duration_s ?? 300);
    if (!queueOk || !durationOk) {
      await markPosted(w.id, [matchId]);
      continue;
    }

    // 5. build the per-member lines
    const gameEndMs: number =
      info.gameEndTimestamp ??
      (info.gameStartTimestamp ?? Date.now()) + durationSec * 1000;

    const players: WebhookPlayerLine[] = [];
    for (const puuid of puuids) {
      const me = info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;
      const team = info.participants.filter((p: any) => p.teamId === me.teamId);
      const teamKills = team.reduce((s: number, p: any) => s + (p.kills ?? 0), 0);
      // Rank + LP change from the snapshot pair around this game. The scout
      // periodic sweep takes its snapshots BEFORE this webhook sweep runs in
      // the same cycle, so the post-game snapshot normally already exists.
      const lp = await resolveLp(puuid, matchId, queueId, gameEndMs);
      players.push({
        displayName: nameByPuuid.get(puuid) ?? me.riotIdGameName ?? "Unknown",
        riotId: me.riotIdGameName && me.riotIdTagline ? `${me.riotIdGameName}#${me.riotIdTagline}` : null,
        region: regionByPuuid.get(puuid) ?? region,
        championName: me.championName ?? "Unknown",
        win: Boolean(me.win),
        kills: me.kills ?? 0,
        deaths: me.deaths ?? 0,
        assists: me.assists ?? 0,
        cs: (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0),
        damage: me.totalDamageDealtToChampions ?? 0,
        kp: teamKills > 0 ? Math.round((((me.kills ?? 0) + (me.assists ?? 0)) / teamKills) * 100) : null,
        lpDelta: lp.lpDelta,
        tier: lp.tier,
        division: lp.division,
        lp: lp.lp,
        rankChange: lp.rankChange,
        visionScore: me.visionScore ?? null,
      });
    }
    if (players.length === 0) {
      await markPosted(w.id, [matchId]);
      continue;
    }

    const avgLadderScore = await averageLobbyElo(
      info.participants.map((p: any) => p.puuid).filter(Boolean)
    );

    // Pros / streamers among the 10 players — "Faker on Kha'Zix". Lobby
    // members are excluded: they already have their own block in the embed.
    const lobbyPuuids = new Set(puuids);
    const notables: WebhookNotable[] = [];
    const byNametag = new Map<string, any>();
    for (const part of info.participants as any[]) {
      if (lobbyPuuids.has(part.puuid)) continue;
      if (!part.riotIdGameName || !part.riotIdTagline) continue;
      byNametag.set(`${part.riotIdGameName}#${part.riotIdTagline}`, part);
    }
    if (byNametag.size > 0) {
      try {
        const found = await lookupBadgeIdentities([...byNametag.keys()]);
        for (const [nametag, identity] of found) {
          notables.push({
            name: identity.name,
            slug: identity.slug,
            kind: identity.kind,
            championName: byNametag.get(nametag)?.championName ?? "Unknown",
          });
        }
      } catch (e) {
        // A badge-lookup hiccup must not cost us the whole embed.
        console.warn("[scout-webhook] notable lookup failed:", (e as any)?.message ?? e);
      }
    }

    // 6. lobby name for the embed author line
    const { data: lobby } = await supabaseAdmin
      .from("scout_lobbies")
      .select("name")
      .eq("slug", w.lobby_slug)
      .maybeSingle();

    const payload: WebhookMatchPayload = {
      lobbyName: (lobby as any)?.name ?? "Scout lobby",
      lobbySlug: w.lobby_slug,
      matchId,
      queueId,
      durationSec,
      gameEndMs: info.gameEndTimestamp ?? info.gameStartTimestamp ?? null,
      players,
      avgLadderScore,
      notables,
    };

    const res = await postToWebhook(w.url, await buildMatchEmbeds(payload), {
      username: w.username,
      avatarUrl: w.avatar_url,
    });
    if (res.ok) {
      await markPosted(w.id, [matchId]);
      await recordSuccess(w.id);
      sent++;
    } else {
      await recordFailure(w, res.error, res.permanent);
      // stop hammering a broken webhook this cycle
      break;
    }
  }

  return sent;
}

/**
 * One pass over every enabled webhook. Called by the scout periodic sweep;
 * never throws.
 */
export async function sweepScoutWebhooks(): Promise<void> {
  if (process.env.BOX_READ_ONLY === "true") return;

  const { data, error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .select(
      "id, lobby_slug, url, enabled, queue_filter, min_duration_s, created_at, fail_count, username, avatar_url"
    )
    .eq("enabled", true);

  if (error) {
    console.error("[scout-webhook] list error:", error.message);
    return;
  }
  const hooks = (data ?? []) as WebhookRow[];
  if (hooks.length === 0) return;

  const startedAt = Date.now();
  let totalSent = 0;
  for (const w of hooks) {
    try {
      totalSent += await processWebhook(w);
    } catch (e) {
      console.error(`[scout-webhook] ${w.lobby_slug} failed:`, (e as any)?.message ?? e);
    }
  }

  if (totalSent > 0) {
    console.log(
      `[scout-webhook] posted ${totalSent} embed(s) across ${hooks.length} webhook(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
  }
}
