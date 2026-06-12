// src/server/services/scoutBounty.ts
//
// Daily Bounty logic for scout lobbies.
//
// Flow
//   1. UI asks `GET /api/scout/bounty/today/:slug` — we lazily mint
//      that day's bounty if it doesn't exist yet (random template
//      weighted by rarity), then return it.
//   2. When a match is ingested (matchIngest.ts), for every lobby a
//      player belongs to, we call `checkBountyForMatch()`. If the
//      day's bounty isn't claimed yet AND this match satisfies it,
//      we atomically UPDATE the row WHERE claimed_at IS NULL — the
//      first claimer wins, latecomers' updates affect zero rows.
//   3. UI shows the claimed state (winner avatar, achievement
//      value) in the sidebar, and aggregates all-time claims into
//      a leaderboard at the bottom of the Leaderboard tab.

import { supabaseAdmin } from "../supabase/client";
import { logger } from "../logger";
import { broadcastBountyEvent } from "../realtime/scoutRealtime";

// ─── Types ──────────────────────────────────────────────────────────
export type BountyTemplate = {
  id: string;
  code: string;
  title: string;
  description: string;
  metric: BountyMetric;
  threshold: number;
  rarity: "common" | "rare" | "legendary";
  icon: string;
};

export type BountyMetric =
  | "kills"
  | "damage"
  | "kp_pct"
  | "vision"
  | "gold"
  | "kda"
  | "zero_deaths_win"
  | "assists"
  | "quick_win"
  | "cs";

export type BountyDaily = {
  id: string;
  lobby_slug: string;
  template_id: string;
  day_utc: string; // YYYY-MM-DD
  claimed_at: string | null;
  claimed_by_lobby_player_id: string | null;
  claimed_by_account_puuid: string | null;
  claimed_match_id: string | null;
  claimed_value: number | null;
};

/** Minimum per-participant data we need to evaluate a bounty. Mirror
 *  of the fields that exist on `participants` + the match's duration. */
export type BountyParticipantSnapshot = {
  puuid: string;
  kills: number;
  deaths: number;
  assists: number;
  total_damage_to_champions: number;
  vision_score: number;
  gold_earned: number;
  /** Sum of minions + neutral minions killed. */
  cs: number;
  win: boolean;
  /** Total kills scored by the participant's team in the match. Used
   *  for KP%. Provide 0 if unknown — KP just won't satisfy. */
  team_kills: number;
  /** Match duration in seconds — used by `quick_win`. */
  game_duration_seconds: number;
  match_id: string;
};

// ─── Day helpers ────────────────────────────────────────────────────
// The daily bounty rolls over at LOCAL midnight (Europe/Rome), not UTC
// midnight. loldata's audience is primarily Italian, and "daily"
// should mean their calendar day — otherwise the bounty resets at
// 02:00 (CEST) / 01:00 (CET), which feels broken to users who play
// past midnight. Intl handles CET/CEST DST automatically.
//
// The DB column is still named `day_utc` for backwards-compat, but it
// now stores the Europe/Rome local date (YYYY-MM-DD).
const BOUNTY_TIMEZONE = "Europe/Rome";

// Europe/Rome calendar date (YYYY-MM-DD) for an arbitrary instant.
function romeDateString(date: Date): string {
  // en-CA locale formats as YYYY-MM-DD, which is exactly the shape we
  // store in day_utc.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOUNTY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function todayLocalDateString(): string {
  return romeDateString(new Date());
}

// ─── Template pool ──────────────────────────────────────────────────
let templateCache: BountyTemplate[] | null = null;
let templateCacheAt = 0;
const TEMPLATE_TTL_MS = 5 * 60 * 1000;

async function getAllTemplates(): Promise<BountyTemplate[]> {
  if (templateCache && Date.now() - templateCacheAt < TEMPLATE_TTL_MS) {
    return templateCache;
  }
  const { data, error } = await supabaseAdmin
    .from("scout_bounty_templates")
    .select("*");
  if (error) {
    logger.error("scoutBounty", `failed to load templates: ${error.message}`);
    return [];
  }
  templateCache = (data ?? []) as BountyTemplate[];
  templateCacheAt = Date.now();
  return templateCache;
}

