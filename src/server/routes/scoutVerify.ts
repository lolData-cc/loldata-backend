// src/server/routes/scoutVerify.ts
//
// Lobby identity verification — Phase 1.
//
//   POST   /api/scout/lobby/:slug/player/:playerId/claim-invite
//   DELETE /api/scout/lobby/:slug/player/:playerId/claim-invite
//   GET    /api/scout/claim-invite/:token
//   POST   /api/scout/claim-invite/:token/claim
//   PATCH  /api/scout/lobby/:slug/player/:playerId/verify-badge
//   GET    /api/scout/lobby/:slug/admins
//   POST   /api/scout/lobby/:slug/admins
//   DELETE /api/scout/lobby/:slug/admins/:profileId
//
// Admin checks: the resolved Bearer user must either be the lobby's
// owner_user_id (always an admin) OR have a row in scout_lobby_admins.
// The create handler inserts the creator's admins row on lobby creation;
// lobbies created before that fix are covered by the owner_user_id path.

import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client";
import { logger } from "../logger";

const jsonHeaders = { "Content-Type": "application/json" } as const;

// ─── Helpers ────────────────────────────────────────────────────────
async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

async function isLobbyAdmin(
  lobbySlug: string,
  profileId: string
): Promise<boolean> {
  // The lobby owner is ALWAYS an admin, regardless of scout_lobby_admins.
  // This is belt-and-suspenders: the create handler inserts a creator row,
  // but if that row is ever missing (e.g. a lobby created before the fix)
  // the owner must not be locked out of their own lobby's admin actions.
  const { data: lobby } = await supabaseMatchAdmin
    .from("scout_lobbies")
    .select("owner_user_id")
    .eq("slug", lobbySlug)
    .maybeSingle();
  if (lobby?.owner_user_id && lobby.owner_user_id === profileId) return true;

  const { data, error } = await supabaseMatchAdmin
    .from("scout_lobby_admins")
    .select("profile_id")
    .eq("lobby_slug", lobbySlug)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) {
    logger.error("scoutVerify", `isLobbyAdmin failed: ${error.message}`);
    return false;
  }
  return !!data;
}

/** Generate a 22-char URL-safe random token (≈130 bits of entropy). */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64url encoding without padding.
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const errorJson = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders });

// ─── Path parsing ───────────────────────────────────────────────────
// Routes are matched in index.ts by pathname.startsWith, so by the
// time we run here we already know the prefix matches. Pull out the
// slug + (optional) playerId.
function parseLobbyPlayerPath(
  pathname: string,
  prefix: string,
  suffix: string
): { slug: string; playerId: string } | null {
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  // tail format: "<slug>/player/<playerId>" + suffix (e.g. "/claim-invite")
  const expected = /^([^/]+)\/player\/([^/]+)/;
  const m = tail.match(expected);
  if (!m) return null;
  const [, slug, playerId] = m;
  // Validate the suffix is present (defensive — index.ts already
  // matched it, but if someone hits a malformed URL we bail clean).
  if (!tail.endsWith(suffix)) return null;
  return { slug, playerId };
}

