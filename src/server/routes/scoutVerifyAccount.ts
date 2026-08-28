// src/server/routes/scoutVerifyAccount.ts
//
// Phase 2 — per-account icon-change challenge.
//
//   POST /api/scout/verify/start  { lobbyPlayerId, puuid }
//   POST /api/scout/verify/check  { lobbyPlayerId, puuid }
//
// Flow
//   1. The claimer (authenticated user whose profile id matches
//      scout_lobby_players.claimed_by_profile_id) picks a Riot
//      account to verify and calls /start.
//   2. Backend picks a random icon id from a curated pool (the
//      default profile icons every player has access to, minus the
//      account's CURRENT icon). Persists target + started_at.
//   3. UI asks user to switch their League client icon to the target
//      and press a "Check" button.
//   4. /check fetches the current icon from Riot, compares to target.
//      Match → verified_at = NOW(); mismatch → returns the current
//      icon so the UI can hint "current vs target".
//
// Grade 2 is reached when EVERY scout_lobby_accounts row for the
// player has verified_at set (computed by readScoutLobbyHandler).

import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client";
import { logger } from "../logger";
import { getSummonerByPuuid } from "../riot";

const jsonHeaders = { "Content-Type": "application/json" } as const;

// Default profile icon pool — every League account has access to
// these. Range 0–28 covers the original default icons; we skip a few
// that historically caused rendering issues in the LoL client. Keep
// this list small and stable so we never pick something the user
// can't actually set.
const ICON_POOL: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28,
];

const CHALLENGE_TTL_MS = 30 * 60 * 1000; // 30 min — generous

// ─── Auth helper ────────────────────────────────────────────────────
async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

const errorJson = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders,
  });

type VerifyBody = { lobbyPlayerId?: string; puuid?: string };

// Pick a random icon id from the pool, excluding the current icon
// (so we never ask "change to icon X" when the account is already on X).
function pickTargetIcon(currentIconId: number | null): number {
  const pool = ICON_POOL.filter((id) => id !== currentIconId);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Resolve the lobby_account + lobby_player_id row and verify the
 *  authenticated user is the claimer of that lobby_player. Centralised
 *  so both /start and /check have the same auth posture. */
async function resolveAndAuth(
  body: VerifyBody,
  userId: string
): Promise<
  | { ok: true; account: any; claimedById: string }
  | { ok: false; status: number; message: string }
> {
  if (!body?.lobbyPlayerId || !body?.puuid)
    return { ok: false, status: 400, message: "lobbyPlayerId + puuid required" };

  // Pull the account row (region + verification state) joined with
  // the player so we can check claimed_by_profile_id in one query.
  const { data: account, error } = await supabaseMatchAdmin
    .from("scout_lobby_accounts")
    .select(
      "id, lobby_player_id, puuid, region, verification_target_icon_id, verification_started_at, verified_at, scout_lobby_players!inner(id, claimed_by_profile_id)"
    )
    .eq("lobby_player_id", body.lobbyPlayerId)
    .eq("puuid", body.puuid)
    .maybeSingle();
  if (error) {
    logger.error("scoutVerifyAccount", `lookup failed: ${error.message}`);
    return { ok: false, status: 500, message: "internal error" };
  }
  if (!account)
    return { ok: false, status: 404, message: "account not in lobby" };

  const claimedById = (account as any).scout_lobby_players?.claimed_by_profile_id as
    | string
    | null;
  if (!claimedById) return { ok: false, status: 403, message: "not claimed" };
  if (claimedById !== userId)
    return { ok: false, status: 403, message: "not your identity" };

  return { ok: true, account, claimedById };
}

// ─── POST /verify/start ─────────────────────────────────────────────
export async function startVerifyAccountHandler(
  req: Request
): Promise<Response> {
  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");

  let body: VerifyBody;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }

  const auth = await resolveAndAuth(body, userId);
  if (!auth.ok) return errorJson(auth.status, auth.message);

  const { account } = auth;
  // Idempotent — if a challenge is already in flight (and not yet
  // expired) keep the same target so a refresh doesn't shuffle the
  // icon under the user's nose. Brand-new or expired → new target.
  const startedAt = account.verification_started_at
    ? new Date(account.verification_started_at).getTime()
    : 0;
  const expired = Date.now() - startedAt > CHALLENGE_TTL_MS;
  const hasActive = !!account.verification_target_icon_id && !expired;

  let targetIconId = account.verification_target_icon_id as number | null;
  if (!hasActive) {
    // Fetch the account's current icon so we can pick a different one.
    let currentIconId: number | null = null;
    try {
      const summoner = await getSummonerByPuuid(account.puuid, account.region);
      currentIconId = (summoner as any)?.profileIconId ?? null;
    } catch (e: any) {
      logger.warn(
        "scoutVerifyAccount",
        `riot fetch (start) failed for ${account.puuid.slice(0, 8)}: ${e?.message}`
      );
      // Not fatal — we can still issue a target, just don't dedupe.
    }
    targetIconId = pickTargetIcon(currentIconId);
    const { error: updErr } = await supabaseMatchAdmin
      .from("scout_lobby_accounts")
      .update({
        verification_target_icon_id: targetIconId,
        verification_started_at: new Date().toISOString(),
        // Clear verified_at if it was previously set and we're re-rolling.
        verified_at: null,
      })
      .eq("id", account.id);
    if (updErr) {
      logger.error(
        "scoutVerifyAccount",
        `update target failed: ${updErr.message}`
      );
      return errorJson(500, "internal error");
    }
  }

  return new Response(
    JSON.stringify({
      targetIconId,
      ttlSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── POST /verify/check ─────────────────────────────────────────────
export async function checkVerifyAccountHandler(
  req: Request
): Promise<Response> {
  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");

  let body: VerifyBody;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }

  const auth = await resolveAndAuth(body, userId);
  if (!auth.ok) return errorJson(auth.status, auth.message);
  const { account } = auth;

  const targetIconId = account.verification_target_icon_id as number | null;
  if (!targetIconId)
    return errorJson(400, "no active challenge — call /start first");

  // Fetch the current icon from Riot for the puuid + region.
  let currentIconId: number | null = null;
  try {
    const summoner = await getSummonerByPuuid(account.puuid, account.region);
    currentIconId = (summoner as any)?.profileIconId ?? null;
  } catch (e: any) {
    logger.warn(
      "scoutVerifyAccount",
      `riot fetch (check) failed for ${account.puuid.slice(0, 8)}: ${e?.message}`
    );
    return errorJson(502, "couldn't reach Riot — try again");
  }

  if (currentIconId !== targetIconId) {
    return new Response(
      JSON.stringify({
        ok: false,
        match: false,
        currentIconId,
        targetIconId,
      }),
      { status: 200, headers: jsonHeaders }
    );
  }

  // Match — mark verified.
  const { error: updErr } = await supabaseMatchAdmin
    .from("scout_lobby_accounts")
    .update({ verified_at: new Date().toISOString() })
    .eq("id", account.id);
  if (updErr) {
    logger.error(
      "scoutVerifyAccount",
      `mark verified failed: ${updErr.message}`
    );
    return errorJson(500, "internal error");
  }

  return new Response(
    JSON.stringify({ ok: true, match: true, currentIconId, targetIconId }),
    { status: 200, headers: jsonHeaders }
  );
}
