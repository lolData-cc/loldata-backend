export type JunglePlaystyleTag =
  | "played_for_topside"
  | "played_for_botside"
  | "played_for_both"
  | null;

export type JungleStartingCamp =
  | "blue"
  | "red"
  | "gromp"
  | "wolves"
  | "raptors"
  | "krugs"
  | "enemy_blue"
  | "enemy_red"
  | "enemy_gromp"
  | "enemy_wolves"
  | "enemy_raptors"
  | "enemy_krugs"
  | null;

type Position = {
  x: number;
  y: number;
};

type ParticipantLike = {
  participantId: number;
  teamId: number;
  teamPosition?: string;
  individualPosition?: string;
};

type MatchLike = {
  info: {
    participants: ParticipantLike[];
  };
};

type TimelineKillEvent = {
  type: "CHAMPION_KILL";
  timestamp: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: Position;
};

type TimelineParticipantFrame = {
  participantId: number;
  position?: Position;
  jungleMinionsKilled: number;
};

type TimelineLike = {
  info?: {
    frames?: Array<{
      timestamp?: number;
      events?: any[];
      participantFrames?: Record<string, TimelineParticipantFrame>;
    }>;
  };
};

type TeamRoleMap = {
  top?: ParticipantLike;
  jungle?: ParticipantLike;
  mid?: ParticipantLike;
  adc?: ParticipantLike;
  support?: ParticipantLike;
};

export type JungleInvade = "invade" | "no_invade" | null;

export type JungleTeamPlaystyleResult = {
  participantId: number;
  teamId: number;
  tag: JunglePlaystyleTag;
  topsideCount: number;
  botsideCount: number;
  startingCamp: JungleStartingCamp;
  invade: JungleInvade;
};

export type MatchJunglePlaystyleResult = {
  blue: JungleTeamPlaystyleResult | null;
  red: JungleTeamPlaystyleResult | null;
};

function getRole(p: ParticipantLike) {
  return p.teamPosition || p.individualPosition || "";
}

function getTeamRoleMap(participants: ParticipantLike[], teamId: number): TeamRoleMap {
  const team = participants.filter((p) => p.teamId === teamId);

  return {
    top: team.find((p) => getRole(p) === "TOP"),
    jungle: team.find((p) => getRole(p) === "JUNGLE"),
    mid: team.find((p) => getRole(p) === "MIDDLE"),
    adc: team.find((p) => getRole(p) === "BOTTOM"),
    support: team.find((p) => getRole(p) === "UTILITY"),
  };
}

function classifyMapSideByPosition(position?: Position): "topside" | "botside" | "neutral" {
  if (!position) return "neutral";

  const { x, y } = position;
  const diff = y - x;

  // abbastanza largo per evitare classificazioni troppo aggressive in mid/river
  if (diff > 2500) return "topside";
  if (diff < -2500) return "botside";

  return "neutral";
}

function getFinalTag(topsideCount: number, botsideCount: number): JunglePlaystyleTag {
  if (topsideCount >= 2 && botsideCount >= 2) return "played_for_both";
  if (topsideCount >= 2 && topsideCount > botsideCount) return "played_for_topside";
  if (botsideCount >= 2 && botsideCount > topsideCount) return "played_for_botside";
  return null;
}

function classifyJungleEventSide(
  event: TimelineKillEvent,
  allies: TeamRoleMap,
  enemies: TeamRoleMap
): "topside" | "botside" | "neutral" {
  const involved = new Set<number>();

  if (event.killerId != null) involved.add(event.killerId);
  for (const id of event.assistingParticipantIds || []) involved.add(id);

  const allyTopId = allies.top?.participantId;
  const enemyTopId = enemies.top?.participantId;

  const allyBotIds = [allies.adc?.participantId, allies.support?.participantId].filter(
    (x): x is number => x != null
  );
  const enemyBotIds = [enemies.adc?.participantId, enemies.support?.participantId].filter(
    (x): x is number => x != null
  );

  const victimId = event.victimId;

  const touchesTop =
    victimId === allyTopId ||
    victimId === enemyTopId ||
    (allyTopId != null && involved.has(allyTopId)) ||
    (enemyTopId != null && involved.has(enemyTopId));

  const touchesBot =
    allyBotIds.includes(victimId as number) ||
    enemyBotIds.includes(victimId as number) ||
    allyBotIds.some((id) => involved.has(id)) ||
    enemyBotIds.some((id) => involved.has(id));

  if (touchesTop && !touchesBot) return "topside";
  if (touchesBot && !touchesTop) return "botside";

  return classifyMapSideByPosition(event.position);
}

// ── Starting camp detection ─────────────────────────────────────────

type CampLocation = { name: JungleStartingCamp; x: number; y: number };

const BLUE_SIDE_CAMPS: CampLocation[] = [
  { name: "blue",    x: 3828,  y: 7578 },
  { name: "gromp",   x: 2288,  y: 8428 },
  { name: "wolves",  x: 3778,  y: 6478 },
  { name: "red",     x: 7558,  y: 3778 },
  { name: "raptors", x: 7060,  y: 5400 },
  { name: "krugs",   x: 8388,  y: 2778 },
];

