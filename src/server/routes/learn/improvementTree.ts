// POST /api/learn/improvement-tree
// Body: { puuid, region, role? }
//  - role given  → set it as the chosen path AND return that tree's live progress
//  - role absent → use the stored path; if none, return { needsPathSelection }
// Progress is computed live from the player's recent ranked games OF THAT ROLE:
// each game's timeline is run through every node's verify() and the successes are
// aggregated into locked / in-progress / complete states.
import { getMatchIdsByPuuidOpts, getMatchDetails, getMatchTimeline } from "../../riot";
import { getCurrentSeasonWindow } from "../../season";
import { JUNGLE_TREE } from "./improvement/jungle";
import type { RoleTree, GameCtx } from "./improvement/types";
import { getChosenPath, setChosenPath } from "./improvement/progressStore";

const ROLES = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"] as const;
const ROLE_TO_POS: Record<string, string> = { TOP: "TOP", JUNGLE: "JUNGLE", MID: "MIDDLE", ADC: "BOTTOM", SUPPORT: "UTILITY" };
const TREES: Record<string, RoleTree> = { JUNGLE: JUNGLE_TREE };

const ROLE_GAMES = 10; // games (with timelines) to analyse per tree load
const DETAIL_CAP = 26; // most-recent ranked matches to inspect for role matches

// result cache — a full tree computation is heavy (many Riot calls)
const treeCache = new Map<string, { data: any; ts: number }>();
const TREE_TTL = 10 * 60 * 1000;
// raw-timeline cache (30 min) shared across loads
const tlCache = new Map<string, { tl: any; ts: number }>();
const TL_TTL = 30 * 60 * 1000;

function json(x: any, status = 200): Response {
  return new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
}

async function getTimeline(matchId: string, region: string): Promise<any | null> {
  const hit = tlCache.get(matchId);
  if (hit && Date.now() - hit.ts < TL_TTL) return hit.tl;
  try {
    const tl = await getMatchTimeline(matchId, region);
    if (tlCache.size > 500) tlCache.clear();
    tlCache.set(matchId, { tl, ts: Date.now() });
    return tl;
  } catch {
    return null;
  }
}

export async function improvementTreeHandler(req: Request): Promise<Response> {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const puuid: string | undefined = body.puuid;
  const region: string | undefined = body.region;
  let role: string | null = body.role ? String(body.role).toUpperCase() : null;

  if (!puuid || !region) return json({ error: "Missing puuid or region" }, 400);

  // resolve / persist the chosen path
  if (role && ROLES.includes(role as any)) {
    await setChosenPath(puuid, region, role);
  } else {
    role = await getChosenPath(puuid);
  }
  if (!role) return json({ needsPathSelection: true, roles: ROLES });

  const tree = TREES[role];
  if (!tree) return json({ role, comingSoon: true, roles: ROLES }); // path chosen, tree not built yet

  const cacheKey = `${puuid}:${role}`;
  const cached = treeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TREE_TTL && !body.role) {
    return json(cached.data);
  }

  // 1) recent ranked match ids
  const { startTime, endTime } = getCurrentSeasonWindow();
  let ids: string[] = [];
  try {
    ids = await getMatchIdsByPuuidOpts(puuid, region, { start: 0, count: 60, type: "ranked", startTime, endTime });
  } catch {
    return json({ error: "Failed to fetch match history" }, 502);
  }

  // 2) fetch details of the most-recent ids, keep games played in this role
  const wantPos = ROLE_TO_POS[role];
  const roleGames: { matchId: string; info: any; me: any }[] = [];
  const BATCH = 5;
  for (let i = 0; i < Math.min(ids.length, DETAIL_CAP) && roleGames.length < ROLE_GAMES; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map((id) => getMatchDetails(id, region)));
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value?.info) continue;
      const info = r.value.info;
      const me = info.participants?.find((p: any) => p.puuid === puuid);
      const pos = me?.teamPosition || me?.individualPosition || "";
      if (me && pos === wantPos) roleGames.push({ matchId: r.value.metadata?.matchId ?? "", info, me });
      if (roleGames.length >= ROLE_GAMES) break;
    }
  }

  // 3) timelines (bounded) → build a GameCtx per game that actually has a timeline
  const withTl = await Promise.all(
    roleGames.map(async (g) => ({ ...g, tl: await getTimeline(g.matchId, region) }))
  );
  const ctxs: GameCtx[] = withTl
    .filter((g) => g.tl?.info?.frames?.length)
    .map((g) => {
      const info = g.info;
      const me = g.me;
      const myTeam = me.teamId;
      const teamKills = info.participants
        .filter((p: any) => p.teamId === myTeam)
        .reduce((s: number, p: any) => s + (p.kills ?? 0), 0);
      const frames = g.tl.info.frames as any[];
      const events = frames.flatMap((f) => f.events ?? []);
      return {
        matchId: g.matchId,
        champion: me.championName ?? "Unknown",
        win: !!me.win,
        role,
        info,
        me,
        myId: me.participantId,
        myTeam,
        teamKills,
        events,
        frames,
        durationMin: (info.gameDuration ?? 0) / 60,
      } as GameCtx;
    });

  // 4) aggregate every node over the analysed games
  const nodes = tree.nodes.map((n) => {
    let eligible = 0;
    let success = 0;
    const games: { matchId: string; champion: string; win: boolean; success: boolean }[] = [];
    for (const g of ctxs) {
      const r = n.verify(g);
      if (!r.eligible) continue;
      eligible++;
      if (r.success) success++;
      games.push({ matchId: g.matchId, champion: g.champion, win: g.win, success: r.success });
    }
    const progress = eligible > 0 ? success / eligible : 0;
    const state = eligible === 0 ? "locked" : progress >= n.threshold ? "complete" : "progress";
    return {
      id: n.id,
      category: n.category,
      title: n.title,
      short: n.short,
      why: n.why,
      how: n.how,
      threshold: n.threshold,
      state,
      progress,
      eligibleGames: eligible,
      successGames: success,
      detail: eligible > 0 ? `${success} / ${eligible} games` : "No eligible games yet",
      games,
    };
  });

  const data = {
    role,
    title: tree.title,
    tagline: tree.tagline,
    categories: tree.categories,
    gamesAnalyzed: ctxs.length,
    nodes,
    updatedAt: Date.now(),
  };
  treeCache.set(cacheKey, { data, ts: Date.now() });
  return json(data);
}