// Rarity weights: 60/30/10 split.
function pickRandomTemplate(pool: BountyTemplate[]): BountyTemplate | null {
  if (pool.length === 0) return null;
  const weight = (r: BountyTemplate["rarity"]) =>
    r === "common" ? 6 : r === "rare" ? 3 : 1;
  const totalWeight = pool.reduce((sum, t) => sum + weight(t.rarity), 0);
  let pick = Math.random() * totalWeight;
  for (const t of pool) {
    pick -= weight(t.rarity);
    if (pick <= 0) return t;
  }
  return pool[pool.length - 1];
}

// ─── Ensure today's bounty exists ───────────────────────────────────
export async function ensureDailyBounty(
  lobbySlug: string
): Promise<{ bounty: BountyDaily; template: BountyTemplate } | null> {
  const today = todayLocalDateString();

  // Fast path: row already exists for today.
  const { data: existing, error: readErr } = await supabaseAdmin
    .from("scout_bounty_daily")
    .select("*")
    .eq("lobby_slug", lobbySlug)
    .eq("day_utc", today)
    .maybeSingle();
  if (readErr) {
    logger.error("scoutBounty", `read existing failed: ${readErr.message}`);
  }
  if (existing) {
    const tpl = await getTemplateById(existing.template_id);
    if (!tpl) return null;
    return { bounty: existing as BountyDaily, template: tpl };
  }

  // Need to mint. Pick a random template weighted by rarity.
  const templates = await getAllTemplates();
  const template = pickRandomTemplate(templates);
  if (!template) {
    logger.error("scoutBounty", "no templates available to mint bounty");
    return null;
  }

  // INSERT with ON CONFLICT DO NOTHING semantics via the UNIQUE
  // constraint on (lobby_slug, day_utc) — if a race insert happened
  // between our SELECT and INSERT we re-read whoever won.
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("scout_bounty_daily")
    .insert({
      lobby_slug: lobbySlug,
      template_id: template.id,
      day_utc: today,
    })
    .select("*")
    .maybeSingle();

  if (inserted) {
    return { bounty: inserted as BountyDaily, template };
  }

  // Race: someone else inserted. Re-read.
  if (insertErr) {
    const { data: row } = await supabaseAdmin
      .from("scout_bounty_daily")
      .select("*")
      .eq("lobby_slug", lobbySlug)
      .eq("day_utc", today)
      .maybeSingle();
    if (row) {
      const tpl = await getTemplateById(row.template_id);
      if (!tpl) return null;
      return { bounty: row as BountyDaily, template: tpl };
    }
  }

  return null;
}

async function getTemplateById(id: string): Promise<BountyTemplate | null> {
  const all = await getAllTemplates();
  return all.find((t) => t.id === id) ?? null;
}

// Short human label for the achieved value — surfaced on the live chat
// banner. Mirrors the frontend's formatBountyAchieved.
export function formatBountyValue(metric: BountyMetric, value: number): string {
  switch (metric) {
    case "kills":          return `${value} kills`;
    case "damage":         return `${Math.round(value).toLocaleString("en-US")} dmg`;
    case "kp_pct":         return `${Math.round(value * 100)}% KP`;
    case "vision":         return `${value} vision`;
    case "gold":           return `${Math.round(value).toLocaleString("en-US")} gold`;
    case "kda":            return `${value.toFixed(2)} KDA`;
    case "zero_deaths_win":return `flawless win`;
    case "assists":        return `${value} assists`;
    case "quick_win":      return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")} win`;
    case "cs":             return `${value} CS`;
    default:               return `${value}`;
  }
}

// ─── Evaluate match against a bounty ────────────────────────────────
/** Returns the numeric "claimed_value" if the participant satisfies
 *  the bounty's metric/threshold, or null otherwise. */
