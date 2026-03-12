import {
  getMatchIdsByPuuidOpts,
  getMatchDetails,
  getMatchTimeline,
  RateLimitError,
} from "../riot";
import { getMatchJunglePlaystyle } from "../junglePlaystyle";
import type {
  JungleTeamPlaystyleResult,
  JungleStartingCamp,
  JunglePlaystyleTag,
  JungleInvade,
} from "../junglePlaystyle";
import { getCurrentSeasonWindow } from "../season";

// ── Types ────────────────────────────────────────────────────────────

export type PlayerAnalysisResult = {
  meta: {
    puuid: string;
    region: string;
    matchesAnalyzed: number;
  };

  roleDistribution: {
    role: string;
    games: number;
    pct: number;
  }[];

  primaryRole: string;
  isJungler: boolean;

  championPool: {
    championName: string;
    games: number;
    wins: number;
    winrate: number;
    avgKills: number;
    avgDeaths: number;
    avgAssists: number;
    avgKda: number;
    avgCsPerMin: number;
  }[];

  overallStats: {
    games: number;
    wins: number;
    winrate: number;
    avgKills: number;
    avgDeaths: number;
    avgAssists: number;
    avgKda: number;
    avgCsPerMin: number;
    avgGoldPerMin: number;
    avgKillParticipation: number;
    avgDamageShare: number;
    avgVisionPerMin: number;
    avgSoloKills: number;
  };

  winLossComparison: {
    metric: string;
    onWin: number;
    onLoss: number;
    delta: number;
  }[];

  jungleAnalysis?: {
    gamesAsJungler: number;
    startingCamps: { camp: string; count: number; pct: number }[];
    preferredStart: string;
    preferredStartPct: number;
    playstyleTags: { tag: string; count: number; pct: number }[];
    invadeRate: number;
    avgTopsideCount: number;
    avgBotsideCount: number;
  };

  wardDistribution: {
    topside: number;
    botside: number;
    neutral: number;
    totalWards: number;
    topsidePct: number;
    botsidePct: number;
  };

  bootsDistribution: {
    boots: string;
    count: number;
    pct: number;
    wins: number;
    winRate: number;
  }[];

  earlyGameAnalysis: {
    gamesWithTimeline: number;
    aheadAtTen: { games: number; wins: number; winrate: number };
    behindAtTen: { games: number; wins: number; winrate: number };
    evenAtTen: { games: number; wins: number; winrate: number };
    avgKillDiffAtTen: number;
    avgGoldDiffAtTen: number;
    avgCsDiffAtTen: number;
    firstBloodRate: number;
    firstBloodWinrate: number;
  };

  weaknesses: {
    id: string;
    severity: "critical" | "major" | "minor";
    title: string;
    description: string;
  }[];

  counterTips: {
    category: string;
    tip: string;
    reasoning: string;
  }[];
};

// ── Helpers ──────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function findParticipant(match: any, puuid: string) {
  return (match.info?.participants || []).find(
    (p: any) => p.puuid === puuid
  );
}

function gameDurationMinutes(match: any): number {
  const dur = match.info?.gameDuration ?? 0;
  // Riot returns seconds since ~2022
  return dur > 0 ? dur / 60 : 1;
}

function safeKda(k: number, d: number, a: number): number {
  return d === 0 ? k + a : +((k + a) / d).toFixed(2);
}

function round2(n: number): number {
  return +n.toFixed(2);
}

function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return +((part / total) * 100).toFixed(1);
}

// ── Analysis Functions ───────────────────────────────────────────────

function computeRoleDistribution(
  matches: any[],
  puuid: string
): { role: string; games: number; pct: number }[] {
  const counts: Record<string, number> = {};
  for (const m of matches) {
    const p = findParticipant(m, puuid);
    if (!p) continue;
    const role = p.teamPosition || p.individualPosition || "UNKNOWN";
    counts[role] = (counts[role] || 0) + 1;
  }
  const total = matches.length;
  return Object.entries(counts)
    .map(([role, games]) => ({ role, games, pct: pct(games, total) }))
    .sort((a, b) => b.games - a.games);
}

