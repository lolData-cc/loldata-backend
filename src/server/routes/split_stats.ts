// src/server/routes/split_stats.ts
// Returns wins/losses/games for the current split (defined by SPLIT_START_EPOCH).
// Mirrors /api/season_stats but filters by matches.game_creation >= splitStart.
// No background fetching — reads only what's already in DB via matchIngest.

import { supabaseMatchAdmin as supabaseAdmin } from "../supabase/client"; // match data → box (hybrid)
import { getCurrentSplitWindow } from "../season";

const Q_SOLO = 420;
const Q_FLEX = 440;

type QueueGroup = "ranked_all" | "ranked_solo" | "ranked_flex";

export type SplitStatsPayload = {
  splitTotals: { games: number; wins: number; losses: number };
  splitStart: number | null; // epoch seconds, or null if unconfigured
  computedAt: number;
};

function queueIdsFor(qg: QueueGroup): number[] {
  if (qg === "ranked_solo") return [Q_SOLO];
  if (qg === "ranked_flex") return [Q_FLEX];
  return [Q_SOLO, Q_FLEX];
}

async function readSplitStatsFromDb(opts: {
  puuid: string;
  queueGroup: QueueGroup;
}): Promise<SplitStatsPayload> {
  const { puuid, queueGroup } = opts;

  const { startTime } = getCurrentSplitWindow();
  if (!startTime) {
    return {
      splitTotals: { games: 0, wins: 0, losses: 0 },
      splitStart: null,
      computedAt: Date.now(),
    };
  }

  const splitStartIso = new Date(startTime * 1000).toISOString();
  const queueIds = queueIdsFor(queueGroup);

  // Join participants → matches on match_id, filter by game_creation + queue_id.
  // PostgREST inner-join syntax: matches!inner(...) lifts joined-table filters.
  // game_creation is a timestamp column, so we pass an ISO string (not epoch ms).
  const { data, error } = await supabaseAdmin
    .from("participants")
    .select("win, matches!inner(game_creation, queue_id)")
    .eq("puuid", puuid)
    .gte("matches.game_creation", splitStartIso)
    .in("matches.queue_id", queueIds);

  if (error) {
    console.error("split_stats query error:", error);
    return {
      splitTotals: { games: 0, wins: 0, losses: 0 },
      splitStart: startTime,
      computedAt: Date.now(),
    };
  }

  let wins = 0;
  let losses = 0;
  for (const row of data ?? []) {
    if (row.win) wins++;
    else losses++;
  }

  return {
    splitTotals: { games: wins + losses, wins, losses },
    splitStart: startTime,
    computedAt: Date.now(),
  };
}

export async function getSplitStatsHandler(req: Request): Promise<Response> {
  const { puuid, region, queueGroup = "ranked_all" } = await req.json();

  if (!puuid || !region) {
    return new Response("Missing puuid/region", { status: 400 });
  }

  let payload: SplitStatsPayload;
  try {
    payload = await readSplitStatsFromDb({
      puuid,
      queueGroup: queueGroup as QueueGroup,
    });
  } catch (err) {
    console.error("split_stats handler error:", err);
    payload = {
      splitTotals: { games: 0, wins: 0, losses: 0 },
      splitStart: null,
      computedAt: Date.now(),
    };
  }

  return Response.json(payload, { status: 200 });
}
