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
function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
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
  const today = todayUtcDateString();

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
    const today = todayUtcDateString();
    const { data: bounty } = await supabaseAdmin
      .from("scout_bounty_daily")
      .select("id, template_id, claimed_at")
      .eq("lobby_slug", mem.lobby_slug)
      .eq("day_utc", today)
      .maybeSingle();

    if (!bounty || bounty.claimed_at) continue;

    const tpl = await getTemplateById(bounty.template_id);
    if (!tpl) continue;

    const value = evaluateMetric(tpl.metric, tpl.threshold, participant);
    if (value === null) continue;

    // Atomic claim — only succeeds if no one beat us to it.
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
      .is("claimed_at", null)
      .select("id");

    if (!updErr && updated && updated.length > 0) {
      claimedLobbies.push(mem.lobby_slug);
      logger.info(
        "scoutBounty",
        `claimed [${tpl.code}] in ${mem.lobby_slug} by ${participant.puuid.slice(0, 8)} (value=${value})`
      );
    }
  }

  return claimedLobbies;
}

// ─── Read API: today's bounty (full payload for the UI) ─────────────
export async function readTodayBountyPayload(lobbySlug: string) {
  const result = await ensureDailyBounty(lobbySlug);
  if (!result) return null;
  const { bounty, template } = result;

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