function computeChampionPool(
  matches: any[],
  puuid: string
): PlayerAnalysisResult["championPool"] {
  const map: Record<
    string,
    {
      games: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
      cs: number;
      duration: number;
    }
  > = {};

  for (const m of matches) {
    const p = findParticipant(m, puuid);
    if (!p) continue;
    const champ = p.championName || "Unknown";
    if (!map[champ])
      map[champ] = {
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        cs: 0,
        duration: 0,
      };
    const e = map[champ];
    e.games++;
    if (p.win) e.wins++;
    e.kills += p.kills || 0;
    e.deaths += p.deaths || 0;
    e.assists += p.assists || 0;
    e.cs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
    e.duration += gameDurationMinutes(m);
  }

  return Object.entries(map)
    .map(([championName, s]) => ({
      championName,
      games: s.games,
      wins: s.wins,
      winrate: pct(s.wins, s.games),
      avgKills: round2(s.kills / s.games),
      avgDeaths: round2(s.deaths / s.games),
      avgAssists: round2(s.assists / s.games),
      avgKda: safeKda(
        s.kills / s.games,
        s.deaths / s.games,
        s.assists / s.games
      ),
      avgCsPerMin: round2(s.cs / s.duration),
    }))
    .sort((a, b) => b.games - a.games);
}

function computeOverallStats(
  matches: any[],
  puuid: string
): PlayerAnalysisResult["overallStats"] {
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let cs = 0;
  let gold = 0;
  let kp = 0;
  let kpCount = 0;
  let dmg = 0;
  let dmgCount = 0;
  let vision = 0;
  let visionCount = 0;
  let soloKills = 0;
  let totalDuration = 0;
  const games = matches.length;

  for (const m of matches) {
    const p = findParticipant(m, puuid);
    if (!p) continue;
    const dur = gameDurationMinutes(m);
    totalDuration += dur;

    if (p.win) wins++;
    kills += p.kills || 0;
    deaths += p.deaths || 0;
    assists += p.assists || 0;
    cs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
    gold += p.goldEarned || 0;
    soloKills += p.soloKills || 0;

    if (p.challenges?.killParticipation != null) {
      kp += p.challenges.killParticipation;
      kpCount++;
    }
    if (p.challenges?.teamDamagePercentage != null) {
      dmg += p.challenges.teamDamagePercentage;
      dmgCount++;
    }
    if (p.challenges?.visionScorePerMinute != null) {
      vision += p.challenges.visionScorePerMinute;
      visionCount++;
    }
  }

  return {
    games,
    wins,
    winrate: pct(wins, games),
    avgKills: round2(kills / games),
    avgDeaths: round2(deaths / games),
    avgAssists: round2(assists / games),
    avgKda: safeKda(kills / games, deaths / games, assists / games),
    avgCsPerMin: round2(cs / totalDuration),
    avgGoldPerMin: round2(gold / totalDuration),
    avgKillParticipation: kpCount > 0 ? round2((kp / kpCount) * 100) : 0,
    avgDamageShare: dmgCount > 0 ? round2((dmg / dmgCount) * 100) : 0,
    avgVisionPerMin: visionCount > 0 ? round2(vision / visionCount) : 0,
    avgSoloKills: round2(soloKills / games),
  };
}

