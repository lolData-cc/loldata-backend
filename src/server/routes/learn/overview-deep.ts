// src/server/routes/learn/overview-deep.ts
//
// The "go deep" layer for the Learn overview: things competitors don't surface,
// derived from the Riot MATCH TIMELINE (per-minute frames + events) plus an
// LP trajectory anchored to the player's real current rank.
//
// Everything here is best-effort: a failed timeline fetch degrades one game,
// never the whole response. Timeline fetches are bounded by the caller.

import { getMatchTimeline, getRankedDataBySummonerId } from "../../riot";

// ── LP TRACK ────────────────────────────────────────────────────────────────
// We rarely have per-game LP (only scout-tracked accounts snapshot it), so we
// RECONSTRUCT the session/period curve: anchor at the player's real current LP
// (league-v4) and walk the win/loss sequence backwards with a typical ±LP step.
// The SHAPE (net gain/loss, streaks) is what the chart communicates.

const TIER_BASE: Record<string, number> = {
  IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200, PLATINUM: 1600,
  EMERALD: 2000, DIAMOND: 2400, MASTER: 2800, GRANDMASTER: 2800, CHALLENGER: 2800,
};
const DIV_OFFSET: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };

function cumulativeLp(tier: string, division: string | undefined, lp: number): number {
  const base = TIER_BASE[tier?.toUpperCase()] ?? 0;
  const apex = tier === "MASTER" || tier === "GRANDMASTER" || tier === "CHALLENGER";
  return base + (apex ? 0 : DIV_OFFSET[division ?? "IV"] ?? 0) + lp;
}

export type LpTrack = {
  current: { tier: string; division: string | null; lp: number; label: string } | null;
  netLp: number;
  points: { i: number; lp: number; win: boolean; champion: string }[];
  estimated: boolean;
};

/**
 * @param periodGamesChrono oldest→newest games of the selected period
 *        (each: { win, champion })
 */
export async function buildLpTrack(
  periodGamesChrono: { win: boolean; champion: string }[],
  puuid: string,
  region: string
): Promise<LpTrack> {
  // real current rank (solo queue) → anchor
  let current: LpTrack["current"] = null;
  let anchorCum: number | null = null;
  try {
    const entries = (await getRankedDataBySummonerId(puuid, region)) as any[];
    const solo = entries?.find((e) => e.queueType === "RANKED_SOLO_5x5") ?? entries?.[0];
    if (solo) {
      current = {
        tier: solo.tier,
        division: solo.rank ?? null,
        lp: solo.leaguePoints ?? 0,
        label: `${solo.tier} ${solo.rank ?? ""} · ${solo.leaguePoints ?? 0} LP`.replace(/\s+/g, " ").trim(),
      };
      anchorCum = cumulativeLp(solo.tier, solo.rank, solo.leaguePoints ?? 0);
    }
  } catch { /* no rank → estimated from 0 */ }

  const WIN_LP = 21, LOSS_LP = 18;
  const n = periodGamesChrono.length;

  // net delta of the period, and per-game cumulative anchored so the LAST point
  // equals the current LP (walk backwards from the anchor).
  const steps = periodGamesChrono.map((g) => (g.win ? WIN_LP : -LOSS_LP));
  const netLp = steps.reduce((a, b) => a + b, 0);

  const endCum = anchorCum ?? netLp; // if no anchor, curve just shows net movement
  const points: LpTrack["points"] = [];
  // reconstruct cumulative so points[n-1] = endCum
  let run = endCum;
  const cumRev: number[] = [];
  for (let i = n - 1; i >= 0; i--) { cumRev[i] = run; run -= steps[i]; }
  const startCum = run; // value before the first game
  for (let i = 0; i < n; i++) {
    points.push({ i: i + 1, lp: Math.round(cumRev[i]), win: periodGamesChrono[i].win, champion: periodGamesChrono[i].champion });
  }
  // prepend a "start" point so the line has an origin
  points.unshift({ i: 0, lp: Math.round(startCum), win: periodGamesChrono[0]?.win ?? true, champion: "" });

  return { current, netLp, points, estimated: true };
}

