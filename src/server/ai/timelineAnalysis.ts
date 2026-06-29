// src/server/ai/timelineAnalysis.ts
//
// COMPREHENSIVE position-aware analysis of a single Riot match-v5 TIMELINE, for
// the my_game AI tool. The goal: the AI should be aware of *everything* that
// happened in the game — not 4 things, dozens — so it can pinpoint what went
// wrong. We mine every frame (positions, gold/xp/cs/level, per-minute damage)
// and every event (kills, buildings, plates, elite monsters, wards, items,
// levels) into structured sections + a pre-digested `flags` list (the mistakes,
// each with its supporting number).
//
// SR map ~0..14820. Side via y-x (mirrors junglePlaystyle.ts), refined into
// lane/river/jungle zones.

import { itemName, buildItemPool } from "./itemData";

type Pos = { x: number; y: number };
const MAP = 14820;
const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);
const FOUNTAIN_BLUE: Pos = { x: 560, y: 560 };
const FOUNTAIN_RED: Pos = { x: 14260, y: 14260 };

function sideOf(p: Pos): "topside" | "botside" | "mid" {
  const diff = p.y - p.x;
  if (diff > 1800) return "topside";
  if (diff < -1800) return "botside";
  return "mid";
}
function zoneOf(p: Pos): string {
  if (dist(p, FOUNTAIN_BLUE) < 2400 || dist(p, FOUNTAIN_RED) < 2400) return "base";
  const { x, y } = p;
  const side = sideOf(p);
  const nearRiver = Math.abs(x + y - MAP) < 1700;
  const topLane = (x < 2900 && y > 3000) || (y > 11900 && x < 11800);
  const botLane = (y < 2900 && x > 3000) || (x > 11900 && y < 11800);
  if (topLane) return "top lane";
  if (botLane) return "bot lane";
  if (side === "mid") return nearRiver ? "river" : "mid lane";
  if (nearRiver) return side === "topside" ? "top river" : "bot river";
  return side === "topside" ? "top-side jungle" : "bot-side jungle";
}
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