function computeJungleAnalysis(
  matches: any[],
  timelines: any[],
  puuid: string
): PlayerAnalysisResult["jungleAnalysis"] | undefined {
  // Collect jungle results for games where this player was jungler
  const jungleResults: JungleTeamPlaystyleResult[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const timeline = timelines[i];
    if (!timeline) continue;

    const p = findParticipant(match, puuid);
    if (!p) continue;

    const role = p.teamPosition || p.individualPosition || "";
    if (role !== "JUNGLE") continue;

    const analysis = getMatchJunglePlaystyle(match, timeline);
    const teamResult = p.teamId === 100 ? analysis.blue : analysis.red;
    if (teamResult) {
      jungleResults.push(teamResult);
    }
  }

  if (jungleResults.length === 0) return undefined;

  const total = jungleResults.length;

  // Starting camp distribution
  const campCounts: Record<string, number> = {};
  for (const r of jungleResults) {
    if (r.startingCamp) {
      campCounts[r.startingCamp] = (campCounts[r.startingCamp] || 0) + 1;
    }
  }
  const startingCamps = Object.entries(campCounts)
    .map(([camp, count]) => ({ camp, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count);

  const preferredStart = startingCamps[0]?.camp ?? "unknown";
  const preferredStartPct = startingCamps[0]?.pct ?? 0;

  // Playstyle tag distribution
  const tagCounts: Record<string, number> = {};
  for (const r of jungleResults) {
    if (r.tag) {
      tagCounts[r.tag] = (tagCounts[r.tag] || 0) + 1;
    }
  }
  const playstyleTags = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count);

  // Invade rate
  const invadeCount = jungleResults.filter(
    (r) => r.invade === "invade"
  ).length;

  // Average topside/botside
  const avgTopsideCount = round2(
    jungleResults.reduce((s, r) => s + r.topsideCount, 0) / total
  );
  const avgBotsideCount = round2(
    jungleResults.reduce((s, r) => s + r.botsideCount, 0) / total
  );

  return {
    gamesAsJungler: total,
    startingCamps,
    preferredStart,
    preferredStartPct,
    playstyleTags,
    invadeRate: pct(invadeCount, total),
    avgTopsideCount,
    avgBotsideCount,
  };
}

function computeWinLossComparison(
  matches: any[],
  puuid: string
): PlayerAnalysisResult["winLossComparison"] {
  const winStats = { k: 0, d: 0, a: 0, cs: 0, gold: 0, kp: 0, kpN: 0, vision: 0, vN: 0, solo: 0, dur: 0, n: 0 };
  const lossStats = { ...winStats };

  for (const m of matches) {
    const p = findParticipant(m, puuid);
    if (!p) continue;
    const s = p.win ? winStats : lossStats;
    const dur = gameDurationMinutes(m);
    s.n++;
    s.dur += dur;
    s.k += p.kills || 0;
    s.d += p.deaths || 0;
    s.a += p.assists || 0;
    s.cs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
    s.gold += p.goldEarned || 0;
    s.solo += p.soloKills || 0;
    if (p.challenges?.killParticipation != null) {
      s.kp += p.challenges.killParticipation;
      s.kpN++;
    }
    if (p.challenges?.visionScorePerMinute != null) {
      s.vision += p.challenges.visionScorePerMinute;
      s.vN++;
    }
  }

  function avg(val: number, n: number) {
    return n > 0 ? round2(val / n) : 0;
  }

  const metrics: { metric: string; w: number; l: number }[] = [
    { metric: "KDA", w: safeKda(avg(winStats.k, winStats.n), avg(winStats.d, winStats.n), avg(winStats.a, winStats.n)), l: safeKda(avg(lossStats.k, lossStats.n), avg(lossStats.d, lossStats.n), avg(lossStats.a, lossStats.n)) },
    { metric: "CS/min", w: avg(winStats.cs, winStats.dur), l: avg(lossStats.cs, lossStats.dur) },
    { metric: "Gold/min", w: avg(winStats.gold, winStats.dur), l: avg(lossStats.gold, lossStats.dur) },
    { metric: "Kill Participation", w: winStats.kpN > 0 ? round2((winStats.kp / winStats.kpN) * 100) : 0, l: lossStats.kpN > 0 ? round2((lossStats.kp / lossStats.kpN) * 100) : 0 },
    { metric: "Vision/min", w: winStats.vN > 0 ? round2(winStats.vision / winStats.vN) : 0, l: lossStats.vN > 0 ? round2(lossStats.vision / lossStats.vN) : 0 },
    { metric: "Solo Kills", w: avg(winStats.solo, winStats.n), l: avg(lossStats.solo, lossStats.n) },
  ];

  return metrics.map((m) => ({
    metric: m.metric,
    onWin: m.w,
    onLoss: m.l,
    delta: round2(m.w - m.l),
  }));
}

// ── Boots item ID → name mapping ─────────────────────────────────────

const BOOTS_MAP: Record<number, string> = {
  3006: "Berserker's Greaves",
  3009: "Boots of Swiftness",
  3020: "Sorcerer's Shoes",
  3047: "Plated Steelcaps",
  3111: "Mercury's Treads",
  3117: "Mobility Boots",
  3158: "Ionian Boots",
};

const BOOTS_IDS = new Set(Object.keys(BOOTS_MAP).map(Number));

function computeBootsDistribution(
  matches: any[],
  puuid: string
): PlayerAnalysisResult["bootsDistribution"] {
  const counts: Record<string, number> = {};
  const wins: Record<string, number> = {};
  let totalWithBoots = 0;

  for (const m of matches) {
    const p = findParticipant(m, puuid);
    if (!p) continue;

    // Check item slots 0-6 for boots
    let foundBoots: string | null = null;
    for (let slot = 0; slot <= 6; slot++) {
      const itemId = p[`item${slot}`] as number;
      if (itemId && BOOTS_IDS.has(itemId)) {
        foundBoots = BOOTS_MAP[itemId] ?? `Boots #${itemId}`;
        break;
      }
    }

    if (foundBoots) {
      counts[foundBoots] = (counts[foundBoots] || 0) + 1;
      if (p.win) wins[foundBoots] = (wins[foundBoots] || 0) + 1;
      totalWithBoots++;
    } else {
      counts["No Boots"] = (counts["No Boots"] || 0) + 1;
      if (p.win) wins["No Boots"] = (wins["No Boots"] || 0) + 1;
    }
  }

  return Object.entries(counts)
    .map(([boots, count]) => ({
      boots,
      count,
      pct: pct(count, matches.length),
      wins: wins[boots] || 0,
      winRate: pct(wins[boots] || 0, count),
    }))
    .sort((a, b) => b.count - a.count);
}

// ── Ward placement distribution (topside vs botside) ─────────────────

function classifyWardSide(pos: { x: number; y: number }): "topside" | "botside" | "neutral" {
  const diff = pos.y - pos.x;
  if (diff > 2500) return "topside";
  if (diff < -2500) return "botside";
  return "neutral";
}

function computeWardDistribution(
  matches: any[],
  timelines: any[],
  puuid: string
): PlayerAnalysisResult["wardDistribution"] {
  let topside = 0;
  let botside = 0;
  let neutral = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const timeline = timelines[i];
    if (!timeline?.info?.frames) continue;

    const p = findParticipant(match, puuid);
    if (!p) continue;
    const participantId = p.participantId;

    for (const frame of timeline.info.frames) {
      for (const event of frame.events || []) {
        if (event.type !== "WARD_PLACED") continue;
        if (event.creatorId !== participantId) continue;
        if (!event.position) continue;

        const side = classifyWardSide(event.position);
        if (side === "topside") topside++;
        else if (side === "botside") botside++;
        else neutral++;
      }
    }
  }

  const totalWards = topside + botside + neutral;
  return {
    topside,
    botside,
    neutral,
    totalWards,
    topsidePct: pct(topside, totalWards),
    botsidePct: pct(botside, totalWards),
  };
}