// ── TIMELINE ANALYSIS ────────────────────────────────────────────────────────

export type TimelineDeep = {
  matchId: string;
  goldDiff10: number | null;
  csDiff10: number | null;
  xpDiff10: number | null;
  cs10: number | null;
  cs14: number | null;
  goldDiff14: number | null;
  deathMinutes: number[];
  objectivesInvolved: number;
  teamObjectives: number;
  goldCurve: { min: number; diff: number }[]; // user gold − lane-opp gold per minute
  firstBloodMin: number | null;
  moments: { min: number; type: string; text: string }[];
};

const MONSTER_LABEL: Record<string, string> = {
  DRAGON: "Dragon", RIFTHERALD: "Herald", BARON_NASHOR: "Baron", HORDE: "Grubs", ATAKHAN: "Atakhan",
};

/** participantId (1-based) for a puuid, from the timeline metadata order. */
function pidFor(timeline: any, puuid: string): number | null {
  const arr: string[] = timeline?.metadata?.participants ?? [];
  const idx = arr.indexOf(puuid);
  return idx >= 0 ? idx + 1 : null;
}

export function analyzeTimeline(timeline: any, matchInfo: any, matchId: string, puuid: string): TimelineDeep | null {
  const frames = timeline?.info?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const myPid = pidFor(timeline, puuid);
  if (!myPid) return null;

  const me = matchInfo.participants.find((p: any) => p.puuid === puuid);
  const myTeam = me?.teamId;
  const myRole = me?.teamPosition || me?.individualPosition || "";
  // lane opponent = enemy with same role; participantId in timeline == match index+1
  const enemyTeam = myTeam === 100 ? 200 : 100;
  const oppIdx = matchInfo.participants.findIndex(
    (p: any) => p.teamId === enemyTeam && (p.teamPosition || p.individualPosition || "") === myRole
  );
  const oppPid = oppIdx >= 0 ? oppIdx + 1 : null;

  const frameAtMin = (min: number) => frames[Math.min(min, frames.length - 1)];
  const goldOf = (fr: any, pid: number) => fr?.participantFrames?.[String(pid)]?.totalGold ?? null;
  const xpOf = (fr: any, pid: number) => fr?.participantFrames?.[String(pid)]?.xp ?? null;
  const csOf = (fr: any, pid: number) => {
    const pf = fr?.participantFrames?.[String(pid)];
    return pf ? (pf.minionsKilled ?? 0) + (pf.jvMinionsKilled ?? pf.jungleMinionsKilled ?? 0) : null;
  };

  const diffAt = (min: number, fn: (fr: any, pid: number) => number | null): number | null => {
    if (!oppPid) return null;
    const fr = frameAtMin(min);
    const a = fn(fr, myPid), b = fn(fr, oppPid);
    return a == null || b == null ? null : a - b;
  };

  const goldCurve: { min: number; diff: number }[] = [];
  if (oppPid) {
    for (let m = 0; m < frames.length; m++) {
      const a = goldOf(frames[m], myPid), b = goldOf(frames[m], oppPid);
      if (a != null && b != null) goldCurve.push({ min: m, diff: a - b });
    }
  }

  // events: my deaths, first blood, objectives
  const deathMinutes: number[] = [];
  const moments: { min: number; type: string; text: string }[] = [];
  let firstBloodMin: number | null = null;
  let objectivesInvolved = 0, teamObjectives = 0;
  const champOf = (pid: number) => matchInfo.participants[pid - 1]?.championName ?? "?";

  for (const fr of frames) {
    for (const ev of fr.events ?? []) {
      const min = Math.round((ev.timestamp ?? 0) / 60000);
      if (ev.type === "CHAMPION_KILL") {
        if (ev.victimId === myPid) {
          deathMinutes.push(min);
          moments.push({ min, type: "death", text: `Died to ${champOf(ev.killerId)} at ${min}m` });
        } else if (ev.killerId === myPid) {
          moments.push({ min, type: "kill", text: `Solo/kill on ${champOf(ev.victimId)} at ${min}m` });
        }
        if (firstBloodMin == null && (ev.killerId === myPid || (ev.assistingParticipantIds ?? []).includes(myPid)) && ev.victimId) {
          // only if it's genuinely near the start (first ~5 min) treat as first-blood involvement
          if (min <= 5) firstBloodMin = min;
        }
      } else if (ev.type === "ELITE_MONSTER_KILL") {
        // team objective if killer on my team
        const killerTeam = ev.killerTeamId ?? (matchInfo.participants[(ev.killerId ?? 0) - 1]?.teamId);
        if (killerTeam === myTeam) {
          teamObjectives++;
          const involved = ev.killerId === myPid || (ev.assistingParticipantIds ?? []).includes(myPid);
          if (involved) objectivesInvolved++;
          const label = MONSTER_LABEL[ev.monsterType] ?? ev.monsterType ?? "Objective";
          if (involved && (ev.monsterType === "BARON_NASHOR" || ev.monsterType === "DRAGON"))
            moments.push({ min, type: "objective", text: `Helped take ${label} at ${min}m` });
        }
      }
    }
  }

  // pick the ~4 most meaningful moments (spread across time, prefer objectives/first blood)
  const keyMoments = [...moments].sort((a, b) => a.min - b.min);

  return {
    matchId,
    goldDiff10: diffAt(10, goldOf),
    csDiff10: diffAt(10, csOf),
    xpDiff10: diffAt(10, xpOf),
    cs10: csOf(frameAtMin(10), myPid),
    cs14: csOf(frameAtMin(14), myPid),
    goldDiff14: diffAt(14, goldOf),
    deathMinutes,
    objectivesInvolved,
    teamObjectives,
    goldCurve,
    firstBloodMin,
    moments: keyMoments,
  };
}