function evaluateMetric(
  metric: BountyMetric,
  threshold: number,
  p: BountyParticipantSnapshot
): number | null {
  switch (metric) {
    case "kills":
      return p.kills >= threshold ? p.kills : null;
    case "damage":
      return p.total_damage_to_champions >= threshold
        ? p.total_damage_to_champions
        : null;
    case "kp_pct": {
      if (p.team_kills <= 0) return null;
      const kp = (p.kills + p.assists) / p.team_kills;
      return kp >= threshold ? kp : null;
    }
    case "vision":
      return p.vision_score >= threshold ? p.vision_score : null;
    case "gold":
      return p.gold_earned >= threshold ? p.gold_earned : null;
    case "kda": {
      const deaths = Math.max(1, p.deaths);
      const kda = (p.kills + p.assists) / deaths;
      return kda >= threshold ? Number(kda.toFixed(2)) : null;
    }
    case "zero_deaths_win":
      return p.win && p.deaths === 0 ? 1 : null;
    case "assists":
      return p.assists >= threshold ? p.assists : null;
    case "quick_win":
      return p.win && p.game_duration_seconds <= threshold
        ? p.game_duration_seconds
        : null;
    case "cs":
      return p.cs >= threshold ? p.cs : null;
    default:
      return null;
  }
}

// ─── Atomic claim ───────────────────────────────────────────────────
/** Called from matchIngest after `participants` upsert. For every
 *  lobby this `puuid` belongs to, check the day's bounty and try to
 *  claim atomically. The UPDATE ... WHERE claimed_at IS NULL clause
 *  guarantees the first ingested satisfying match wins.
 *
 *  Returns the array of lobby_slug values where a claim succeeded
 *  (zero, one, or many — a player in N lobbies could potentially
 *  claim in each).
 */