// ── Early Game Analysis (kill/gold/cs diff at 10 min) ────────────────

function computeEarlyGameAnalysis(
  matches: any[],
  timelines: any[],
  puuid: string
): PlayerAnalysisResult["earlyGameAnalysis"] {
  let aheadWins = 0, aheadGames = 0;
  let behindWins = 0, behindGames = 0;
  let evenWins = 0, evenGames = 0;
  let totalKillDiff = 0, totalGoldDiff = 0, totalCsDiff = 0;
  let gamesWithTimeline = 0;
  let firstBloods = 0, firstBloodWins = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const timeline = timelines[i];
    if (!timeline?.info?.frames) continue;

    const p = findParticipant(match, puuid);
    if (!p) continue;
    const participantId: number = p.participantId;
    const teamId: number = p.teamId;
    const won: boolean = p.win;

    // Determine the lane opponent: same teamPosition on opposite team
    const role = p.teamPosition || p.individualPosition || "";
    let laneOpponentId: number | null = null;
    for (const other of match.info?.participants || []) {
      if (other.teamId === teamId) continue;
      const otherRole = other.teamPosition || other.individualPosition || "";
      if (otherRole === role && otherRole !== "") {
        laneOpponentId = other.participantId;
        break;
      }
    }

    // Find the frame closest to 10 minutes (600_000 ms)
    let tenMinFrame: any = null;
    for (const frame of timeline.info.frames) {
      if (frame.timestamp <= 600_000) {
        tenMinFrame = frame;
      } else {
        break;
      }
    }

    if (!tenMinFrame?.participantFrames) continue;

    const myFrame = tenMinFrame.participantFrames[String(participantId)];
    if (!myFrame) continue;

    gamesWithTimeline++;

    // Count kills before 10 min
    let myKills = 0;
    let opponentKills = 0;
    let gotFirstBlood = false;

    for (const frame of timeline.info.frames) {
      if (frame.timestamp > 600_000) break;
      for (const event of frame.events || []) {
        if (event.type !== "CHAMPION_KILL") continue;
        if (event.killerId === participantId) {
          myKills++;
        }
        if (laneOpponentId != null && event.killerId === laneOpponentId) {
          opponentKills++;
        }
        // First blood check
        if (event.killType === "KILL_FIRST_BLOOD" && event.killerId === participantId) {
          gotFirstBlood = true;
        }
      }
    }

    if (gotFirstBlood) {
      firstBloods++;
      if (won) firstBloodWins++;
    }

    // Gold + CS diff at 10 min vs lane opponent
    let goldDiff = 0;
    let csDiff = 0;
    if (laneOpponentId != null) {
      const oppFrame = tenMinFrame.participantFrames[String(laneOpponentId)];
      if (oppFrame) {
        goldDiff = (myFrame.totalGold || 0) - (oppFrame.totalGold || 0);
        csDiff = (myFrame.minionsKilled || 0) + (myFrame.jungleMinionsKilled || 0)
          - (oppFrame.minionsKilled || 0) - (oppFrame.jungleMinionsKilled || 0);
      }
    }

    const killDiff = myKills - opponentKills;
    totalKillDiff += killDiff;
    totalGoldDiff += goldDiff;
    totalCsDiff += csDiff;

    // Classify: ahead = more kills OR significantly more gold
    if (killDiff > 0 || (killDiff === 0 && goldDiff > 500)) {
      aheadGames++;
      if (won) aheadWins++;
    } else if (killDiff < 0 || (killDiff === 0 && goldDiff < -500)) {
      behindGames++;
      if (won) behindWins++;
    } else {
      evenGames++;
      if (won) evenWins++;
    }
  }

  return {
    gamesWithTimeline,
    aheadAtTen: { games: aheadGames, wins: aheadWins, winrate: pct(aheadWins, aheadGames) },
    behindAtTen: { games: behindGames, wins: behindWins, winrate: pct(behindWins, behindGames) },
    evenAtTen: { games: evenGames, wins: evenWins, winrate: pct(evenWins, evenGames) },
    avgKillDiffAtTen: gamesWithTimeline > 0 ? round2(totalKillDiff / gamesWithTimeline) : 0,
    avgGoldDiffAtTen: gamesWithTimeline > 0 ? Math.round(totalGoldDiff / gamesWithTimeline) : 0,
    avgCsDiffAtTen: gamesWithTimeline > 0 ? round2(totalCsDiff / gamesWithTimeline) : 0,
    firstBloodRate: pct(firstBloods, gamesWithTimeline),
    firstBloodWinrate: pct(firstBloodWins, firstBloods),
  };
}