// ── SPOTLIGHT ("game of the period") ─────────────────────────────────────────

export type Spotlight = {
  matchId: string;
  champion: string;
  role: string;
  win: boolean;
  kills: number; deaths: number; assists: number;
  impact: number;
  verdict: string;
  tag: string;
  goldCurve: { min: number; diff: number }[];
  peak: { min: number; diff: number } | null;
  trough: { min: number; diff: number } | null;
  goldDiff10: number | null;
  cs10: number | null;
  moments: { min: number; type: string; text: string }[];
};

/** choose the most story-worthy game among those we have a timeline for. */
export function pickSpotlight(
  games: { matchId: string; info: any; me: any; impact: number; deep: TimelineDeep | null }[]
): Spotlight | null {
  const withTl = games.filter((g) => g.deep && g.deep.goldCurve.length > 3);
  if (withTl.length === 0) return null;

  // score each game by "story value": swing amplitude + impact extremity
  const scored = withTl.map((g) => {
    const curve = g.deep!.goldCurve;
    const peak = curve.reduce((mx, p) => (p.diff > mx.diff ? p : mx), curve[0]);
    const trough = curve.reduce((mn, p) => (p.diff < mn.diff ? p : mn), curve[0]);
    const swing = Math.abs(peak.diff - trough.diff);
    const story = swing + Math.abs(g.impact - 50) * 40;
    return { g, peak, trough, swing, story };
  }).sort((a, b) => b.story - a.story);

  const { g, peak, trough } = scored[0];
  const win = !!g.me.win;
  const curveArr = g.deep!.goldCurve;
  const finalDiff = curveArr.length ? curveArr[curveArr.length - 1].diff : 0;

  let verdict = "Solid game", tag = "GAME OF THE DAY";
  if (win && trough.diff < -2500 && finalDiff > 0) { verdict = "Comeback win — you clawed it back from behind"; tag = "COMEBACK"; }
  else if (win && peak.diff > 3500) { verdict = "You stomped — a dominant lead start to finish"; tag = "DOMINANT"; }
  else if (win && g.impact >= 70) { verdict = "Hard carry — your impact decided the game"; tag = "CARRY"; }
  else if (!win && peak.diff > 2500) { verdict = "Threw a lead — you were ahead before it slipped"; tag = "THROWN LEAD"; }
  else if (!win && trough.diff < -3500) { verdict = "Rough one — stomped early and couldn't recover"; tag = "STOMPED"; }
  else if (win) { verdict = "A win you earned"; tag = "WIN"; }
  else { verdict = "A loss to learn from"; tag = "LOSS"; }

  return {
    matchId: g.matchId,
    champion: g.me.championName ?? "?",
    role: g.me.teamPosition || g.me.individualPosition || "",
    win,
    kills: g.me.kills ?? 0, deaths: g.me.deaths ?? 0, assists: g.me.assists ?? 0,
    impact: g.impact,
    verdict, tag,
    goldCurve: g.deep!.goldCurve,
    peak, trough,
    goldDiff10: g.deep!.goldDiff10,
    cs10: g.deep!.cs10,
    moments: g.deep!.moments.slice(0, 6),
  };
}

