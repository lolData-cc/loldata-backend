// src/server/ai/timelineAnalysis.ts
//
// Turns a raw Riot match-v5 TIMELINE into concrete, position-aware coaching
// signals for the my_game AI tool: where each death happened (zone + side),
// whether the player was ISOLATED (no allies nearby), deaths that happened far
// from a contested objective, lane gold/cs/xp diffs vs the direct opponent, and
// timeline-derived kill participation. The AI reasons over these to say WHAT went
// wrong ("you died bot 5 times while you're top", "died alone in 7/11 deaths",
// "died top at 19:30 while baron was being set up bot").
//
// SR map is ~0..14820. Coordinate heuristics mirror junglePlaystyle.ts
// (topside/botside via y-x), refined here with lane/river/jungle zones.

type Pos = { x: number; y: number };
const MAP = 14820;

function dist(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const FOUNTAIN_BLUE: Pos = { x: 560, y: 560 };
const FOUNTAIN_RED: Pos = { x: 14260, y: 14260 };

// Coarse, ROBUST side from the diagonal (used for in-lane vs roaming logic).
function sideOf(p: Pos): "topside" | "botside" | "mid" {
  const diff = p.y - p.x;
  if (diff > 1800) return "topside";
  if (diff < -1800) return "botside";
  return "mid";
}

// Finer, best-effort human zone label (for colour in the answer).
function zoneOf(p: Pos): string {
  if (dist(p, FOUNTAIN_BLUE) < 2400 || dist(p, FOUNTAIN_RED) < 2400) return "base";
  const { x, y } = p;
  const side = sideOf(p);
  const nearRiver = Math.abs(x + y - MAP) < 1700;
  // Lane corridors hug the edges of the map.
  const topLane = (x < 2900 && y > 3000) || (y > 11900 && x < 11800);
  const botLane = (y < 2900 && x > 3000) || (x > 11900 && y < 11800);
  if (topLane) return "top lane";
  if (botLane) return "bot lane";
  if (side === "mid") return nearRiver ? "river (mid)" : "mid lane";
  if (nearRiver) return side === "topside" ? "top river" : "bot river";
  return side === "topside" ? "top-side jungle" : "bot-side jungle";
}

// The lane "side" a role is expected to play around.
function laneSideForRole(role: string): "topside" | "botside" | "mid" | "jungle" {
  const r = role.toUpperCase();
  if (r === "TOP") return "topside";
  if (r === "MIDDLE") return "mid";
  if (r === "BOTTOM" || r === "UTILITY") return "botside";
  return "jungle";
}

export type PMeta = {
  participantId: number;
  puuid: string;
  teamId: number;
  role: string;
  champion: string;
};

type LaneDiff = { gold_diff: number; xp_diff: number; cs_diff: number; my_cs: number } | null;

export type GameTimelineAnalysis =
  | { available: false; reason: string }
  | {
      available: true;
      deaths: Array<{
        time: string;
        zone: string;
        alone: boolean;
        allies_nearby: number;
        enemies_involved: number;
        in_lane: boolean;
      }>;
      death_summary: {
        total: number;
        alone: number;
        in_own_lane: number;
        roaming: number;
        by_zone: Record<string, number>;
        first_death_min: number | null;
      };
      laning: { opponent: string | null; at_10: LaneDiff; at_14: LaneDiff } | null;
      deaths_away_from_objective: Array<{ time: string; you_were: string; objective: string }>;
      kp_pct_timeline: number | null;
      teamfights_died_alone: number;
    };

export function analyzeGameTimeline(
  timeline: any,
  parts: PMeta[],
  myPuuid: string
): GameTimelineAnalysis {
  const frames: any[] = timeline?.info?.frames ?? [];
  if (!frames.length) return { available: false, reason: "no timeline frames" };
  const me = parts.find((p) => p.puuid === myPuuid);
  if (!me) return { available: false, reason: "participant not found in match" };

  const myPid = me.participantId;
  const myTeam = me.teamId;
  const mySide = laneSideForRole(me.role);
  const allyPids = parts
    .filter((p) => p.teamId === myTeam && p.participantId !== myPid)
    .map((p) => p.participantId);
  const teamById = new Map(parts.map((p) => [p.participantId, p]));
  const oppo = parts.find((p) => p.teamId !== myTeam && p.role === me.role) ?? null;

  const fmtT = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const frameNear = (ms: number) => {
    let best = frames[0];
    let bd = Infinity;
    for (const f of frames) {
      const d = Math.abs((f.timestamp ?? 0) - ms);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  };

  const objectives: Array<{ t: number; type: string; pos: Pos | null }> = [];
  const deaths: Array<{
    t: number;
    pos: Pos | null;
    zone: string;
    side: string;
    alliesNearby: number;
    enemiesInvolved: number;
  }> = [];
  let teamKills = 0;
  let myInvolved = 0;

  for (const f of frames) {
    for (const e of f.events ?? []) {
      if (e.type === "CHAMPION_KILL") {
        const killerTeam = teamById.get(e.killerId)?.teamId;
        if (killerTeam === myTeam) {
          teamKills++;
          if (e.killerId === myPid || (e.assistingParticipantIds ?? []).includes(myPid)) myInvolved++;
        }
        if (e.victimId === myPid) {
          const pos = (e.position as Pos) ?? null;
          let alliesNearby = 0;
          if (pos) {
            const pf = frameNear(e.timestamp)?.participantFrames ?? {};
            for (const pid of allyPids) {
              const ap = pf[String(pid)]?.position;
              if (ap && dist(ap, pos) < 2900) alliesNearby++;
            }
          }
          const enemiesInvolved =
            1 + (e.assistingParticipantIds ?? []).filter((id: number) => teamById.get(id)?.teamId !== myTeam).length;
          deaths.push({
            t: e.timestamp,
            pos,
            zone: pos ? zoneOf(pos) : "unknown",
            side: pos ? sideOf(pos) : "unknown",
            alliesNearby,
            enemiesInvolved,
          });
        }
      } else if (e.type === "ELITE_MONSTER_KILL") {
        const mt = String(e.monsterType ?? "");
        const label = mt.includes("DRAGON")
          ? "dragon"
          : mt.includes("BARON")
            ? "baron"
            : mt.includes("HERALD")
              ? "herald"
              : mt.includes("ATAKHAN")
                ? "atakhan"
                : null;
        if (label) objectives.push({ t: e.timestamp, type: label, pos: (e.position as Pos) ?? null });
      }
    }
  }

  // In-lane vs roaming is decided by SIDE (robust), with jungle handled separately.
  const inLane = (d: { side: string; zone: string }) =>
    mySide === "jungle" ? d.zone.includes("jungle") : d.side === mySide;

  const deathsOut = deaths.map((d) => ({
    time: fmtT(d.t),
    zone: d.zone,
    alone: d.alliesNearby === 0,
    allies_nearby: d.alliesNearby,
    enemies_involved: d.enemiesInvolved,
    in_lane: inLane(d),
  }));

  // Deaths within 75s of a contested objective, but far (>5500u) from it.
  const deathsAway: Array<{ time: string; you_were: string; objective: string }> = [];
  for (const d of deaths) {
    if (!d.pos) continue;
    for (const o of objectives) {
      if (Math.abs(o.t - d.t) <= 75000 && o.pos && dist(d.pos, o.pos) > 5500) {
        deathsAway.push({
          time: fmtT(d.t),
          you_were: d.zone,
          objective: `${o.type}${o.pos ? " near " + zoneOf(o.pos) : ""}`,
        });
        break;
      }
    }
  }

  // Lane gold/cs/xp diff vs the direct opponent at ~10 and ~14 min.
  const statAt = (pid: number, idx: number) => {
    const pf = frames[idx]?.participantFrames?.[String(pid)];
    if (!pf) return null;
    return {
      gold: Number(pf.totalGold ?? 0),
      xp: Number(pf.xp ?? 0),
      cs: Number(pf.minionsKilled ?? 0) + Number(pf.jungleMinionsKilled ?? 0),
    };
  };
  const laneAt = (idx: number): LaneDiff => {
    if (!oppo) return null;
    const m = statAt(myPid, idx);
    const o = statAt(oppo.participantId, idx);
    if (!m || !o) return null;
    return { gold_diff: m.gold - o.gold, xp_diff: m.xp - o.xp, cs_diff: m.cs - o.cs, my_cs: m.cs };
  };

  const byZone: Record<string, number> = {};
  for (const d of deathsOut) byZone[d.zone] = (byZone[d.zone] ?? 0) + 1;

  return {
    available: true,
    deaths: deathsOut,
    death_summary: {
      total: deaths.length,
      alone: deathsOut.filter((d) => d.alone).length,
      in_own_lane: deathsOut.filter((d) => d.in_lane).length,
      roaming: deathsOut.filter((d) => !d.in_lane && d.zone !== "base").length,
      by_zone: byZone,
      first_death_min: deaths.length ? Number((deaths[0].t / 60000).toFixed(1)) : null,
    },
    laning: oppo ? { opponent: oppo.champion, at_10: laneAt(10), at_14: laneAt(14) } : null,
    deaths_away_from_objective: deathsAway,
    kp_pct_timeline: teamKills > 0 ? Math.round((myInvolved / teamKills) * 100) : null,
    teamfights_died_alone: deathsOut.filter((d) => d.alone).length,
  };
}
