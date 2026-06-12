// src/server/routes/scoutBountyRoutes.ts
//
// Thin HTTP handlers wrapping the scoutBounty service.
//
//   GET /api/scout/bounty/today/:slug
//   GET /api/scout/bounty/leaderboard/:slug
//
// Both endpoints are public for the lobby view (no auth gate) because
// the bounty state is meant to be visible to everyone who lands on the
// scout lobby page.

import {
  readTodayBountyPayload,
  readBountyLeaderboard,
  formatBountyValue,
} from "../services/scoutBounty";
import { broadcastBountyEvent } from "../realtime/scoutRealtime";
import { supabaseAdmin } from "../supabase/client";
import { logger } from "../logger";

async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// Pull the trailing `:slug` segment off a path like
// "/api/scout/bounty/today/some-slug" — defensive against trailing
// slashes or extra path parts.
function slugFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slug = rest.split("/")[0]?.trim();
  return slug || null;
}

const jsonHeaders = { "Content-Type": "application/json" } as const;

export async function readScoutBountyTodayHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = slugFromPath(pathname, "/api/scout/bounty/today/");
  if (!slug) {
    return new Response(JSON.stringify({ error: "missing lobby slug" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  try {
    const payload = await readTodayBountyPayload(slug);
    if (!payload) {
      return new Response(
        JSON.stringify({ error: "no bounty available" }),
        { status: 404, headers: jsonHeaders }
      );
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err: any) {
    logger.error(
      "scoutBountyRoutes",
      `today handler failed for ${slug}: ${err?.message}`
    );
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

// POST /api/scout/bounty/preview/:slug  (lobby owner only)
//
// Fires a sample "bounty banner" over the lobby chat WebSocket so the
// owner can SEE the animation on demand — without waiting for a real
// claim. Cosmetic only: broadcasts the current day's bounty (with its
// real claimer if claimed, else a placeholder). Persists nothing.
export async function previewScoutBountyHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = slugFromPath(pathname, "/api/scout/bounty/preview/");
  if (!slug) {
    return new Response(JSON.stringify({ error: "missing lobby slug" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const userId = await getAuthUserId(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "sign in" }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  // Owner gate.
  const { data: lobby } = await supabaseAdmin
    .from("scout_lobbies")
    .select("owner_user_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!lobby) {
    return new Response(JSON.stringify({ error: "lobby not found" }), {
      status: 404,
      headers: jsonHeaders,
    });
  }
  if (lobby.owner_user_id !== userId) {
    return new Response(JSON.stringify({ error: "owner only" }), {
      status: 403,
      headers: jsonHeaders,
    });
  }

  try {
    const payload = await readTodayBountyPayload(slug);
    const tpl = payload?.template;
    const event = {
      id: crypto.randomUUID(),
      title: tpl?.title ?? "Banker",
      icon: tpl?.icon ?? "coins",
      rarity: tpl?.rarity ?? "common",
      metric: tpl?.metric ?? "gold",
      playerName: payload?.claimed_by?.display_name ?? "Preview",
      color: payload?.claimed_by?.color ?? "#00d992",
      valueLabel:
        payload?.claimed_value != null && tpl
          ? formatBountyValue(tpl.metric, payload.claimed_value)
          : "18,917 gold",
      overtake: false,
      createdAt: new Date().toISOString(),
    };
    broadcastBountyEvent(slug, event);
    return new Response(JSON.stringify({ ok: true, event }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err: any) {
    logger.error(
      "scoutBountyRoutes",
      `preview handler failed for ${slug}: ${err?.message}`
    );
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

export async function readScoutBountyLeaderboardHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = slugFromPath(pathname, "/api/scout/bounty/leaderboard/");
  if (!slug) {
    return new Response(JSON.stringify({ error: "missing lobby slug" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  try {
    const payload = await readBountyLeaderboard(slug);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err: any) {
    logger.error(
      "scoutBountyRoutes",
      `leaderboard handler failed for ${slug}: ${err?.message}`
    );
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