// ── DEEP AGGREGATES over the sampled timelines ───────────────────────────────

export type DeepAggregates = {
  sampleGames: number;
  laning: { goldDiff10: number | null; csDiff10: number | null; xpDiff10: number | null; cs10: number | null } | null;
  deathClock: { bucket: string; deaths: number }[]; // per 5-min bucket
  objectiveParticipation: number | null; // %
};

const DEATH_BUCKETS = ["0-5", "5-10", "10-15", "15-20", "20-25", "25-30", "30+"];

export function aggregateDeep(deeps: (TimelineDeep | null)[]): DeepAggregates {
  const ok = deeps.filter((d): d is TimelineDeep => !!d);
  if (ok.length === 0) return { sampleGames: 0, laning: null, deathClock: DEATH_BUCKETS.map((b) => ({ bucket: b, deaths: 0 })), objectiveParticipation: null };

  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };

  const clock = DEATH_BUCKETS.map((b) => ({ bucket: b, deaths: 0 }));
  let involved = 0, total = 0;
  for (const d of ok) {
    for (const m of d.deathMinutes) {
      const idx = m >= 30 ? 6 : Math.floor(m / 5);
      clock[Math.min(6, idx)].deaths++;
    }
    involved += d.objectivesInvolved;
    total += d.teamObjectives;
  }

  return {
    sampleGames: ok.length,
    laning: {
      goldDiff10: avg(ok.map((d) => d.goldDiff10)),
      csDiff10: avg(ok.map((d) => d.csDiff10)),
      xpDiff10: avg(ok.map((d) => d.xpDiff10)),
      cs10: avg(ok.map((d) => d.cs10)),
    },
    deathClock: clock,
    objectiveParticipation: total > 0 ? Math.round((involved / total) * 100) : null,
  };
}

// analysed-timeline cache (30 min) — a completed match's timeline never changes,
// so repeat overview loads / the 60s frontend cache never re-hit Riot for it.
const tlCache = new Map<string, { deep: TimelineDeep | null; ts: number }>();
const TL_TTL = 30 * 60 * 1000;
const TL_MAX = 400;

/** fetch timelines for a bounded set of games, in parallel, tolerant of failures. */
export async function fetchTimelinesBounded(
  games: { matchId: string; info: any; me: any; impact: number }[],
  region: string,
  cap: number
): Promise<{ matchId: string; info: any; me: any; impact: number; deep: TimelineDeep | null }[]> {
  const slice = games.slice(0, cap);
  const results = await Promise.allSettled(
    slice.map(async (g) => {
      const key = `${g.matchId}:${g.me.puuid}`;
      const hit = tlCache.get(key);
      if (hit && Date.now() - hit.ts < TL_TTL) return hit.deep;
      const tl = await getMatchTimeline(g.matchId, region);
      const deep = analyzeTimeline(tl, g.info, g.matchId, g.me.puuid);
      if (tlCache.size >= TL_MAX) { const k = tlCache.keys().next().value; if (k) tlCache.delete(k); }
      tlCache.set(key, { deep, ts: Date.now() });
      return deep;
    })
  );
  return slice.map((g, i) => ({
    ...g,
    deep: results[i].status === "fulfilled" ? (results[i] as PromiseFulfilledResult<TimelineDeep | null>).value : null,
  }));
}