export async function checkBountyForMatch(
  participant: BountyParticipantSnapshot
): Promise<string[]> {
  const claimedLobbies: string[] = [];

  // Find every lobby this puuid plays in via scout_lobby_accounts.
  const { data: memberships, error: memErr } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select("puuid, lobby_player_id, scout_lobby_players ( lobby_slug, id )")
    .eq("puuid", participant.puuid);
  if (memErr || !memberships) return claimedLobbies;

  // De-dupe by lobby_slug (one lobby can have several accounts of the
  // same player).
  const seen = new Set<string>();
  type Mem = { lobby_slug: string; lobby_player_id: string };
  const mems: Mem[] = [];
  for (const row of memberships as any[]) {
    const lp = row.scout_lobby_players;
    const lobbySlug = lp?.lobby_slug as string | undefined;
    const lobbyPlayerId = lp?.id as string | undefined;
    if (!lobbySlug || !lobbyPlayerId) continue;
    if (seen.has(lobbySlug)) continue;
    seen.add(lobbySlug);
    mems.push({ lobby_slug: lobbySlug, lobby_player_id: lobbyPlayerId });
  }

  for (const mem of mems) {
    const today = todayLocalDateString();
    const { data: bounty } = await supabaseAdmin
      .from("scout_bounty_daily")
      .select("id, template_id, claimed_at, claimed_value")
      .eq("lobby_slug", mem.lobby_slug)
      .eq("day_utc", today)
      .maybeSingle();

    if (!bounty) continue;

    const tpl = await getTemplateById(bounty.template_id);
    if (!tpl) continue;

    const value = evaluateMetric(tpl.metric, tpl.threshold, participant);
    if (value === null) continue; // didn't even clear the threshold

    // Competitive claim — the bounty is HELD by whoever has the best
    // value, not just the first to clear the threshold. A new match
    // overtakes the current holder when its value beats theirs.
    //   • most metrics → higher is better
    //   • quick_win    → lower (faster) is better
    // The atomic guard `claimed_at IS NULL OR claimed_value {cmp} value`
    // is evaluated under Postgres row-locking, so two concurrent
    // ingests on the same bounty serialise and the best value wins
    // (no lost updates).
    const lowerIsBetter = tpl.metric === "quick_win";
    const cmp = lowerIsBetter ? "gt" : "lt"; // current value is WORSE when …
    const orFilter = `claimed_at.is.null,claimed_value.${cmp}.${value}`;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("scout_bounty_daily")
      .update({
        claimed_at: new Date().toISOString(),
        claimed_by_lobby_player_id: mem.lobby_player_id,
        claimed_by_account_puuid: participant.puuid,
        claimed_match_id: participant.match_id,
        claimed_value: value,
      })
      .eq("id", bounty.id)
      .or(orFilter)
      .select("id");

    if (!updErr && updated && updated.length > 0) {
      claimedLobbies.push(mem.lobby_slug);
      const overtake = bounty.claimed_at != null;
      const verb = overtake ? "overtook" : "claimed";
      logger.info(
        "scoutBounty",
        `${verb} [${tpl.code}] in ${mem.lobby_slug} by ${participant.puuid.slice(0, 8)} (value=${value}, prev=${bounty.claimed_value ?? "none"})`
      );

      // Live chat event banner. Look up the claimer's display name +
      // colour so the banner can render them in their accent, then
      // broadcast to everyone watching the lobby. Best-effort: failures
      // here must never break ingestion.
      try {
        const { data: lp } = await supabaseAdmin
          .from("scout_lobby_players")
          .select("display_name, color")
          .eq("id", mem.lobby_player_id)
          .maybeSingle();
        broadcastBountyEvent(mem.lobby_slug, {
          id: crypto.randomUUID(),
          title: tpl.title,
          icon: tpl.icon,
          rarity: tpl.rarity,
          metric: tpl.metric,
          playerName: lp?.display_name ?? "A player",
          color: lp?.color ?? null,
          valueLabel: formatBountyValue(tpl.metric, value),
          overtake,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(
          "scoutBounty",
          `bounty banner broadcast failed: ${(err as Error)?.message}`
        );
      }
    }
  }

  return claimedLobbies;
}

// ─── Retroactive reconcile ──────────────────────────────────────────
// The per-match bounty check (`checkBountyForMatch`) only runs ONCE, the
// first time a match is ingested, against the threshold in effect at
// that instant. So a match ingested under an old threshold (e.g. Banker
// at 25k) is never re-checked after the threshold is lowered to 18k —
// even though it now qualifies. This heals that by re-scanning today's
// already-ingested matches and claiming the best qualifier through the
// same atomic competitive guard.
//
// Limitation: it evaluates from the `participants` table, so metrics
// whose source columns weren't populated on that ingest path (notably
// kp_pct → kill_participation, cs → total_cs) are skipped for those
// rows. Skipping is safe (a null field evaluates to "doesn't qualify",
// never a false claim). All gold/kills/damage/vision/assists/kda/
// quick_win/zero-death bounties reconcile fully.
const reconcileThrottle = new Map<string, number>();
const RECONCILE_THROTTLE_MS = 60 * 1000;

export async function reconcileDailyBounty(
  lobbySlug: string,
  bounty: BountyDaily,
  template: BountyTemplate
): Promise<boolean> {
  // Only heal UNCLAIMED bounties — once held, the live per-match check
  // keeps it competitive going forward.
  if (bounty.claimed_at != null) return false;

  const last = reconcileThrottle.get(lobbySlug) ?? 0;
  if (Date.now() - last < RECONCILE_THROTTLE_MS) return false;
  reconcileThrottle.set(lobbySlug, Date.now());

  // 1. lobby account puuids → lobby_player_id
  const { data: accs } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select("puuid, lobby_player_id, scout_lobby_players!inner ( lobby_slug )")
    .eq("scout_lobby_players.lobby_slug", lobbySlug);
  if (!accs || accs.length === 0) return false;

  const playerByPuuid = new Map<string, string>();
  for (const a of accs as any[]) {
    if (a.puuid && a.lobby_player_id) {
      playerByPuuid.set(a.puuid, a.lobby_player_id);
    }
  }
  const puuids = [...playerByPuuid.keys()];
  if (puuids.length === 0) return false;

  // 2. today's ingested matches for these accounts. Pull a generous 36h
  //    window, then filter precisely to the bounty's Rome day.
  const sinceIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const { data: rows } = await supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, kills, deaths, assists, gold_earned, total_damage_to_champions, vision_score, kill_participation, total_cs, total_minions_killed, neutral_minions_killed, win, matches!inner ( game_creation, game_duration_seconds )"
    )
    .in("puuid", puuids)
    .gte("matches.game_creation", sinceIso);
  if (!rows || rows.length === 0) return false;

  // 3. evaluate every match played on the bounty's day, keep the best.
  const lowerIsBetter = template.metric === "quick_win";
  let best: {
    puuid: string;
    lobby_player_id: string;
    match_id: string;
    value: number;
  } | null = null;

  for (const r of rows as any[]) {
    const gc = r.matches?.game_creation;
    if (!gc) continue;
    if (romeDateString(new Date(gc)) !== bounty.day_utc) continue;

    const cs =
      r.total_cs ??
      ((r.total_minions_killed ?? 0) + (r.neutral_minions_killed ?? 0));
    const kp = r.kill_participation ?? 0;
    const teamKills = kp > 0 ? (r.kills + r.assists) / kp : 0;

    const snap: BountyParticipantSnapshot = {
      puuid: r.puuid,
      kills: r.kills ?? 0,
      deaths: r.deaths ?? 0,
      assists: r.assists ?? 0,
      total_damage_to_champions: r.total_damage_to_champions ?? 0,
      vision_score: r.vision_score ?? 0,
      gold_earned: r.gold_earned ?? 0,
      cs,
      win: !!r.win,
      team_kills: teamKills,
      game_duration_seconds: r.matches?.game_duration_seconds ?? 0,
      match_id: r.match_id,
    };

    const value = evaluateMetric(template.metric, template.threshold, snap);
    if (value == null) continue;
    const lpId = playerByPuuid.get(r.puuid);
    if (!lpId) continue;

    if (
      best == null ||
      (lowerIsBetter ? value < best.value : value > best.value)
    ) {
      best = {
        puuid: r.puuid,
        lobby_player_id: lpId,
        match_id: r.match_id,
        value,
      };
    }
  }

  if (!best) return false;

  // 4. atomic competitive claim — identical guard to the live path.
  const cmp = lowerIsBetter ? "gt" : "lt";
  const orFilter = `claimed_at.is.null,claimed_value.${cmp}.${best.value}`;
  const { data: updated } = await supabaseAdmin
    .from("scout_bounty_daily")
    .update({
      claimed_at: new Date().toISOString(),
      claimed_by_lobby_player_id: best.lobby_player_id,
      claimed_by_account_puuid: best.puuid,
      claimed_match_id: best.match_id,
      claimed_value: best.value,
    })
    .eq("id", bounty.id)
    .or(orFilter)
    .select("id");

  if (updated && updated.length > 0) {
    logger.info(
      "scoutBounty",
      `reconciled [${template.code}] in ${lobbySlug} → ${best.puuid.slice(0, 8)} (value=${best.value})`
    );

    // Announce the (retroactive) claim in chat, same as the live path.
    try {
      const { data: lp } = await supabaseAdmin
        .from("scout_lobby_players")
        .select("display_name, color")
        .eq("id", best.lobby_player_id)
        .maybeSingle();
      broadcastBountyEvent(lobbySlug, {
        id: crypto.randomUUID(),
        title: template.title,
        icon: template.icon,
        rarity: template.rarity,
        metric: template.metric,
        playerName: lp?.display_name ?? "A player",
        color: lp?.color ?? null,
        valueLabel: formatBountyValue(template.metric, best.value),
        overtake: false,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        "scoutBounty",
        `reconcile banner broadcast failed: ${(err as Error)?.message}`
      );
    }

    return true;
  }
  return false;
}

// ─── Read API: today's bounty (full payload for the UI) ─────────────
export async function readTodayBountyPayload(lobbySlug: string) {
  const result = await ensureDailyBounty(lobbySlug);
  if (!result) return null;
  let { bounty } = result;
  const { template } = result;

  // Heal missed claims (e.g. a match ingested before the threshold was
  // lowered) before building the payload.
  if (bounty.claimed_at == null) {
    try {
      const changed = await reconcileDailyBounty(lobbySlug, bounty, template);
      if (changed) {
        const { data: refreshed } = await supabaseAdmin
          .from("scout_bounty_daily")
          .select("*")
          .eq("id", bounty.id)
          .maybeSingle();
        if (refreshed) bounty = refreshed as BountyDaily;
      }
    } catch (err) {
      logger.error(
        "scoutBounty",
        `reconcile failed: ${(err as Error)?.message}`
      );
    }
  }

  // If claimed, enrich with the claimer's display name + colour.
  let claimedBy: {
    lobby_player_id: string;
    display_name: string | null;
    color: string | null;
  } | null = null;
  if (bounty.claimed_by_lobby_player_id) {
    const { data: lp } = await supabaseAdmin
      .from("scout_lobby_players")
      .select("id, display_name, color")
      .eq("id", bounty.claimed_by_lobby_player_id)
      .maybeSingle();
    if (lp) {
      claimedBy = {
        lobby_player_id: lp.id,
        display_name: lp.display_name,
        color: lp.color,
      };
    }
  }

  return {
    template: {
      code: template.code,
      title: template.title,
      description: template.description,
      metric: template.metric,
      threshold: template.threshold,
      rarity: template.rarity,
      icon: template.icon,
    },
    day_utc: bounty.day_utc,
    state: bounty.claimed_at ? ("claimed" as const) : ("active" as const),
    claimed_at: bounty.claimed_at,
    claimed_value: bounty.claimed_value,
    claimed_match_id: bounty.claimed_match_id,
    claimed_by: claimedBy,
  };
}

// ─── Read API: bounty leaderboard (per-lobby all-time aggregate) ────
export async function readBountyLeaderboard(lobbySlug: string) {
  // Pull every claimed bounty in this lobby with the joined player.
  const { data, error } = await supabaseAdmin
    .from("scout_bounty_daily")
    .select(
      `
      id, day_utc, claimed_at, claimed_value, template_id,
      claimed_by_lobby_player_id,
      scout_lobby_players:claimed_by_lobby_player_id ( id, display_name, color )
    `
    )
    .eq("lobby_slug", lobbySlug)
    .not("claimed_at", "is", null)
    .order("claimed_at", { ascending: false });

  if (error || !data) return { rows: [] as any[] };

  const templates = await getAllTemplates();
  const tplById = new Map(templates.map((t) => [t.id, t]));

  // Aggregate per player.
  type Agg = {
    lobby_player_id: string;
    display_name: string | null;
    color: string | null;
    total_claims: number;
    last_claim_at: string;
    last_template_code: string;
    last_template_title: string;
    last_value: number | null;
  };
  const map = new Map<string, Agg>();
  for (const row of data as any[]) {
    const lp = row.scout_lobby_players;
    const lpId = row.claimed_by_lobby_player_id as string | null;
    if (!lp || !lpId) continue;
    const tpl = tplById.get(row.template_id);
    if (!tpl) continue;

    const cur = map.get(lpId);
    if (cur) {
      cur.total_claims += 1;
      // Already sorted DESC, so first iteration is the most recent.
    } else {
      map.set(lpId, {
        lobby_player_id: lpId,
        display_name: lp.display_name,
        color: lp.color,
        total_claims: 1,
        last_claim_at: row.claimed_at,
        last_template_code: tpl.code,
        last_template_title: tpl.title,
        last_value: row.claimed_value,
      });
    }
  }

  const rows = [...map.values()].sort(
    (a, b) =>
      b.total_claims - a.total_claims ||
      (a.last_claim_at < b.last_claim_at ? 1 : -1)
  );
  return { rows };
}