function identifyWeaknesses(
  stats: PlayerAnalysisResult["overallStats"],
  primaryRole: string,
  jungleAnalysis?: PlayerAnalysisResult["jungleAnalysis"],
  championPool?: PlayerAnalysisResult["championPool"]
): PlayerAnalysisResult["weaknesses"] {
  const w: PlayerAnalysisResult["weaknesses"] = [];
  const isSupport = primaryRole === "UTILITY";

  // Deaths
  if (stats.avgDeaths >= 6) {
    w.push({ id: "dies_too_much", severity: "critical", title: "Extremely High Deaths", description: `Averages ${stats.avgDeaths} deaths per game — a major liability that can be exploited.` });
  } else if (stats.avgDeaths >= 5) {
    w.push({ id: "dies_often", severity: "major", title: "High Death Count", description: `Averages ${stats.avgDeaths} deaths per game, indicating overaggressive or poor positioning.` });
  }

  // Vision
  if (stats.avgVisionPerMin < 0.5 && stats.avgVisionPerMin > 0) {
    w.push({ id: "very_low_vision", severity: "critical", title: "Almost No Vision Control", description: `Only ${stats.avgVisionPerMin} vision/min — virtually blind on the map.` });
  } else if (stats.avgVisionPerMin < 0.8 && stats.avgVisionPerMin > 0) {
    w.push({ id: "low_vision", severity: "major", title: "Poor Vision Control", description: `${stats.avgVisionPerMin} vision/min is below average. Limited map awareness.` });
  }

  // CS (not support)
  if (!isSupport) {
    if (stats.avgCsPerMin < 4.5) {
      w.push({ id: "very_low_cs", severity: "critical", title: "Very Low CS Efficiency", description: `Only ${stats.avgCsPerMin} CS/min — missing significant gold income.` });
    } else if (stats.avgCsPerMin < 5.5) {
      w.push({ id: "low_cs", severity: "major", title: "Below Average CS", description: `${stats.avgCsPerMin} CS/min — falls behind in gold through poor farming.` });
    }
  }

  // Kill Participation
  if (stats.avgKillParticipation < 45 && stats.avgKillParticipation > 0) {
    w.push({ id: "low_kp", severity: "major", title: "Low Kill Participation", description: `Only ${stats.avgKillParticipation}% KP — often absent from team fights.` });
  }

  // Winrate
  if (stats.winrate < 45) {
    w.push({ id: "low_winrate", severity: "critical", title: "Losing More Than Winning", description: `${stats.winrate}% winrate across ${stats.games} games — currently in a downward trend.` });
  }

  // Champion pool
  if (championPool && championPool.length > 0) {
    const topChamp = championPool[0];
    const topPct = pct(topChamp.games, stats.games);
    if (topPct >= 70) {
      w.push({ id: "one_trick", severity: "major", title: "One-Trick Player", description: `Plays ${topChamp.championName} in ${topPct}% of games (${topChamp.games}/${stats.games}). Very predictable.` });
    }
    const uniqueChamps = championPool.length;
    if (uniqueChamps < 3 && stats.games >= 10) {
      w.push({ id: "small_pool", severity: "minor", title: "Tiny Champion Pool", description: `Only ${uniqueChamps} unique champions in ${stats.games} games. Limited flexibility.` });
    }
  }

  // Jungle-specific
  if (jungleAnalysis) {
    if (jungleAnalysis.preferredStartPct >= 80) {
      w.push({ id: "predictable_start", severity: "major", title: "Predictable Starting Camp", description: `Starts ${jungleAnalysis.preferredStart.toUpperCase()} in ${jungleAnalysis.preferredStartPct}% of jungle games. Easily exploitable.` });
    }
    const { avgTopsideCount, avgBotsideCount } = jungleAnalysis;
    if (avgBotsideCount > 0 && avgTopsideCount / avgBotsideCount > 2.5) {
      w.push({ id: "topside_heavy", severity: "major", title: "Heavy Topside Tendency", description: `Plays topside ${round2(avgTopsideCount / (avgTopsideCount + avgBotsideCount) * 100)}% of the time. Bot lane gets almost no jungle attention.` });
    } else if (avgTopsideCount > 0 && avgBotsideCount / avgTopsideCount > 2.5) {
      w.push({ id: "botside_heavy", severity: "major", title: "Heavy Botside Tendency", description: `Plays botside ${round2(avgBotsideCount / (avgTopsideCount + avgBotsideCount) * 100)}% of the time. Top lane gets almost no jungle attention.` });
    }
  }

  return w;
}

