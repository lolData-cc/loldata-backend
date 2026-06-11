// src/server/routes/scoutMatchSocial.ts
//
// Per-match social: likes + comments.
//
//   GET   /api/scout/lobby/:slug/match-social?ids=m1,m2,...
//         Batch fetch reaction counts + comment counts for visible
//         matches. If the request is authed, also returns the list
//         of matchIds the caller has liked (so the heart UI can
//         render as "filled").
//
//   POST  /api/scout/lobby/:slug/match/:matchId/like
//         Toggle the caller's like. INSERT if absent, DELETE if
//         present. Returns the new count + whether the caller liked.
//
//   GET   /api/scout/lobby/:slug/match/:matchId/comments?limit=N
//         List comments oldest-first within a page.
//
//   POST  /api/scout/lobby/:slug/match/:matchId/comments
//         { content }. Verify-mode gating mirrors the chat handler.

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

// Path helpers — index.ts matches the prefix; we slice out the slug
// (and matchId for the single-match variants).
function extractSlugForSocialBatch(pathname: string): string | null {
  const m = pathname.match(/^\/api\/scout\/lobby\/([^/]+)\/match-social$/);
  return m?.[1] ?? null;
}
function extractSlugAndMatch(
  pathname: string,
  suffix: "/like" | "/comments"
): { slug: string; matchId: string } | null {
  const m = pathname.match(
    new RegExp(`^/api/scout/lobby/([^/]+)/match/([^/]+)${suffix}$`)
  );
  if (!m) return null;
  return { slug: m[1], matchId: m[2] };
}

// ─── GET /match-social (batch) ──────────────────────────────────────
export async function readMatchSocialBatchHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = extractSlugForSocialBatch(pathname);
  if (!slug) return errorJson(400, "bad path");

  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const matchIds = (idsParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (matchIds.length === 0) {
    return new Response(
      JSON.stringify({ counts: {}, myLikes: [] }),
      { status: 200, headers: jsonHeaders }
    );
  }

  // Likes per match.
  const { data: reactionRows, error: rErr } = await supabaseAdmin
    .from("scout_match_reactions")
    .select("match_id, profile_id")
    .eq("lobby_slug", slug)
    .in("match_id", matchIds);
  if (rErr) {
    logger.error("scoutMatchSocial", `reactions read: ${rErr.message}`);
    return errorJson(500, "internal error");
  }

  // Comments per match — just counts (full list comes from /comments).
  const { data: commentRows, error: cErr } = await supabaseAdmin
    .from("scout_match_comments")
    .select("match_id")
    .eq("lobby_slug", slug)
    .in("match_id", matchIds);
  if (cErr) {
    logger.error("scoutMatchSocial", `comments read: ${cErr.message}`);
    return errorJson(500, "internal error");
  }

  const userId = await getAuthUserId(req);

  // Resolve likers to display names + colours via scout_lobby_players
  // joined on claimed_by_profile_id. A liker who isn't claimed in this
  // lobby shows as "Someone" — the tooltip then renders just the
  // anonymous count for those.
  const likerProfileIds = Array.from(
    new Set((reactionRows ?? []).map((r) => r.profile_id))
  );
  const profileLabel = new Map<string, { displayName: string; color: string | null }>();
  if (likerProfileIds.length > 0) {
    const { data: claimed } = await supabaseAdmin
      .from("scout_lobby_players")
      .select("claimed_by_profile_id, display_name, color")
      .eq("lobby_slug", slug)
      .in("claimed_by_profile_id", likerProfileIds);
    for (const row of (claimed ?? []) as any[]) {
      if (row.claimed_by_profile_id) {
        profileLabel.set(row.claimed_by_profile_id, {
          displayName: row.display_name,
          color: row.color,
        });
      }
    }
  }

  const counts: Record<string, { likes: number; comments: number }> = {};
  const likers: Record<
    string,
    Array<{ profileId: string; displayName: string; color: string | null }>
  > = {};
  for (const mid of matchIds) {
    counts[mid] = { likes: 0, comments: 0 };
    likers[mid] = [];
  }
  for (const r of reactionRows ?? []) {
    if (!counts[r.match_id]) continue;
    counts[r.match_id].likes += 1;
    const meta = profileLabel.get(r.profile_id);
    likers[r.match_id].push({
      profileId: r.profile_id,
      displayName: meta?.displayName ?? "Someone",
      color: meta?.color ?? null,
    });
  }
  for (const c of commentRows ?? []) {
    if (counts[c.match_id]) counts[c.match_id].comments += 1;
  }

  const myLikes: string[] = [];
  if (userId) {
    for (const r of reactionRows ?? []) {
      if (r.profile_id === userId) myLikes.push(r.match_id);
    }
  }

  return new Response(JSON.stringify({ counts, likers, myLikes }), {
    status: 200,
    headers: jsonHeaders,
  });
}

