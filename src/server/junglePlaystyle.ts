export type JunglePlaystyleTag =
  | "played_for_topside"
  | "played_for_botside"
  | "played_for_both"
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

type TimelineLike = {
  info?: {
    frames?: Array<{
      events?: any[];
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

export type JungleTeamPlaystyleResult = {
  participantId: number;
  teamId: number;
  tag: JunglePlaystyleTag;
  topsideCount: number;
  botsideCount: number;
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

  return {
    participantId: jungler.participantId,
    teamId,
    tag: getFinalTag(topsideCount, botsideCount),
    topsideCount,
    botsideCount,
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