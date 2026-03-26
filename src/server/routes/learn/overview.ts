// /api/learn/overview — Daily performance report for authenticated user
import { getMatchDetails, getMatchIdsByPuuidOpts, RateLimitError } from "../../riot";
import { getCurrentSeasonWindow } from "../../season";

// ── In-memory cache (shared with getMatches) ──
const matchCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE = 500;

function getCached(id: string) {
  const e = matchCache.get(id);
  if (!e || Date.now() - e.ts > CACHE_TTL) { if (e) matchCache.delete(id); return null; }
  return e.data;
}
function setCache(id: string, d: any) {
  if (matchCache.size >= MAX_CACHE) { const k = matchCache.keys().next().value; if (k) matchCache.delete(k); }
  matchCache.set(id, { data: d, ts: Date.now() });
}

async function fetchMatch(matchId: string, region: string, retries = 2) {
  const cached = getCached(matchId);
  if (cached) return cached;
  for (let i = 0; i <= retries; i++) {
    try {
      const m = await getMatchDetails(matchId, region);
      const st = m.info.gameStartTimestamp ?? m.info.gameCreation;
      if (st && m.info.gameDuration) m.info.gameEndTimestamp = st + m.info.gameDuration * 1000;
      setCache(matchId, m);
      return m;
    } catch (err) {
      if (err instanceof RateLimitError && i < retries) {
        await new Promise(r => setTimeout(r, err.retryAfterMs ?? 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ── Helpers ──

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function matchDayKey(info: any) {
  const ts = info.gameEndTimestamp ?? info.gameStartTimestamp ?? info.gameCreation;
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * IMPACT score (0-100): measures individual performance independent of win/loss.
 * A high IMPACT means you played well. A low IMPACT means you underperformed.
 * Compares you to your teammates and the game context.
 */
function computeImpact(me: any, info: any): number {
  const myTeamId = me.teamId;
  const teammates = info.participants.filter((p: any) => p.teamId === myTeamId);
  const enemies = info.participants.filter((p: any) => p.teamId !== myTeamId);

  const k = me.kills ?? 0, d = me.deaths ?? 0, a = me.assists ?? 0;
  const myKDA = d === 0 ? (k + a) * 1.5 : (k + a) / d;

  // Team context
  const teamKills = teammates.reduce((s: number, p: any) => s + (p.kills ?? 0), 0);
  const teamDeaths = teammates.reduce((s: number, p: any) => s + (p.deaths ?? 0), 0);
  const teamDmg = teammates.reduce((s: number, p: any) => s + (p.totalDamageDealtToChampions ?? 0), 0);
  const teamGold = teammates.reduce((s: number, p: any) => s + (p.goldEarned ?? 0), 0);
  const teamVision = teammates.reduce((s: number, p: any) => s + (p.visionScore ?? 0), 0);

  const myDmg = me.totalDamageDealtToChampions ?? 0;
  const myGold = me.goldEarned ?? 0;
  const myVision = me.visionScore ?? 0;

  // Kill participation (0-100 scale, 20 points max)
  const kp = teamKills > 0 ? (k + a) / teamKills : 0;
  const kpScore = Math.min(20, kp * 25); // 80% KP = 20 points

  // Damage share relative to team (20 points max)
  const dmgShare = teamDmg > 0 ? myDmg / teamDmg : 0.2;
  const dmgScore = Math.min(20, dmgShare * 80); // 25% share = 20 points (5 players → 20% is average)

  // KDA score (25 points max)
  const kdaScore = Math.min(25, myKDA * 5); // 5.0 KDA = 25 points

  // Death discipline — fewer deaths relative to team = better (15 points max)
  const deathShare = teamDeaths > 0 ? (d / teamDeaths) : 0.2;
  const deathScore = Math.max(0, 15 - deathShare * 50); // <10% of team deaths = 10+ points

  // Vision contribution (10 points max)
  const visionShare = teamVision > 0 ? myVision / teamVision : 0.2;
  const visionScore = Math.min(10, visionShare * 40); // 25% = 10 points

  // Gold efficiency (10 points max)
  const goldShare = teamGold > 0 ? myGold / teamGold : 0.2;
  const goldScore = Math.min(10, goldShare * 40);

  // Bonus: solo kills, first blood, multi kills
  const soloBonus = Math.min(5, (me.challenges?.soloKills ?? 0) * 2);
  const fbBonus = me.firstBloodKill ? 2 : 0;
  const multiBonus = Math.min(3, (me.doubleKills ?? 0) + (me.tripleKills ?? 0) * 2);

  const raw = kpScore + dmgScore + kdaScore + deathScore + visionScore + goldScore + soloBonus + fbBonus + multiBonus;

  // Clamp to 0-100
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function computeStats(matches: any[], puuid: string) {
  let wins = 0, losses = 0, streak = 0, maxStreak = 0;
  let totalK = 0, totalD = 0, totalA = 0;
  let totalCS = 0, totalDmg = 0, totalVision = 0, totalGold = 0;
  let totalDurationMin = 0, totalTeamKills = 0, totalTeamDmg = 0;
  let totalDmgTaken = 0, totalHeal = 0, totalCCTime = 0;
  let totalWardsPlaced = 0, totalWardsKilled = 0, totalTurretDmg = 0;
  let totalFirstBloods = 0, totalDoubleKills = 0, totalTripleKills = 0;
  let totalSoloKills = 0;

  // Win/loss split accumulators
  const winSplit = { k: 0, d: 0, a: 0, cs: 0, dmg: 0, vis: 0, gold: 0, dur: 0, n: 0 };
  const lossSplit = { k: 0, d: 0, a: 0, cs: 0, dmg: 0, vis: 0, gold: 0, dur: 0, n: 0 };

  const perGame: any[] = [];
  const champStats: Record<string, { games: number; wins: number; kills: number; deaths: number; assists: number; dmg: number; cs: number; dur: number }> = {};
  const roleCounts: Record<string, number> = {};
  const matchupResults: { enemy: string; win: boolean; kda: number; champion: string }[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const info = m.info;
    const me = info.participants.find((p: any) => p.puuid === puuid);
    if (!me) continue;

    const win = !!me.win;
    if (win) { wins++; streak++; maxStreak = Math.max(maxStreak, streak); }
    else { losses++; streak = 0; }

    const k = me.kills ?? 0, d = me.deaths ?? 0, a = me.assists ?? 0;
    totalK += k; totalD += d; totalA += a;

    const cs = (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
    const dmg = me.totalDamageDealtToChampions ?? 0;
    const vis = me.visionScore ?? 0;
    const gold = me.goldEarned ?? 0;
    const durationMin = (info.gameDuration ?? 0) / 60;
    totalCS += cs; totalDmg += dmg; totalVision += vis; totalGold += gold;
    totalDurationMin += durationMin;

    // Extra stats
    totalDmgTaken += me.totalDamageTaken ?? 0;
    totalHeal += me.totalHeal ?? 0;
    totalCCTime += me.timeCCingOthers ?? 0;
    totalWardsPlaced += me.wardsPlaced ?? 0;
    totalWardsKilled += me.wardsKilled ?? 0;
    totalTurretDmg += me.damageDealtToTurrets ?? 0;
    if (me.firstBloodKill) totalFirstBloods++;
    totalDoubleKills += me.doubleKills ?? 0;
    totalTripleKills += me.tripleKills ?? 0;
    totalSoloKills += me.challenges?.soloKills ?? 0;

    // Win/loss splits
    const split = win ? winSplit : lossSplit;
    split.k += k; split.d += d; split.a += a;
    split.cs += cs; split.dmg += dmg; split.vis += vis;
    split.gold += gold; split.dur += durationMin; split.n++;

    // Team totals
    const myTeamId = me.teamId;
    const teamKills = info.participants
      .filter((p: any) => p.teamId === myTeamId)
      .reduce((s: number, p: any) => s + (p.kills ?? 0), 0);
    const teamDmg = info.participants
      .filter((p: any) => p.teamId === myTeamId)
      .reduce((s: number, p: any) => s + (p.totalDamageDealtToChampions ?? 0), 0);
    totalTeamKills += teamKills;
    totalTeamDmg += teamDmg;

    const kda = d === 0 ? (k + a) : (k + a) / d;
    const role = me.teamPosition || me.individualPosition || "UNKNOWN";
    const champ = me.championName ?? "Unknown";

    // Lane opponent (matchup tracking)
    const enemyTeamId = myTeamId === 100 ? 200 : 100;
    const laneOpp = info.participants.find(
      (p: any) => p.teamId === enemyTeamId && (p.teamPosition || p.individualPosition || "") === role
    );
    if (laneOpp) {
      matchupResults.push({ enemy: laneOpp.championName ?? "Unknown", win, kda: +kda.toFixed(2), champion: champ });
    }

    const impact = computeImpact(me, info);

    perGame.push({
      game: i + 1, kda: +kda.toFixed(2), win, champion: champ, role, impact,
      kills: k, deaths: d, assists: a,
      cspm: durationMin > 0 ? +(cs / durationMin).toFixed(1) : 0,
      dmgShare: teamDmg > 0 ? +((dmg / teamDmg) * 100).toFixed(1) : 0,
      visionScore: vis, damage: dmg, goldEarned: gold,
      gpm: durationMin > 0 ? +(gold / durationMin).toFixed(0) : 0,
      kp: teamKills > 0 ? +((k + a) / teamKills * 100).toFixed(0) : 0,
      durationMin: +durationMin.toFixed(1),
      wardsPlaced: me.wardsPlaced ?? 0,
      turretDmg: me.damageDealtToTurrets ?? 0,
    });

    // Champion aggregation
    if (!champStats[champ]) champStats[champ] = { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, dmg: 0, cs: 0, dur: 0 };
    champStats[champ].games++;
    if (win) champStats[champ].wins++;
    champStats[champ].kills += k;
    champStats[champ].deaths += d;
    champStats[champ].assists += a;
    champStats[champ].dmg += dmg;
    champStats[champ].cs += cs;
    champStats[champ].dur += durationMin;

    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }

  const n = perGame.length || 1;
  const kdaRatio = totalD === 0 ? totalK + totalA : (totalK + totalA) / totalD;

  // Champion rankings
  const champEntries = Object.entries(champStats);
  champEntries.sort((a, b) => {
    const wrA = a[1].wins / a[1].games; const wrB = b[1].wins / b[1].games;
    return wrB !== wrA ? wrB - wrA : b[1].games - a[1].games;
  });
  const best = champEntries[0];
  const worst = champEntries.length > 1 ? champEntries[champEntries.length - 1] : null;

  // All champions played
  const allChampions = champEntries.map(([name, s]) => ({
    name, games: s.games, wins: s.wins,
    winrate: +(s.wins / s.games * 100).toFixed(0),
    avgKDA: s.deaths === 0 ? "Perfect" : +((s.kills + s.assists) / s.deaths).toFixed(2),
    avgDmg: +((s.dmg / s.games)).toFixed(0),
    avgCSPM: s.dur > 0 ? +(s.cs / s.dur).toFixed(1) : 0,
  }));

  // Matchup summary — worst matchups (lost against)
  const matchupMap: Record<string, { games: number; wins: number }> = {};
  for (const mu of matchupResults) {
    if (!matchupMap[mu.enemy]) matchupMap[mu.enemy] = { games: 0, wins: 0 };
    matchupMap[mu.enemy].games++;
    if (mu.win) matchupMap[mu.enemy].wins++;
  }
  const matchups = Object.entries(matchupMap)
    .map(([enemy, s]) => ({ enemy, games: s.games, wins: s.wins, winrate: +(s.wins / s.games * 100).toFixed(0) }))
    .sort((a, b) => a.winrate - b.winrate);

  // Win/loss split stats
  const computeSplit = (s: typeof winSplit) => {
    if (s.n === 0) return null;
    return {
      games: s.n,
      avgKDA: s.d === 0 ? "Perfect" : +((s.k + s.a) / s.d).toFixed(2),
      avgKills: +(s.k / s.n).toFixed(1),
      avgDeaths: +(s.d / s.n).toFixed(1),
      avgAssists: +(s.a / s.n).toFixed(1),
      avgCSPM: s.dur > 0 ? +(s.cs / s.dur).toFixed(1) : 0,
      avgDmg: +(s.dmg / s.n).toFixed(0),
      avgVision: +(s.vis / s.n).toFixed(1),
      avgGPM: s.dur > 0 ? +(s.gold / s.dur).toFixed(0) : 0,
    };
  };

  // Average IMPACT score
  const avgImpact = perGame.length > 0 ? Math.round(perGame.reduce((s, g) => s + g.impact, 0) / perGame.length) : 0;

  return {
    totalGames: perGame.length, wins, losses,
    winrate: perGame.length > 0 ? +(wins / perGame.length * 100).toFixed(1) : 0,
    winStreak: maxStreak,
    impact: avgImpact,
    aggregateKDA: { kills: totalK, deaths: totalD, assists: totalA, ratio: +kdaRatio.toFixed(2) },
    perGameKDA: perGame,
    csPerMinTrend: perGame.map(g => ({ game: g.game, cspm: g.cspm })),
    damageShareTrend: perGame.map(g => ({ game: g.game, dmgShare: g.dmgShare })),
    visionScoreTrend: perGame.map(g => ({ game: g.game, vs: g.visionScore })),
    goldPerMinTrend: perGame.map(g => ({ game: g.game, gpm: +g.gpm })),
    damageTrend: perGame.map(g => ({ game: g.game, dmg: g.damage })),
    bestChampion: best ? {
      name: best[0], games: best[1].games, wins: best[1].wins,
      avgKDA: best[1].deaths === 0 ? "Perfect" : +((best[1].kills + best[1].assists) / best[1].deaths).toFixed(2),
    } : null,
    worstChampion: worst ? {
      name: worst[0], games: worst[1].games, wins: worst[1].wins,
      avgKDA: worst[1].deaths === 0 ? "Perfect" : +((worst[1].kills + worst[1].assists) / worst[1].deaths).toFixed(2),
    } : null,
    allChampions,
    roleDistribution: Object.entries(roleCounts).map(([role, games]) => ({ role, games })),
    killParticipation: totalTeamKills > 0 ? +((totalK + totalA) / totalTeamKills * 100).toFixed(1) : 0,
    avgDamageShare: totalTeamDmg > 0 ? +((totalDmg / totalTeamDmg) * 100).toFixed(1) : 0,
    // Extra aggregates
    avgDmgPerGame: +(totalDmg / n).toFixed(0),
    avgDmgTakenPerGame: +(totalDmgTaken / n).toFixed(0),
    avgGoldPerGame: +(totalGold / n).toFixed(0),
    avgWardsPlaced: +(totalWardsPlaced / n).toFixed(1),
    avgWardsKilled: +(totalWardsKilled / n).toFixed(1),
    avgTurretDmg: +(totalTurretDmg / n).toFixed(0),
    avgCCTime: +(totalCCTime / n).toFixed(1),
    firstBloods: totalFirstBloods,
    doubleKills: totalDoubleKills,
    tripleKills: totalTripleKills,
    soloKills: totalSoloKills,
    avgGameDuration: +(totalDurationMin / n).toFixed(1),
    // Matchups
    worstMatchups: matchups.slice(0, 3),
    bestMatchups: [...matchups].reverse().slice(0, 3),
    // Win/loss splits
    winSplitStats: computeSplit(winSplit),
    lossSplitStats: computeSplit(lossSplit),
    // Averages for baseline
    avgKDA: +kdaRatio.toFixed(2),
    avgCSPM: totalDurationMin > 0 ? +(totalCS / totalDurationMin).toFixed(1) : 0,
    avgVision: +(totalVision / n).toFixed(1),
    avgGoldPerMin: totalDurationMin > 0 ? +(totalGold / totalDurationMin).toFixed(0) : 0,
    avgDmgShare: totalTeamDmg > 0 ? +((totalDmg / totalTeamDmg) * 100).toFixed(1) : 0,
    avgKP: totalTeamKills > 0 ? +((totalK + totalA) / totalTeamKills * 100).toFixed(1) : 0,
  };
}

function computeStrengthsWeaknesses(today: any, baseline: any) {
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (!baseline || !today || today.totalGames === 0) return { strengths, weaknesses };

  // KDA comparison
  if (today.avgKDA > baseline.avgKDA * 1.15) strengths.push(`Strong KDA today (${today.avgKDA} vs avg ${baseline.avgKDA})`);
  else if (today.avgKDA < baseline.avgKDA * 0.85) weaknesses.push(`KDA below average (${today.avgKDA} vs avg ${baseline.avgKDA})`);

  // CS/min
  if (today.avgCSPM > baseline.avgCSPM * 1.1) strengths.push(`Great CS/min (${today.avgCSPM} vs avg ${baseline.avgCSPM})`);
  else if (today.avgCSPM < baseline.avgCSPM * 0.9) weaknesses.push(`CS/min below average (${today.avgCSPM} vs avg ${baseline.avgCSPM})`);

  // Vision
  if (today.avgVision > baseline.avgVision * 1.15) strengths.push(`Excellent vision control (${today.avgVision} vs avg ${baseline.avgVision})`);
  else if (today.avgVision < baseline.avgVision * 0.85) weaknesses.push(`Vision score below average (${today.avgVision} vs avg ${baseline.avgVision})`);

  // Kill participation
  if (today.avgKP > baseline.avgKP * 1.1) strengths.push(`High kill participation (${today.avgKP}%)`);
  else if (today.avgKP < baseline.avgKP * 0.9) weaknesses.push(`Low kill participation (${today.avgKP}%)`);

  // Damage share
  if (today.avgDmgShare > baseline.avgDmgShare * 1.1) strengths.push(`High damage output (${today.avgDmgShare}% of team)`);
  else if (today.avgDmgShare < baseline.avgDmgShare * 0.9) weaknesses.push(`Damage share below average (${today.avgDmgShare}%)`);

  // Win rate
  if (today.winrate >= 60) strengths.push(`Winning most games today (${today.winrate}% WR)`);
  else if (today.winrate <= 40 && today.totalGames >= 3) weaknesses.push(`Losing most games today (${today.winrate}% WR)`);

  // Win streak
  if (today.winStreak >= 3) strengths.push(`${today.winStreak}-game win streak`);

  // Deaths in losses
  const lossGames = today.perGameKDA.filter((g: any) => !g.win);
  if (lossGames.length >= 2) {
    const avgDeathsInLoss = lossGames.reduce((s: number, g: any) => {
      const raw = today.aggregateKDA; // use per-game for this
      return s + (1 / Math.max(0.1, g.kda)); // proxy for deaths
    }, 0) / lossGames.length;
    if (avgDeathsInLoss > 0.5) weaknesses.push("High deaths in losses — focus on playing safer when behind");
  }

  // Fallback
  if (strengths.length === 0 && today.totalGames > 0) strengths.push("Keep playing to build more data for insights");
  if (weaknesses.length === 0 && today.totalGames > 0) weaknesses.push("No major weaknesses detected — solid session");

  return { strengths, weaknesses };
}

// ── Handler ──

export async function learnOverviewHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { puuid, region, nametag } = body;

    if (!puuid || !region) {
      return new Response("Missing puuid or region", { status: 400 });
    }

    const { startTime, endTime } = getCurrentSeasonWindow();

    // Fetch all ranked match IDs for the season
    let allMatchIds: string[];
    try {
      allMatchIds = await getMatchIdsByPuuidOpts(puuid, region, {
        start: 0,
        count: 100,
        type: "ranked",
        startTime,
        endTime,
      });
    } catch (err) {
      console.error("❌ Overview: Riot match IDs failed:", err);
      return Response.json({ today: null, baseline: null, strengths: [], weaknesses: [], error: "Failed to fetch matches" });
    }

    if (!allMatchIds || allMatchIds.length === 0) {
      return Response.json({ today: null, baseline: null, strengths: [], weaknesses: [] });
    }

    // Fetch match details in batches of 5
    const BATCH = 5;
    const matchDetails: any[] = [];
    const toFetch = allMatchIds.slice(0, 30); // max 30 recent matches

    for (let i = 0; i < toFetch.length; i += BATCH) {
      const batch = toFetch.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(id => fetchMatch(id, region))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) matchDetails.push(r.value);
      }
    }

    // Split into today's games (midnight to midnight) and baseline (rest)
    const todayStr = todayKey();
    const todayMatches = matchDetails.filter(m => matchDayKey(m.info) === todayStr);
    const baselineMatches = matchDetails.filter(m => matchDayKey(m.info) !== todayStr).slice(0, 20);

    const todayStats = computeStats(todayMatches, puuid);
    const baselineStats = computeStats(baselineMatches, puuid);

    const { strengths, weaknesses } = computeStrengthsWeaknesses(todayStats, baselineStats);

    return Response.json({
      today: todayStats,
      baseline: {
        avgKDA: baselineStats.avgKDA,
        avgCSPM: baselineStats.avgCSPM,
        avgVision: baselineStats.avgVision,
        avgGoldPerMin: baselineStats.avgGoldPerMin,
        avgDmgShare: baselineStats.avgDmgShare,
        avgKP: baselineStats.avgKP,
      },
      strengths,
      weaknesses,
    });
  } catch (err) {
    console.error("❌ learnOverview error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