function generateCounterTips(
  weaknesses: PlayerAnalysisResult["weaknesses"],
  stats: PlayerAnalysisResult["overallStats"],
  jungleAnalysis?: PlayerAnalysisResult["jungleAnalysis"],
  championPool?: PlayerAnalysisResult["championPool"]
): PlayerAnalysisResult["counterTips"] {
  const tips: PlayerAnalysisResult["counterTips"] = [];

  for (const w of weaknesses) {
    switch (w.id) {
      case "dies_too_much":
      case "dies_often":
        tips.push({
          category: "early_game",
          tip: `Punish their overaggression — this player averages ${stats.avgDeaths} deaths/game.`,
          reasoning: "Play for picks and all-ins. They frequently put themselves in killable positions. Coordinate with your jungler for ganks.",
        });
        break;

      case "very_low_vision":
      case "low_vision":
        tips.push({
          category: "vision",
          tip: `Exploit their lack of vision (${stats.avgVisionPerMin} wards/min).`,
          reasoning: "They rarely ward. Roam aggressively, set up flanks, and control fog of war. They won't see you coming.",
        });
        break;

      case "very_low_cs":
      case "low_cs":
        tips.push({
          category: "early_game",
          tip: `Out-farm them — they only average ${stats.avgCsPerMin} CS/min.`,
          reasoning: "Focus on clean laning and wave manipulation. Even with equal kills, you'll have a significant gold advantage from CS alone.",
        });
        break;

      case "low_kp":
        tips.push({
          category: "mid_game",
          tip: "Force team fights and skirmishes while they're isolated.",
          reasoning: `With only ${stats.avgKillParticipation}% kill participation, this player often farms side lanes during fights. Use their absence to win 5v4 team fights.`,
        });
        break;

      case "low_winrate":
        tips.push({
          category: "mental",
          tip: "Apply early pressure — they're likely tilted from losing.",
          reasoning: `At ${stats.winrate}% winrate, they're on a losing trend. Early aggression can tilt them further and force mistakes.`,
        });
        break;

      case "one_trick":
        if (championPool && championPool.length > 0) {
          const main = championPool[0];
          tips.push({
            category: "champion_pool",
            tip: `This player is a ${main.championName} one-trick (${main.games} games, ${main.winrate}% WR). Expect very refined mechanics on this champion.`,
            reasoning: `Being a one-trick means their champion mastery is high, but they may struggle if the matchup is unfavorable. Pick a strong counter.`,
          });
        }
        break;

      case "small_pool":
        tips.push({
          category: "champion_pool",
          tip: "This player has a very small champion pool — they may be uncomfortable on off-picks.",
          reasoning: "With very few champions played, matchup-specific counters are more effective since they can't flex to different champions.",
        });
        break;

      case "predictable_start":
        if (jungleAnalysis) {
          const camp = jungleAnalysis.preferredStart.toUpperCase();
          tips.push({
            category: "jungle",
            tip: `Ward their ${camp} at 0:55 — they start there ${jungleAnalysis.preferredStartPct}% of the time.`,
            reasoning: `Knowing their start lets you counter-jungle the opposite side, set up an invade, or track their pathing for early ganks.`,
          });
        }
        break;

      case "topside_heavy":
        tips.push({
          category: "jungle",
          tip: "Bot lane should play aggressively — this jungler almost never ganks bot.",
          reasoning: `This jungler focuses topside. Your bot lane can push and take tower plates safely, or your own jungler can focus bot for free ganks.`,
        });
        break;

      case "botside_heavy":
        tips.push({
          category: "jungle",
          tip: "Top lane can play forward — this jungler rarely visits top side.",
          reasoning: `This jungler plays botside most of the time. Top lane is essentially a 1v1 with minimal jungle interference.`,
        });
        break;
    }
  }

  // Always add a general tip if we have jungle analysis
  if (jungleAnalysis && jungleAnalysis.invadeRate > 25) {
    tips.push({
      category: "jungle",
      tip: `Watch for level 1 invades — this player invades in ${jungleAnalysis.invadeRate}% of jungle games.`,
      reasoning: "Place defensive wards at your buff camps and group with your team early. Being prepared for the invade can turn it into a free kill.",
    });
  }

  // No weaknesses? Add a general tip
  if (tips.length === 0) {
    tips.push({
      category: "mid_game",
      tip: "This player has no major exploitable weaknesses. Focus on your own gameplay and team coordination.",
      reasoning: "Strong players are best beaten through superior macro, objective control, and team fight execution.",
    });
  }

  return tips;
}