function lastSegment(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

// ─── 1. POST /api/scout/lobby/:slug/player/:playerId/claim-invite ───
//     Admin: create (or reuse) the active invite for the player.
//     Reusable until DELETE. Returns the token + sharable URL.
export async function createOrReadClaimInviteHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = parseLobbyPlayerPath(
    pathname,
    "/api/scout/lobby/",
    "/claim-invite"
  );
  if (!parsed) return errorJson(400, "bad path");
  const { slug, playerId } = parsed;

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");
  if (!(await isLobbyAdmin(slug, userId))) return errorJson(403, "admin only");

  // Validate the player belongs to this lobby.
  const { data: player } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .select("id, lobby_slug, claimed_by_profile_id")
    .eq("id", playerId)
    .maybeSingle();
  if (!player || player.lobby_slug !== slug)
    return errorJson(404, "player not in lobby");

  // Reuse existing invite if there is one (the UNIQUE constraint on
  // lobby_player_id guarantees at most one row).
  const { data: existing } = await supabaseMatchAdmin
    .from("scout_player_claim_invites")
    .select("token, created_at")
    .eq("lobby_player_id", playerId)
    .maybeSingle();

  let token: string;
  if (existing) {
    token = existing.token;
  } else {
    token = generateToken();
    const { error: insErr } = await supabaseMatchAdmin
      .from("scout_player_claim_invites")
      .insert({
        lobby_slug: slug,
        lobby_player_id: playerId,
        token,
        created_by_profile_id: userId,
      });
    if (insErr) {
      logger.error("scoutVerify", `create invite failed: ${insErr.message}`);
      return errorJson(500, "internal error");
    }
  }

  return new Response(
    JSON.stringify({
      token,
      // Caller assembles the public URL from this. We don't know the
      // canonical frontend origin here, but FRONTEND_URL env can be
      // surfaced if needed.
      claimed: !!player.claimed_by_profile_id,
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── 2. DELETE /api/scout/lobby/:slug/player/:playerId/claim-invite ─
//     Admin: revoke. Hard delete — to "regenerate" call POST again.
export async function deleteClaimInviteHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = parseLobbyPlayerPath(
    pathname,
    "/api/scout/lobby/",
    "/claim-invite"
  );
  if (!parsed) return errorJson(400, "bad path");
  const { slug, playerId } = parsed;

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");
  if (!(await isLobbyAdmin(slug, userId))) return errorJson(403, "admin only");

  const { error: delErr } = await supabaseMatchAdmin
    .from("scout_player_claim_invites")
    .delete()
    .eq("lobby_player_id", playerId)
    .eq("lobby_slug", slug);

  if (delErr) {
    logger.error("scoutVerify", `delete invite failed: ${delErr.message}`);
    return errorJson(500, "internal error");
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: jsonHeaders,
  });
}

// ─── 3. GET /api/scout/claim-invite/:token ──────────────────────────
//     Public: returns lobby + player info so the claim page can render
//     "Sei tu Gabri?". Does NOT expose the creator's profile id.
export async function readClaimInviteHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const token = lastSegment(pathname);
  if (!token) return errorJson(400, "bad path");

  const { data: invite } = await supabaseMatchAdmin
    .from("scout_player_claim_invites")
    .select("token, lobby_slug, lobby_player_id, created_at")
    .eq("token", token)
    .maybeSingle();
  if (!invite) return errorJson(404, "invite not found");

  const { data: player } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, claimed_by_profile_id, scout_lobby_accounts(puuid, region, riot_name, riot_tag, is_primary)"
    )
    .eq("id", invite.lobby_player_id)
    .maybeSingle();
  if (!player) return errorJson(404, "player gone");

  const { data: lobby } = await supabaseMatchAdmin
    .from("scout_lobbies")
    .select("slug, name, hero_champion")
    .eq("slug", invite.lobby_slug)
    .maybeSingle();
  if (!lobby) return errorJson(404, "lobby gone");

  return new Response(
    JSON.stringify({
      token: invite.token,
      lobby: {
        slug: lobby.slug,
        name: lobby.name,
        heroChampion: lobby.hero_champion ?? null,
      },
      player: {
        id: player.id,
        displayName: player.display_name,
        color: player.color,
        alreadyClaimed: !!player.claimed_by_profile_id,
        accounts: (player.scout_lobby_accounts ?? []).map((a: any) => ({
          puuid: a.puuid,
          region: a.region,
          riotName: a.riot_name,
          riotTag: a.riot_tag,
          isPrimary: !!a.is_primary,
        })),
      },
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── 4. POST /api/scout/claim-invite/:token/claim ───────────────────
//     Authed: atomically set claimed_by_profile_id on the lobby_player
//     iff currently null. First-claim-wins.
export async function claimInviteHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  // pathname ends with "/claim"; the token is the segment before it.
  const parts = pathname.split("/").filter(Boolean);
  // .../claim-invite/<token>/claim
  if (parts[parts.length - 1] !== "claim") return errorJson(400, "bad path");
  const token = parts[parts.length - 2];
  if (!token) return errorJson(400, "bad path");

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "sign in to claim");

  const { data: invite } = await supabaseMatchAdmin
    .from("scout_player_claim_invites")
    .select("lobby_slug, lobby_player_id")
    .eq("token", token)
    .maybeSingle();
  if (!invite) return errorJson(404, "invite not found or revoked");

  // One human, one claim per lobby — block double-claims.
  const { data: already } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .select("id, display_name")
    .eq("lobby_slug", invite.lobby_slug)
    .eq("claimed_by_profile_id", userId)
    .maybeSingle();
  if (already && already.id !== invite.lobby_player_id) {
    return errorJson(
      409,
      `you already claimed ${already.display_name} in this lobby`
    );
  }

  // Atomic: only succeeds if claimed_by_profile_id IS NULL right now.
  const { data: claimed, error: updErr } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .update({
      claimed_by_profile_id: userId,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", invite.lobby_player_id)
    .is("claimed_by_profile_id", null)
    .select("id, lobby_slug, display_name");

  if (updErr) {
    logger.error("scoutVerify", `claim update failed: ${updErr.message}`);
    return errorJson(500, "internal error");
  }
  if (!claimed || claimed.length === 0) {
    return errorJson(409, "already claimed by someone else");
  }

  return new Response(
    JSON.stringify({
      ok: true,
      lobbySlug: claimed[0].lobby_slug,
      lobbyPlayerId: claimed[0].id,
      displayName: claimed[0].display_name,
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── 5. PATCH /api/scout/lobby/:slug/player/:playerId/verify-badge ──
//     Admin: toggle show_verify_badge on/off for the player.
export async function patchVerifyBadgeHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = parseLobbyPlayerPath(
    pathname,
    "/api/scout/lobby/",
    "/verify-badge"
  );
  if (!parsed) return errorJson(400, "bad path");
  const { slug, playerId } = parsed;

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");
  if (!(await isLobbyAdmin(slug, userId))) return errorJson(403, "admin only");

  let body: { show: boolean };
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }
  if (typeof body?.show !== "boolean") return errorJson(400, "show: boolean required");

  const { error: updErr } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .update({ show_verify_badge: body.show })
    .eq("id", playerId)
    .eq("lobby_slug", slug);

  if (updErr) {
    logger.error("scoutVerify", `verify-badge update failed: ${updErr.message}`);
    return errorJson(500, "internal error");
  }
  return new Response(JSON.stringify({ ok: true, show: body.show }), {
    status: 200,
    headers: jsonHeaders,
  });
}

// ─── 6. GET /api/scout/lobby/:slug/admins ───────────────────────────
//     Public: list admins (so the UI can show "this is an admin" badges).
//     Only profile_ids are returned by default; richer info (display
//     name) requires a lookup the frontend already does via its own
//     auth/profile resolver if needed.
export async function readLobbyAdminsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  // .../lobby/<slug>/admins
  const parts = pathname.split("/").filter(Boolean);
  if (parts[parts.length - 1] !== "admins") return errorJson(400, "bad path");
  const slug = parts[parts.length - 2];
  if (!slug) return errorJson(400, "bad path");

  const { data, error } = await supabaseMatchAdmin
    .from("scout_lobby_admins")
    .select("profile_id, granted_at, granted_by")
    .eq("lobby_slug", slug)
    .order("granted_at", { ascending: true });
  if (error) {
    logger.error("scoutVerify", `read admins failed: ${error.message}`);
    return errorJson(500, "internal error");
  }
  return new Response(
    JSON.stringify({
      admins: (data ?? []).map((a) => ({
        profileId: a.profile_id,
        grantedAt: a.granted_at,
        grantedBy: a.granted_by,
      })),
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── 7. POST /api/scout/lobby/:slug/admins ──────────────────────────
//     Admin: promote a claimed user to co-admin. Body: { profileId }.
//     Target must be a claimed user in this lobby — we don't allow
//     promoting strangers.
export async function promoteAdminHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[parts.length - 1] !== "admins") return errorJson(400, "bad path");
  const slug = parts[parts.length - 2];
  if (!slug) return errorJson(400, "bad path");

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");
  if (!(await isLobbyAdmin(slug, userId))) return errorJson(403, "admin only");

  let body: { profileId: string };
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }
  if (!body?.profileId) return errorJson(400, "profileId required");

  // Verify the target is a claimed user in this lobby.
  const { data: claimedPlayer } = await supabaseMatchAdmin
    .from("scout_lobby_players")
    .select("id")
    .eq("lobby_slug", slug)
    .eq("claimed_by_profile_id", body.profileId)
    .maybeSingle();
  if (!claimedPlayer) return errorJson(400, "target is not claimed in this lobby");

  const { error: insErr } = await supabaseMatchAdmin
    .from("scout_lobby_admins")
    .insert({
      lobby_slug: slug,
      profile_id: body.profileId,
      granted_by: userId,
    });
  if (insErr) {
    // 23505 = already admin — that's OK, treat as idempotent.
    const code = (insErr as any).code;
    if (code !== "23505") {
      logger.error("scoutVerify", `promote failed: ${insErr.message}`);
      return errorJson(500, "internal error");
    }
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: jsonHeaders,
  });
}

// ─── 8. DELETE /api/scout/lobby/:slug/admins/:profileId ─────────────
//     Admin: demote a co-admin. The lobby creator cannot be demoted —
//     they're identified by scout_lobbies.owner_user_id.
export async function demoteAdminHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parts = pathname.split("/").filter(Boolean);
  // .../lobby/<slug>/admins/<profileId>
  if (parts[parts.length - 2] !== "admins") return errorJson(400, "bad path");
  const slug = parts[parts.length - 3];
  const targetProfileId = parts[parts.length - 1];
  if (!slug || !targetProfileId) return errorJson(400, "bad path");

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "auth required");
  if (!(await isLobbyAdmin(slug, userId))) return errorJson(403, "admin only");

  // Block creator demotion.
  const { data: lobby } = await supabaseMatchAdmin
    .from("scout_lobbies")
    .select("owner_user_id")
    .eq("slug", slug)
    .maybeSingle();
  if (lobby?.owner_user_id === targetProfileId)
    return errorJson(403, "cannot demote the lobby creator");

  const { error: delErr } = await supabaseMatchAdmin
    .from("scout_lobby_admins")
    .delete()
    .eq("lobby_slug", slug)
    .eq("profile_id", targetProfileId);
  if (delErr) {
    logger.error("scoutVerify", `demote failed: ${delErr.message}`);
    return errorJson(500, "internal error");
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: jsonHeaders,
  });
}
