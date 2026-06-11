// src/server/routes/scoutChat.ts
//
// Group chat per scout lobby.
//
//   GET  /api/scout/lobby/:slug/chat?before=<ISO>&limit=N
//     Paginated message read. Newest-first within a page; the
//     frontend reverses to show oldest-at-top.
//
//   POST /api/scout/lobby/:slug/chat
//     Body: { content: string }
//     Auth: must be a claimed lobby member (any verify grade is fine
//     as long as the lobby's verify_mode isn't 'disabled'). If
//     verify_mode='disabled', anyone with a session can post — the
//     lobby admin opted out of identity gating.

import { supabaseAdmin } from "../supabase/client";
import { logger } from "../logger";

const jsonHeaders = { "Content-Type": "application/json" } as const;
const errorJson = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders,
  });

async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

function extractSlug(pathname: string): string | null {
  // /api/scout/lobby/<slug>/chat
  const m = pathname.match(/^\/api\/scout\/lobby\/([^/]+)\/chat$/);
  return m?.[1] ?? null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── GET /chat ──────────────────────────────────────────────────────
export async function readScoutChatHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = extractSlug(pathname);
  if (!slug) return errorJson(400, "bad path");

  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT)
  );

  let q = supabaseAdmin
    .from("scout_lobby_messages")
    .select(
      "id, profile_id, lobby_player_id, display_name, color, content, created_at"
    )
    .eq("lobby_slug", slug)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);

  const { data, error } = await q;
  if (error) {
    logger.error("scoutChat", `read failed: ${error.message}`);
    return errorJson(500, "internal error");
  }

  return new Response(
    JSON.stringify({
      messages: (data ?? []).map((m) => ({
        id: m.id,
        profileId: m.profile_id,
        lobbyPlayerId: m.lobby_player_id,
        displayName: m.display_name,
        color: m.color,
        content: m.content,
        createdAt: m.created_at,
      })),
      nextCursor: data && data.length === limit ? data[data.length - 1].created_at : null,
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── POST /chat ─────────────────────────────────────────────────────
export async function postScoutChatHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = extractSlug(pathname);
  if (!slug) return errorJson(400, "bad path");

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "sign in to post");

  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }
  const content = (body?.content ?? "").trim();
  if (!content) return errorJson(400, "content required");
  if (content.length > 800) return errorJson(400, "content too long");

  // Fetch lobby's verify_mode to decide gating policy.
  const { data: lobby } = await supabaseAdmin
    .from("scout_lobbies")
    .select("verify_mode")
    .eq("slug", slug)
    .maybeSingle();
  if (!lobby) return errorJson(404, "lobby not found");

  // Look up the user's claimed lobby_player (if any) in this lobby.
  const { data: claimedPlayer } = await supabaseAdmin
    .from("scout_lobby_players")
    .select("id, display_name, color")
    .eq("lobby_slug", slug)
    .eq("claimed_by_profile_id", userId)
    .maybeSingle();

  // Permission policy:
  //   • verify_mode='disabled' → anyone with a session can post; if
  //     they happen to be claimed in the lobby we'll use that as the
  //     identity, otherwise we fall back to "Anonymous".
  //   • verify_mode in (claim_only, full) → must be claimed.
  if (lobby.verify_mode !== "disabled" && !claimedPlayer) {
    return errorJson(
      403,
      "you must claim an identity in this lobby to post"
    );
  }

  const displayName = claimedPlayer?.display_name ?? "Anonymous";
  const color = claimedPlayer?.color ?? null;
  const lobbyPlayerId = claimedPlayer?.id ?? null;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("scout_lobby_messages")
    .insert({
      lobby_slug: slug,
      profile_id: userId,
      lobby_player_id: lobbyPlayerId,
      display_name: displayName,
      color,
      content,
    })
    .select(
      "id, profile_id, lobby_player_id, display_name, color, content, created_at"
    )
    .single();
  if (insErr || !inserted) {
    logger.error("scoutChat", `insert failed: ${insErr?.message}`);
    return errorJson(500, "internal error");
  }

  return new Response(
    JSON.stringify({
      message: {
        id: inserted.id,
        profileId: inserted.profile_id,
        lobbyPlayerId: inserted.lobby_player_id,
        displayName: inserted.display_name,
        color: inserted.color,
        content: inserted.content,
        createdAt: inserted.created_at,
      },
    }),
    { status: 200, headers: jsonHeaders }
  );
}