export type GameTimelineAnalysis =
  | { available: false; reason: string }
  | ({ available: true } & Record<string, unknown>);

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmtT = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  const champById = new Map(parts.map((p) => [p.participantId, p.champion]));
  const teamById = new Map(parts.map((p) => [p.participantId, p.teamId]));
  const allyPids = parts.filter((p) => p.teamId === myTeam && p.participantId !== myPid).map((p) => p.participantId);
  const teamPids = [myPid, ...allyPids];
  const oppo = parts.find((p) => p.teamId !== myTeam && p.role === me.role) ?? null;
  const lastIdx = frames.length - 1;
  const gameMin = (frames[lastIdx]?.timestamp ?? 0) / 60000;

  // ── frame helpers ──────────────────────────────────────────────────────────
  const pf = (idx: number, pid: number) => frames[idx]?.participantFrames?.[String(pid)] ?? null;
  const frameNear = (ms: number) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs((frames[i].timestamp ?? 0) - ms);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const csOf = (f: any) => Number(f?.minionsKilled ?? 0) + Number(f?.jungleMinionsKilled ?? 0);
  const dmgChamp = (f: any) => Number(f?.damageStats?.totalDamageDoneToChampions ?? 0);
  const dmgTaken = (f: any) => Number(f?.damageStats?.totalDamageTaken ?? 0);

  // ── single pass over all events ──────────────────────────────────────────────
  type Kill = { t: number; killerId: number; victimId: number; assists: number[]; pos: Pos | null; bounty: number; shutdown: number };
  const myDeaths: Kill[] = [];
  const myKills: Kill[] = [];
  let myAssistCount = 0;
  let teamKills = 0;
  let myInvolvedKills = 0;
  let firstKill: { t: number; killerId: number; victimId: number } | null = null;
  let firstBloodGot = false;
  const multis: number[] = [];
  const buildings: any[] = [];
  let platesMe = 0;
  const monsters: any[] = [];
  let wardsPlaced = 0, controlWards = 0, wardsKilled = 0;
  const itemBuys: { t: number; id: number }[] = [];
  const myLevelUps: number[] = []; // ms timestamps indexed by level
  const oppLevelUps: number[] = [];
  let dragonSoul: string | null = null;
  const killSeq: { t: number; kill: boolean }[] = []; // for killing-spree

  for (const fr of frames) {
    for (const e of fr.events ?? []) {
      switch (e.type) {
        case "CHAMPION_KILL": {
          const k: Kill = {
            t: e.timestamp, killerId: e.killerId, victimId: e.victimId,
            assists: e.assistingParticipantIds ?? [], pos: (e.position as Pos) ?? null,
            bounty: Number(e.bounty ?? 0), shutdown: Number(e.shutdownBounty ?? 0),
          };
          if (!firstKill || k.t < firstKill.t) firstKill = { t: k.t, killerId: k.killerId, victimId: k.victimId };
          if (teamById.get(k.killerId) === myTeam) {
            teamKills++;
            if (k.killerId === myPid || k.assists.includes(myPid)) myInvolvedKills++;
          }
          if (k.killerId === myPid) { myKills.push(k); killSeq.push({ t: k.t, kill: true }); }
          if (k.assists.includes(myPid)) myAssistCount++;
          if (k.victimId === myPid) { myDeaths.push(k); killSeq.push({ t: k.t, kill: false }); }
          break;
        }
        case "CHAMPION_SPECIAL_KILL": {
          if (e.killerId !== myPid) break;
          if (e.killType === "KILL_FIRST_BLOOD") firstBloodGot = true;
          if (e.killType === "KILL_MULTI" && e.multiKillLength) multis.push(Number(e.multiKillLength));
          break;
        }
        case "BUILDING_KILL": {
          buildings.push({
            t: e.timestamp, teamId: e.teamId, lane: e.laneType, towerType: e.towerType,
            buildingType: e.buildingType, killerId: e.killerId, assists: e.assistingParticipantIds ?? [], pos: e.position,
          });
          break;
        }
        case "TURRET_PLATE_DESTROYED": {
          if (e.killerId === myPid) platesMe++;
          break;
        }
        case "ELITE_MONSTER_KILL": {
          const mt = String(e.monsterType ?? "");
          const label = mt.includes("DRAGON") ? "dragon" : mt.includes("BARON") ? "baron"
            : mt.includes("HERALD") ? "herald" : mt.includes("HORDE") ? "voidgrub"
            : mt.includes("ATAKHAN") ? "atakhan" : null;
          if (label) monsters.push({
            t: e.timestamp, type: label, subType: e.monsterSubType ?? null,
            killerId: e.killerId, killerTeam: e.killerTeamId ?? teamById.get(e.killerId),
            assists: e.assistingParticipantIds ?? [], pos: (e.position as Pos) ?? null,
          });
          break;
        }
        case "WARD_PLACED": {
          if (e.creatorId !== myPid) break;
          wardsPlaced++;
          if (String(e.wardType ?? "").includes("CONTROL")) controlWards++;
          break;
        }
        case "WARD_KILL": {
          if (e.killerId === myPid) wardsKilled++;
          break;
        }
        case "ITEM_PURCHASED": {
          if (e.participantId === myPid) itemBuys.push({ t: e.timestamp, id: Number(e.itemId) });
          break;
        }
        case "LEVEL_UP": {
          const lvl = Number(e.level ?? 0);
          if (e.participantId === myPid) myLevelUps[lvl] = e.timestamp;
          else if (oppo && e.participantId === oppo.participantId) oppLevelUps[lvl] = e.timestamp;
          break;
        }
        case "DRAGON_SOUL_GIVEN": {
          dragonSoul = `${e.teamId === myTeam ? "ally" : "enemy"} ${e.name ?? ""}`.trim();
          break;
        }
      }
    }
  }

  // ── COMBAT ───────────────────────────────────────────────────────────────────
  // killing spree (max consecutive kills before a death)
  let spree = 0, bestSpree = 0;
  for (const s of killSeq.sort((a, b) => a.t - b.t)) {
    if (s.kill) { spree++; bestSpree = Math.max(bestSpree, spree); } else spree = 0;
  }
  const firstBlood = firstKill
    ? (firstKill.killerId === myPid ? "got" : firstKill.victimId === myPid ? "gave" : "none")
    : "none";
  const shutdownsCollected = myKills.reduce((s, k) => s + k.shutdown, 0);
  const shutdownsGiven = myDeaths.reduce((s, k) => s + k.shutdown, 0);

  // ── DEATHS (rich) ────────────────────────────────────────────────────────────
  const inLane = (z: string, side: string) =>
    mySide === "jungle" ? z.includes("jungle") : side === mySide;
  const deaths = myDeaths.map((k) => {
    const idx = frameNear(k.t);
    let alliesNearby = 0;
    if (k.pos) for (const pid of allyPids) {
      const ap = pf(idx, pid)?.position; if (ap && dist(ap, k.pos) < 2900) alliesNearby++;
    }
    const side = k.pos ? sideOf(k.pos) : "unknown";
    const zone = k.pos ? zoneOf(k.pos) : "unknown";
    const myGold = Number(pf(idx, myPid)?.totalGold ?? 0);
    const oppGold = oppo ? Number(pf(idx, oppo.participantId)?.totalGold ?? 0) : 0;
    const enemiesInvolved = (k.killerId && teamById.get(k.killerId) !== myTeam ? 1 : 0)
      + k.assists.filter((id) => teamById.get(id) !== myTeam).length;
    return {
      time: fmtT(k.t), minute: r1(k.t / 60000), zone,
      alone: alliesNearby === 0, allies_nearby: alliesNearby,
      enemies_involved: Math.max(1, enemiesInvolved),
      killer: champById.get(k.killerId) ?? "minion/turret",
      in_lane: inLane(zone, side),
      shutdown_given: k.shutdown, gold_diff_at_death: oppo ? myGold - oppGold : null,
      phase: k.t < 14 * 60000 ? "early" : k.t < 25 * 60000 ? "mid" : "late",
    };
  });
  const byZone: Record<string, number> = {};
  for (const d of deaths) byZone[d.zone] = (byZone[d.zone] ?? 0) + 1;
  const death_summary = {
    total: deaths.length,
    alone: deaths.filter((d) => d.alone).length,
    in_own_lane: deaths.filter((d) => d.in_lane).length,
    roaming: deaths.filter((d) => !d.in_lane && d.zone !== "base").length,
    by_zone: byZone,
    by_phase: {
      early: deaths.filter((d) => d.phase === "early").length,
      mid: deaths.filter((d) => d.phase === "mid").length,
      late: deaths.filter((d) => d.phase === "late").length,
    },
    first_death_min: deaths.length ? deaths[0].minute : null,
    deaths_before_10: deaths.filter((d) => d.minute < 10).length,
  };

  // ── LANING (vs direct opponent) ──────────────────────────────────────────────
  const statAt = (pid: number, idx: number) => {
    const f = pf(idx, pid); if (!f) return null;
    return { gold: Number(f.totalGold ?? 0), xp: Number(f.xp ?? 0), cs: csOf(f), level: Number(f.level ?? 0) };
  };
  const diffAt = (idx: number) => {
    if (!oppo) return null;
    const m = statAt(myPid, idx), o = statAt(oppo.participantId, idx);
    if (!m || !o) return null;
    return { cs: m.cs - o.cs, gold: m.gold - o.gold, xp: m.xp - o.xp, level: m.level - o.level, my_cs: m.cs };
  };
  const csPerMin = (a: number, b: number) => {
    const fa = statAt(myPid, a), fb = statAt(myPid, b);
    if (!fa || !fb || b <= a) return null;
    return r1((fb.cs - fa.cs) / (b - a));
  };
  const d14 = diffAt(14);
  const goldDiff14 = d14?.gold ?? (diffAt(Math.min(14, lastIdx))?.gold ?? null);
  const laning = oppo ? {
    opponent: oppo.champion,
    lane_result: goldDiff14 == null ? "unknown" : goldDiff14 > 800 ? "won" : goldDiff14 < -800 ? "lost" : "even",
    diff_at_5: diffAt(5), diff_at_10: diffAt(10), diff_at_14: diffAt(14),
    cs_per_min_0_10: csPerMin(0, 10), cs_per_min_10_20: csPerMin(10, Math.min(20, lastIdx)),
    level6_min: myLevelUps[6] ? r1(myLevelUps[6] / 60000) : null,
    opp_level6_min: oppLevelUps[6] ? r1(oppLevelUps[6] / 60000) : null,
    hit_level6_first: myLevelUps[6] && oppLevelUps[6] ? myLevelUps[6] < oppLevelUps[6] : null,
    solo_kills_lane_phase: myKills.filter((k) => k.t < 14 * 60000 && k.assists.length === 0).length,
    plates_taken: platesMe,
  } : null;

  // ── OBJECTIVES ───────────────────────────────────────────────────────────────
  const objEvents = monsters.map((o) => {
    const idx = frameNear(o.t);
    const myPos = pf(idx, myPid)?.position;
    const present = !!(myPos && o.pos && dist(myPos, o.pos) < 2600) || o.killerId === myPid || o.assists.includes(myPid);
    return { time: fmtT(o.t), type: o.type, subType: o.subType, taken_by: o.killerTeam === myTeam ? "ally" : "enemy", present, you_were: myPos ? zoneOf(myPos) : "?" };
  });
  const cnt = (type: string, team: "ally" | "enemy") => objEvents.filter((o) => o.type === type && o.taken_by === team).length;
  const towers = buildings.filter((b) => b.buildingType === "TOWER_BUILDING");
  const firstTower = towers.length ? (towers[0].teamId !== myTeam ? "ally" : "enemy") : "none"; // teamId = owner of destroyed tower
  const allyObjs = objEvents.filter((o) => o.taken_by === "ally");
  const objectives = {
    events: objEvents,
    dragons: { ally: cnt("dragon", "ally"), enemy: cnt("dragon", "enemy") },
    barons: { ally: cnt("baron", "ally"), enemy: cnt("baron", "enemy") },
    heralds: { ally: cnt("herald", "ally"), enemy: cnt("herald", "enemy") },
    voidgrubs: { ally: cnt("voidgrub", "ally"), enemy: cnt("voidgrub", "enemy") },
    dragon_soul: dragonSoul,
    first_tower: firstTower,
    towers_ally: towers.filter((b) => b.teamId !== myTeam).length,
    towers_enemy: towers.filter((b) => b.teamId === myTeam).length,
    your_presence_pct: allyObjs.length ? Math.round((allyObjs.filter((o) => o.present).length / allyObjs.length) * 100) : null,
    deaths_away_from_objective: deathsAway(myDeaths, monsters),
  };

  // ── VISION ───────────────────────────────────────────────────────────────────
  const vision = {
    wards_placed: wardsPlaced, control_wards: controlWards, wards_killed: wardsKilled,
    wards_per_min: gameMin > 0 ? r1(wardsPlaced / gameMin) : null,
  };

  // ── DAMAGE ───────────────────────────────────────────────────────────────────
  const shareAt = (idx: number, fn: (f: any) => number) => {
    let mine = 0, team = 0;
    for (const pid of teamPids) { const v = fn(pf(idx, pid)); team += v; if (pid === myPid) mine = v; }
    return team > 0 ? Math.round((mine / team) * 100) : null;
  };
  const lastF = pf(lastIdx, myPid);
  const ds = lastF?.damageStats ?? {};
  const dmgToChamp = Number(ds.totalDamageDoneToChampions ?? 0);
  const dmgSplit = (k: string) => dmgToChamp > 0 ? Math.round((Number(ds[k] ?? 0) / dmgToChamp) * 100) : null;
  const damage = {
    to_champions: dmgToChamp,
    damage_share_pct: shareAt(lastIdx, dmgChamp),
    damage_share_at_10: shareAt(10, dmgChamp),
    damage_share_at_20: shareAt(Math.min(20, lastIdx), dmgChamp),
    damage_taken: Number(ds.totalDamageTaken ?? 0),
    damage_taken_share_pct: shareAt(lastIdx, dmgTaken),
    dmg_per_min: gameMin > 0 ? Math.round(dmgToChamp / gameMin) : null,
    magic_pct: dmgSplit("magicDamageDoneToChampions"),
    physical_pct: dmgSplit("physicalDamageDoneToChampions"),
    true_pct: dmgSplit("trueDamageDoneToChampions"),
  };

  // ── ECONOMY ──────────────────────────────────────────────────────────────────
  let maxLead = 0, maxDeficit = 0, idleSum = 0, idleN = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const mf = pf(i, myPid); if (mf) { idleSum += Number(mf.currentGold ?? 0); idleN++; }
    if (oppo) { const d = diffAt(i); if (d) { maxLead = Math.max(maxLead, d.gold); maxDeficit = Math.min(maxDeficit, d.gold); } }
  }
  const buildSet = new Set(buildItemPool());
  const item_timings = itemBuys
    .filter((b) => buildSet.has(b.id))
    .map((b) => ({ item: itemName(b.id), min: r1(b.t / 60000) }));
  const myTotalGold = Number(lastF?.totalGold ?? 0);
  const teamGold = teamPids.reduce((s, pid) => s + Number(pf(lastIdx, pid)?.totalGold ?? 0), 0);
  const economy = {
    total_gold: myTotalGold,
    gold_per_min: gameMin > 0 ? Math.round(myTotalGold / gameMin) : null,
    gold_share_pct: teamGold > 0 ? Math.round((myTotalGold / teamGold) * 100) : null,
    gold_diff_vs_opp_at_10: diffAt(10)?.gold ?? null,
    gold_diff_vs_opp_at_14: d14?.gold ?? null,
    max_gold_lead: maxLead, max_gold_deficit: maxDeficit,
    avg_idle_gold: idleN ? Math.round(idleSum / idleN) : null,
    item_path: item_timings,
  };

  // ── MACRO / MOVEMENT ─────────────────────────────────────────────────────────
  const zoneTime: Record<string, number> = {};
  let nearestSum = 0, nearestN = 0, soloFrames = 0, roamFramesPre14 = 0, framesPre14 = 0;
  for (let i = 0; i <= lastIdx; i++) {
    const mp = pf(i, myPid)?.position; if (!mp) continue;
    const z = zoneOf(mp); zoneTime[z] = (zoneTime[z] ?? 0) + 1;
    let nd = Infinity;
    for (const pid of allyPids) { const ap = pf(i, pid)?.position; if (ap) nd = Math.min(nd, dist(ap, mp)); }
    if (nd < Infinity) { nearestSum += nd; nearestN++; if (nd > 4000) soloFrames++; }
    const ts = frames[i].timestamp ?? 0;
    if (ts < 14 * 60000) { framesPre14++; if (mySide !== "jungle" && sideOf(mp) !== mySide && zoneOf(mp) !== "base") roamFramesPre14++; }
  }
  const totalZ = Object.values(zoneTime).reduce((s, n) => s + n, 0) || 1;
  const region_time_pct: Record<string, number> = {};
  for (const [z, n] of Object.entries(zoneTime)) region_time_pct[z] = Math.round((n / totalZ) * 100);
  const macro = {
    region_time_pct,
    avg_dist_to_nearest_ally: nearestN ? Math.round(nearestSum / nearestN) : null,
    pct_time_far_from_team: nearestN ? Math.round((soloFrames / nearestN) * 100) : null,
    pct_time_off_lane_pre14: framesPre14 ? Math.round((roamFramesPre14 / framesPre14) * 100) : null,
  };

  // ── FLAGS (pre-digested mistakes, each with its number) ──────────────────────
  const carry = ["TOP", "MIDDLE", "BOTTOM"].includes(me.role.toUpperCase());
  const flags: Array<{ key: string; severity: "high" | "medium" | "low"; detail: string }> = [];
  const add = (key: string, severity: "high" | "medium" | "low", detail: string) => flags.push({ key, severity, detail });
  if (goldDiff14 != null && goldDiff14 < -800) add("lost_lane", goldDiff14 < -1800 ? "high" : "medium", `down ${-goldDiff14}g to ${oppo?.champion} by 14:00`);
  if (goldDiff14 != null && goldDiff14 > 1200) add("won_lane", "low", `up ${goldDiff14}g on ${oppo?.champion} by 14:00`);
  if (death_summary.alone >= 3 || (deaths.length >= 4 && death_summary.alone / deaths.length > 0.45))
    add("dies_isolated", "high", `${death_summary.alone}/${deaths.length} deaths with no allies nearby`);
  if (death_summary.roaming >= 2) add("dies_roaming", "medium", `${death_summary.roaming} deaths away from your lane/role area`);
  if (death_summary.deaths_before_10 >= 3) add("fed_early", "high", `${death_summary.deaths_before_10} deaths before 10:00`);
  if (objectives.deaths_away_from_objective.length >= 2) add("dies_off_objective", "medium", `${objectives.deaths_away_from_objective.length} deaths far from a contested objective`);
  if (me.role.toUpperCase() !== "JUNGLE" && (damage.damage_share_pct ?? 99) < 20 && carry)
    add("low_damage_share", "high", `only ${damage.damage_share_pct}% of team damage`);
  if (carry && laning && laning.cs_per_min_0_10 != null && laning.cs_per_min_0_10 < 6)
    add("low_cs", "medium", `${laning.cs_per_min_0_10} cs/min in the first 10 min`);
  if (me.role.toUpperCase() === "UTILITY" ? (vision.wards_per_min ?? 9) < 1.2 : (vision.wards_per_min ?? 9) < 0.5)
    add("low_vision", "medium", `${vision.wards_per_min} wards/min, ${vision.control_wards} control wards`);
  if ((economy.avg_idle_gold ?? 0) > 900) add("hoards_gold", "low", `averaged ${economy.avg_idle_gold}g unspent — recall + buy more often`);
  if ((macro.pct_time_far_from_team ?? 0) > 45 && !carry) add("often_split_from_team", "low", `${macro.pct_time_far_from_team}% of the game far (>4000u) from any ally`);
  if (objectives.your_presence_pct != null && objectives.your_presence_pct < 50) add("absent_for_objectives", "medium", `present for only ${objectives.your_presence_pct}% of your team's objectives`);

  return {
    available: true,
    duration_min: r1(gameMin),
    opponent: oppo?.champion ?? null,
    combat: {
      kills: myKills.length, deaths: myDeaths.length, assists: myAssistCount,
      kp_pct_timeline: teamKills > 0 ? Math.round((myInvolvedKills / teamKills) * 100) : null,
      first_blood: firstBlood,
      multikills: { double: multis.filter((m) => m === 2).length, triple: multis.filter((m) => m === 3).length, quadra: multis.filter((m) => m === 4).length, penta: multis.filter((m) => m === 5).length },
      largest_killing_spree: bestSpree,
      shutdowns_collected: shutdownsCollected, shutdowns_given: shutdownsGiven,
    },
    deaths,
    death_summary,
    laning,
    objectives,
    vision,
    damage,
    economy,
    macro,
    flags,
    hint:
      "FULL-MATCH report from the Riot timeline — you are now aware of nearly everything that happened. `flags` is the pre-digested list of mistakes (each with the number). Lead your answer from the HIGHEST-severity flags, then back them with the raw sections (deaths[], death_summary, laning diffs, objectives, vision, damage, economy, macro). Be concrete and cite times/zones/numbers (e.g. 'died bot-side 5/11, 3 with no allies', 'down 1.4k to your laner by 14', '18% damage share', 'present for 33% of objectives'). Do NOT dump every field — pick the 2-4 most impactful problems for THIS game and give an actionable fix for each. If a value is null it wasn't available; don't invent.",
  };
}

// Deaths within 75s of a contested elite monster but >5500u from it.
function deathsAway(myDeaths: any[], monsters: any[]): Array<{ time: string; you_were: string; objective: string }> {
  const out: Array<{ time: string; you_were: string; objective: string }> = [];
  for (const d of myDeaths) {
    if (!d.pos) continue;
    for (const o of monsters) {
      if (Math.abs(o.t - d.t) <= 75000 && o.pos && dist(d.pos, o.pos) > 5500) {
        out.push({ time: fmtT(d.t), you_were: zoneOf(d.pos), objective: `${o.type}${o.pos ? " near " + zoneOf(o.pos) : ""}` });
        break;
      }
    }
  }
  return out;
}
