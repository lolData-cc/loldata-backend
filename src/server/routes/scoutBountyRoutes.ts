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
} from "../services/scoutBounty";
import { logger } from "../logger";

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