// ─── POST /like (toggle) ────────────────────────────────────────────
export async function toggleLikeHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = extractSlugAndMatch(pathname, "/like");
  if (!parsed) return errorJson(400, "bad path");
  const { slug, matchId } = parsed;

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "sign in to like");

  // Check current state.
  const { data: existing } = await supabaseAdmin
    .from("scout_match_reactions")
    .select("id")
    .eq("lobby_slug", slug)
    .eq("match_id", matchId)
    .eq("profile_id", userId)
    .maybeSingle();

  let iLiked: boolean;
  if (existing) {
    const { error } = await supabaseAdmin
      .from("scout_match_reactions")
      .delete()
      .eq("id", existing.id);
    if (error) {
      logger.error("scoutMatchSocial", `like delete: ${error.message}`);
      return errorJson(500, "internal error");
    }
    iLiked = false;
  } else {
    const { error } = await supabaseAdmin
      .from("scout_match_reactions")
      .insert({ lobby_slug: slug, match_id: matchId, profile_id: userId });
    if (error) {
      // UNIQUE race → treat as "now liked" idempotently.
      const code = (error as any).code;
      if (code !== "23505") {
        logger.error(
        "scoutMatchSocial",
        `like insert: ${error.message || JSON.stringify(error)}`
      );
        return errorJson(500, "internal error");
      }
    }
    iLiked = true;
  }

  // Recount.
  const { count } = await supabaseAdmin
    .from("scout_match_reactions")
    .select("id", { count: "exact", head: true })
    .eq("lobby_slug", slug)
    .eq("match_id", matchId);

  return new Response(JSON.stringify({ iLiked, likes: count ?? 0 }), {
    status: 200,
    headers: jsonHeaders,
  });
}

// ─── GET /comments ──────────────────────────────────────────────────
export async function readCommentsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = extractSlugAndMatch(pathname, "/comments");
  if (!parsed) return errorJson(400, "bad path");
  const { slug, matchId } = parsed;

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  const { data, error } = await supabaseAdmin
    .from("scout_match_comments")
    .select(
      "id, profile_id, lobby_player_id, display_name, color, content, parent_comment_id, created_at"
    )
    .eq("lobby_slug", slug)
    .eq("match_id", matchId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    logger.error("scoutMatchSocial", `comments read: ${error.message}`);
    return errorJson(500, "internal error");
  }

  return new Response(
    JSON.stringify({
      comments: (data ?? []).map((c) => ({
        id: c.id,
        profileId: c.profile_id,
        lobbyPlayerId: c.lobby_player_id,
        displayName: c.display_name,
        color: c.color,
        content: c.content,
        parentCommentId: c.parent_comment_id ?? null,
        createdAt: c.created_at,
      })),
    }),
    { status: 200, headers: jsonHeaders }
  );
}

// ─── POST /comments ─────────────────────────────────────────────────
export async function postCommentHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const parsed = extractSlugAndMatch(pathname, "/comments");
  if (!parsed) return errorJson(400, "bad path");
  const { slug, matchId } = parsed;

  const userId = await getAuthUserId(req);
  if (!userId) return errorJson(401, "sign in to comment");

  let body: { content?: string; parentCommentId?: string | null };
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "bad json");
  }
  const content = (body?.content ?? "").trim();
  if (!content) return errorJson(400, "content required");
  if (content.length > 600) return errorJson(400, "content too long");
  const parentCommentId =
    typeof body?.parentCommentId === "string" && body.parentCommentId.length > 0
      ? body.parentCommentId
      : null;

  // Commenting requires a CLAIMED (certified) identity in this lobby —
  // always, regardless of verify_mode. There is no anonymous posting:
  // every comment is attributable to a claimed lobby member. (Earlier
  // a verify_mode='disabled' bypass let any signed-in user post as
  // "Anonymous"; that's removed.)
  const { data: claimedPlayer } = await supabaseAdmin
    .from("scout_lobby_players")
    .select("id, display_name, color")
    .eq("lobby_slug", slug)
    .eq("claimed_by_profile_id", userId)
    .maybeSingle();

  if (!claimedPlayer) {
    return errorJson(
      403,
      "claim an identity in this lobby to comment"
    );
  }

  const displayName = claimedPlayer.display_name;
  const color = claimedPlayer.color ?? null;
  const lobbyPlayerId = claimedPlayer.id;

  // If a parent comment id was supplied, validate it belongs to this
  // same (lobby_slug, match_id) so we can't cross-thread replies.
  if (parentCommentId) {
    const { data: parent } = await supabaseAdmin
      .from("scout_match_comments")
      .select("id, lobby_slug, match_id")
      .eq("id", parentCommentId)
      .maybeSingle();
    if (
      !parent ||
      parent.lobby_slug !== slug ||
      parent.match_id !== matchId
    ) {
      return errorJson(400, "parent comment not in this thread");
    }
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("scout_match_comments")
    .insert({
      lobby_slug: slug,
      match_id: matchId,
      profile_id: userId,
      lobby_player_id: lobbyPlayerId,
      display_name: displayName,
      color,
      content,
      parent_comment_id: parentCommentId,
    })
    .select(
      "id, profile_id, lobby_player_id, display_name, color, content, parent_comment_id, created_at"
    )
    .single();
  if (error || !inserted) {
    logger.error(
      "scoutMatchSocial",
      `comment insert: ${error?.message || JSON.stringify(error)}`
    );
    return errorJson(500, "internal error");
  }

  return new Response(
    JSON.stringify({
      comment: {
        id: inserted.id,
        profileId: inserted.profile_id,
        lobbyPlayerId: inserted.lobby_player_id,
        displayName: inserted.display_name,
        color: inserted.color,
        content: inserted.content,
        parentCommentId: inserted.parent_comment_id ?? null,
        createdAt: inserted.created_at,
      },
    }),
    { status: 200, headers: jsonHeaders }
  );
}
