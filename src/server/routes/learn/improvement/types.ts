// ── Improvement Tree — shared types ────────────────────────────────────────
// A RoleTree is a static definition (root → category hubs → skill leaves). Each
// skill node carries the human-facing copy (why/how) AND a `verify` fn that runs
// once per analysed game and reports whether that game counted toward the skill.
// Node completion = successGames / eligibleGames over the player's recent games
// of that role, crossing the node's `threshold`.

export type NodeState = "locked" | "progress" | "complete";

export type VerifyResult = {
  eligible: boolean; // did this game give us a chance to demonstrate the skill?
  success: boolean; // did the player demonstrate it?
};

// Everything a verifier needs about ONE analysed game, pre-flattened so each
// check stays a few lines.
export type GameCtx = {
  matchId: string;
  champion: string;
  win: boolean;
  role: string;
  info: any; // match-v5 info (for team lookups)
  me: any; // my participant object (match-v5)
  myId: number; // participantId 1..10
  myTeam: number; // 100 | 200
  teamKills: number;
  events: any[]; // flattened timeline events (all frames)
  frames: any[]; // timeline.info.frames
  durationMin: number;
};

export type SkillNode = {
  id: string; // e.g. "jgl.obj.grubs"
  category: string; // category id
  title: string;
  short: string; // one-line tooltip on the 3D node
  why: string; // the legend — WHY this skill matters
  how: string; // how completion is measured (shown in the detail panel)
  threshold: number; // 0..1 — success ratio needed to fully light the node
  verify: (g: GameCtx) => VerifyResult;
};

export type Category = {
  id: string;
  title: string;
  blurb: string; // short category description
};

export type RoleTree = {
  role: string; // "JUNGLE"
  title: string; // "Path of the Jungle"
  tagline: string;
  categories: Category[];
  nodes: SkillNode[];
};

// ── shared timeline helpers ────────────────────────────────────────────────
export const MIN = 60_000;

export const isEliteKill = (e: any, type?: string) =>
  e?.type === "ELITE_MONSTER_KILL" && (!type || e.monsterType === type);

export const killerTeamOf = (e: any, info: any): number | null => {
  if (e?.killerTeamId === 100 || e?.killerTeamId === 200) return e.killerTeamId;
  const p = info?.participants?.find((x: any) => x.participantId === e?.killerId);
  return p?.teamId ?? null;
};

export const involved = (e: any, myId: number): boolean =>
  e?.killerId === myId ||
  (Array.isArray(e?.assistingParticipantIds) && e.assistingParticipantIds.includes(myId));

export const myFrameAt = (frames: any[], minute: number, myId: number): any | null => {
  const f = frames?.[minute];
  return f?.participantFrames?.[String(myId)] ?? null;
};

export const jungleCsOf = (mf: any): number =>
  (mf?.jungleMinionsKilled ?? mf?.jvMinionsKilled ?? 0) as number;

export const itemBuys = (events: any[], myId: number, itemId: number, beforeMs = Infinity): number =>
  events.filter(
    (e) =>
      e?.type === "ITEM_PURCHASED" &&
      e.participantId === myId &&
      e.itemId === itemId &&
      e.timestamp < beforeMs
  ).length;