const RED_SIDE_CAMPS: CampLocation[] = [
  { name: "blue",    x: 10822, y: 6828 },
  { name: "gromp",   x: 12588, y: 6228 },
  { name: "wolves",  x: 10978, y: 8178 },
  { name: "red",     x: 7148,  y: 10828 },
  { name: "raptors", x: 7820,  y: 9400 },
  { name: "krugs",   x: 6378,  y: 11928 },
];

function distance(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Detects the jungler's starting camp by checking their position
 * at the ~60s frame (camps spawn at 0:55 in S16).
 * Checks both own and enemy camps — if closest camp is enemy's,
 * returns "enemy_blue", "enemy_red", etc.
 */
function detectStartingCamp(
  timeline: TimelineLike,
  jungler: ParticipantLike,
  teamId: number
): JungleStartingCamp {
  const frames = timeline.info?.frames;
  if (!frames || frames.length < 2) return null;

  // frame index 1 = ~60s, right when camps spawn
  const frame = frames[1];
  const pFrame = frame?.participantFrames?.[String(jungler.participantId)];
  if (!pFrame?.position) return null;

  const ownCamps = teamId === 100 ? BLUE_SIDE_CAMPS : RED_SIDE_CAMPS;
  const enemyCamps = teamId === 100 ? RED_SIDE_CAMPS : BLUE_SIDE_CAMPS;

  let closestName: JungleStartingCamp = null;
  let minDist = Infinity;

  for (const camp of ownCamps) {
    const d = distance(pFrame.position, camp);
    if (d < minDist) {
      minDist = d;
      closestName = camp.name;
    }
  }

  for (const camp of enemyCamps) {
    const d = distance(pFrame.position, camp);
    if (d < minDist) {
      minDist = d;
      closestName = `enemy_${camp.name}` as JungleStartingCamp;
    }
  }

  // threshold: if jungler is too far from any camp (~1500 units), something is off
  if (!closestName || minDist > 1500) return null;

  return closestName;
}

/**
 * Detects if the jungler invaded the enemy jungle.
 * A kill counts as an invade when ALL of these are true:
 *  1. Happens before 5 minutes
 *  2. Jungler is the killer (not just an assist)
 *  3. Kill position is within 1500u of an enemy camp
 *  4. Kill position is closer to the nearest enemy camp than
 *     to the nearest own camp (filters out mid-lane / river fights)
 */
function detectInvade(
  timeline: TimelineLike,
  jungler: ParticipantLike,
  teamId: number
): JungleInvade {
  const frames = timeline.info?.frames;
  if (!frames) return null;

  const INVADE_CUTOFF = 5 * 60 * 1000; // 5 minutes
  const ownCamps = teamId === 100 ? BLUE_SIDE_CAMPS : RED_SIDE_CAMPS;
  const enemyCamps = teamId === 100 ? RED_SIDE_CAMPS : BLUE_SIDE_CAMPS;

  const nearestCampDist = (pos: Position, camps: CampLocation[]) =>
    Math.min(...camps.map((c) => distance(pos, c)));

  for (const frame of frames) {
    for (const rawEvent of frame.events || []) {
      if (rawEvent?.type !== "CHAMPION_KILL") continue;

      const event = rawEvent as TimelineKillEvent;
      if (event.timestamp > INVADE_CUTOFF) continue;
      if (!event.position) continue;

      // Only count kills where the jungler is the killer
      if (event.killerId !== jungler.participantId) continue;

      const distToEnemy = nearestCampDist(event.position, enemyCamps);
      const distToOwn = nearestCampDist(event.position, ownCamps);

      // Must be within 1500u of an enemy camp AND closer to enemy camps than own
      if (distToEnemy < 1500 && distToEnemy < distToOwn) {
        return "invade";
      }
    }
  }

  return "no_invade";
}

function getTeamJunglePlaystyle(
  match: MatchLike,
  timeline: TimelineLike,
  teamId: number,
  maxTimestamp = 15 * 60 * 1000
): JungleTeamPlaystyleResult | null {
  const participants = match.info.participants || [];
  const allies = getTeamRoleMap(participants, teamId);
  const enemies = getTeamRoleMap(participants, teamId === 100 ? 200 : 100);

  const jungler = allies.jungle;
  if (!jungler) return null;

  let topsideCount = 0;
  let botsideCount = 0;

  for (const frame of timeline.info?.frames || []) {
    for (const rawEvent of frame.events || []) {
      if (rawEvent?.type !== "CHAMPION_KILL") continue;

      const event = rawEvent as TimelineKillEvent;
      if (event.timestamp > maxTimestamp) continue;

      const junglerInvolved =
        event.killerId === jungler.participantId ||
        (event.assistingParticipantIds || []).includes(jungler.participantId);

      if (!junglerInvolved) continue;

      const side = classifyJungleEventSide(event, allies, enemies);

      if (side === "topside") topsideCount++;
      if (side === "botside") botsideCount++;
    }
  }

  const startingCamp = detectStartingCamp(timeline, jungler, teamId);
  const invade = detectInvade(timeline, jungler, teamId);

  return {
    participantId: jungler.participantId,
    teamId,
    tag: getFinalTag(topsideCount, botsideCount),
    topsideCount,
    botsideCount,
    startingCamp,
    invade,
  };
}

export function getMatchJunglePlaystyle(
  match: MatchLike,
  timeline: TimelineLike
): MatchJunglePlaystyleResult {
  return {
    blue: getTeamJunglePlaystyle(match, timeline, 100),
    red: getTeamJunglePlaystyle(match, timeline, 200),
  };
}