// ── SSE Handler ──────────────────────────────────────────────────────

export async function analyzePlayerHandler(
  req: Request
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { puuid, region } = body;
  if (!puuid || !region) {
    return new Response("Missing puuid or region", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: object) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // stream already closed
        }
      }

      try {
        // ── Step 1: Fetch match IDs ──────────────────────────
        send({
          type: "progress",
          step: "FETCH_MATCH_IDS",
          message: "Querying Riot match database...",
        });

        const { startTime, endTime } = getCurrentSeasonWindow();
        let matchIds: string[];
        try {
          matchIds = await getMatchIdsByPuuidOpts(puuid, region, {
            count: 20,
            type: "ranked",
            startTime,
            endTime,
          });
        } catch (err) {
          send({
            type: "error",
            message: "Failed to fetch match history from Riot API.",
          });
          controller.close();
          return;
        }

        if (matchIds.length === 0) {
          send({
            type: "error",
            message: "No ranked games found this season.",
          });
          controller.close();
          return;
        }

        send({
          type: "progress",
          step: "MATCH_IDS_FOUND",
          message: `>> Located ${matchIds.length} ranked games. Initiating deep scan...`,
          total: matchIds.length,
        });

        // ── Step 2: Fetch match details + timelines ──────────
        const matches: any[] = [];
        const timelines: any[] = [];

        for (let i = 0; i < matchIds.length; i++) {
          send({
            type: "progress",
            step: "FETCH_MATCH",
            message: `Downloading match data [${String(i + 1).padStart(2, "0")}/${matchIds.length}]...`,
            current: i + 1,
            total: matchIds.length,
          });

          try {
            const match = await getMatchDetails(matchIds[i], region);
            await delay(80);

            let timeline: any = null;
            try {
              timeline = await getMatchTimeline(matchIds[i], region);
            } catch {
              // timeline fetch can fail - we still have match data
            }
            await delay(80);

            matches.push(match);
            timelines.push(timeline);
          } catch (err) {
            if (err instanceof RateLimitError) {
              const waitSec = Math.ceil(
                (err.retryAfterMs || 10000) / 1000
              );
              send({
                type: "progress",
                step: "RATE_LIMITED",
                message: `Rate limited by Riot API. Waiting ${waitSec}s...`,
              });
              await delay(err.retryAfterMs || 10000);

              // Retry once
              try {
                const match = await getMatchDetails(matchIds[i], region);
                await delay(80);
                let timeline: any = null;
                try {
                  timeline = await getMatchTimeline(matchIds[i], region);
                } catch {}
                await delay(80);
                matches.push(match);
                timelines.push(timeline);
              } catch {
                // Skip this match
                console.error(
                  `Skipping match ${matchIds[i]} after rate limit retry`
                );
              }
            } else {
              console.error(
                `Failed to fetch match ${matchIds[i]}:`,
                err
              );
            }
          }
        }

        if (matches.length === 0) {
          send({
            type: "error",
            message: "Failed to download any match data.",
          });
          controller.close();
          return;
        }

        send({
          type: "progress",
          step: "FETCH_COMPLETE",
          message: `>> Match data acquired. ${matches.length} games loaded. Analyzing...`,
        });

        // ── Step 3: Run analysis ─────────────────────────────
        send({
          type: "progress",
          step: "ANALYZE_ROLES",
          message: "Scanning role assignments...",
        });
        const roleDistribution = computeRoleDistribution(matches, puuid);
        const primaryRole = roleDistribution[0]?.role ?? "UNKNOWN";
        const isJungler =
          primaryRole === "JUNGLE" &&
          (roleDistribution[0]?.pct ?? 0) >= 30;

        send({
          type: "progress",
          step: "ANALYZE_CHAMPIONS",
          message: "Mapping champion pool and comfort picks...",
        });
        const championPool = computeChampionPool(matches, puuid);

        send({
          type: "progress",
          step: "ANALYZE_STATS",
          message: "Computing performance vectors...",
        });
        const overallStats = computeOverallStats(matches, puuid);

        send({
          type: "progress",
          step: "ANALYZE_JUNGLE",
          message: "Decoding jungle pathing sequences...",
        });
        const jungleAnalysis = computeJungleAnalysis(
          matches,
          timelines,
          puuid
        );

        send({
          type: "progress",
          step: "ANALYZE_WINLOSS",
          message: "Cross-referencing win/loss performance deltas...",
        });
        const winLossComparison = computeWinLossComparison(matches, puuid);

        send({
          type: "progress",
          step: "ANALYZE_EARLY_GAME",
          message: "Evaluating early game kill/gold leads...",
        });
        const earlyGameAnalysis = computeEarlyGameAnalysis(
          matches,
          timelines,
          puuid
        );

        send({
          type: "progress",
          step: "ANALYZE_WARDS",
          message: "Mapping ward placement heatmap...",
        });
        const wardDistribution = computeWardDistribution(
          matches,
          timelines,
          puuid
        );

        send({
          type: "progress",
          step: "ANALYZE_BOOTS",
          message: "Scanning boots purchase patterns...",
        });
        const bootsDistribution = computeBootsDistribution(matches, puuid);

        send({
          type: "progress",
          step: "IDENTIFY_WEAKNESSES",
          message: "Running vulnerability scanner...",
        });
        const weaknesses = identifyWeaknesses(
          overallStats,
          primaryRole,
          jungleAnalysis,
          championPool
        );

        send({
          type: "progress",
          step: "GENERATE_TIPS",
          message: "Compiling counter-strategy playbook...",
        });
        const counterTips = generateCounterTips(
          weaknesses,
          overallStats,
          jungleAnalysis,
          championPool
        );

        // ── Step 4: Send result ──────────────────────────────
        const result: PlayerAnalysisResult = {
          meta: {
            puuid,
            region,
            matchesAnalyzed: matches.length,
          },
          roleDistribution,
          primaryRole,
          isJungler,
          championPool,
          overallStats,
          winLossComparison,
          jungleAnalysis,
          wardDistribution,
          bootsDistribution,
          earlyGameAnalysis,
          weaknesses,
          counterTips,
        };

        send({
          type: "progress",
          step: "COMPLETE",
          message: ">> Analysis complete. Rendering results...",
        });

        // Small delay so the user sees the "complete" message
        await delay(300);

        send({ type: "result", data: result });
      } catch (err) {
        console.error("analyzePlayer fatal error:", err);
        send({
          type: "error",
          message: "Analysis failed. Please try again.",
        });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
