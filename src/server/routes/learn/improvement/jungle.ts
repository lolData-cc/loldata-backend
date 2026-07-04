// ── Path of the Jungle ──────────────────────────────────────────────────────
// The first fully-built Improvement Tree. Root → 4 category hubs → 9 skill leaves,
// every leaf verified from the Riot Match Timeline over the player's recent
// ranked jungle games. Copy (why/how) lives here so the whole node is one object.

import {
  MIN,
  isEliteKill,
  killerTeamOf,
  involved,
  myFrameAt,
  jungleCsOf,
  itemBuys,
  type RoleTree,
  type GameCtx,
  type VerifyResult,
} from "./types";

const NO_ELIG: VerifyResult = { eligible: false, success: false };
const ok = (eligible: boolean, success: boolean): VerifyResult => ({ eligible, success: eligible && success });

// AP / snowball junglers where a Dark Seal opener is the standard power spike.
const CARRY_JUNGLERS = new Set<string>([
  "Kindred", "Karthus", "Graves", "Khazix", "Nidalee", "Ekko", "Diana", "Elise",
  "Evelynn", "Nocturne", "Viego", "Kayn", "Belveth", "Rengar", "Qiyana", "Lillia",
  "FiddleSticks", "Shaco", "Brand", "Shyvana", "Hecarim", "Talon", "Taliyah", "Gwen",
]);

const DARK_SEAL = 1082;
const CONTROL_WARD = 2055;

export const JUNGLE_TREE: RoleTree = {
  role: "JUNGLE",
  title: "Path of the Jungle",
  tagline: "Tempo, objectives, and map control — the invisible skills that decide games.",
  categories: [
    { id: "objectives", title: "Objective Control", blurb: "The neutral objectives are the jungler's win condition. Control the map's economy." },
    { id: "economy", title: "Economy & Clear", blurb: "A fast, efficient clear turns into gold, levels and pressure before anyone else." },
    { id: "tempo", title: "Tempo & Combat", blurb: "Convert your clear into map pressure. Show up where the map is hot, before it cools." },
    { id: "discipline", title: "Vision & Discipline", blurb: "Wards buy information; not dying buys tempo. The quiet fundamentals of climbing." },
  ],
  nodes: [
    // ── OBJECTIVE CONTROL ────────────────────────────────────────────────
    {
      id: "jgl.obj.grubs",
      category: "objectives",
      title: "Secure the Grubs",
      short: "Take ≥3 Void Grubs with your team when they spawn.",
      why: "Void Grubs are the single most gold- and tempo-efficient early objective on the map. Each grub gives your whole team a stacking bonus vs. buildings — six grubs can end games. As the jungler you're the one who has to be there to smite and body them, because losing them silently hands the enemy team free tower pressure across the whole map.",
      how: "In each game where grubs spawned, we check the timeline for Void Grub (HORDE) kills your team took where you were the killer or an assister. The node fills as you consistently secure ≥3 grubs.",
      threshold: 0.6,
      verify: (g: GameCtx): VerifyResult => {
        const horde = g.events.filter((e) => isEliteKill(e, "HORDE"));
        if (horde.length === 0) return NO_ELIG; // grubs never contested
        const mine = horde.filter((e) => killerTeamOf(e, g.info) === g.myTeam || involved(e, g.myId));
        const secured = horde.filter((e) => involved(e, g.myId)).length;
        return ok(true, secured >= 3 || mine.length >= 3);
      },
    },
    {
      id: "jgl.obj.trade",
      category: "objectives",
      title: "Trade Objectives",
      short: "Grab grubs/herald while the enemy takes dragon (and vice-versa).",
      why: "You can't be everywhere. Elite junglers don't contest every objective — they TRADE. If the enemy commits four players to a dragon on the bottom side, the correct play is often to take the grubs or herald on the top side instead of dying 1v4. Trading keeps the objective economy even while denying the enemy a free fight, and it's the clearest signal of a jungler who understands the map instead of chasing every ping.",
      how: "We scan the timeline for a neutral objective YOUR team secured (with your involvement) within ±90 seconds of the enemy team taking a DIFFERENT objective. A clean cross-map trade lights this node.",
      threshold: 0.4,
      verify: (g: GameCtx): VerifyResult => {
        const elites = g.events.filter((e) => isEliteKill(e));
        const mine = elites.filter((e) => involved(e, g.myId));
        const enemy = elites.filter((e) => {
          const t = killerTeamOf(e, g.info);
          return t != null && t !== g.myTeam;
        });
        if (mine.length === 0 || enemy.length === 0) return NO_ELIG;
        const traded = mine.some((m) =>
          enemy.some((en) => en.monsterType !== m.monsterType && Math.abs(en.timestamp - m.timestamp) <= 90_000)
        );
        return ok(true, traded);
      },
    },
    {
      id: "jgl.obj.dragon",
      category: "objectives",
      title: "Dragon Presence",
      short: "Be involved in the majority of your team's dragons.",
      why: "Dragon souls and the Elder buff swing late-game teamfights harder than almost anything else, and dragons are ON the jungler. If your team is taking dragons without you, either you're not pathing toward them or you're dying for nothing elsewhere. Consistent dragon presence means you're pathing with your win condition in mind.",
      how: "Of the dragons your team killed, we count how many you were the killer or an assister on. The node fills as you hit ≥60% presence across your games.",
      threshold: 0.5,
      verify: (g: GameCtx): VerifyResult => {
        const drakes = g.events.filter((e) => isEliteKill(e, "DRAGON") && killerTeamOf(e, g.info) === g.myTeam);
        if (drakes.length === 0) return NO_ELIG;
        const present = drakes.filter((e) => involved(e, g.myId)).length;
        return ok(true, present / drakes.length >= 0.6);
      },
    },

    // ── ECONOMY & CLEAR ──────────────────────────────────────────────────
    {
      id: "jgl.eco.clear",
      category: "economy",
      title: "Efficient First Clear",
      short: "≥14 jungle CS by 4:00 — a clean, full first clear.",
      why: "Your first clear sets the tempo for the entire early game. A full, efficient clear means you hit level 4 (or 3-into-gank) on time, with health to spare and a smite ready for the first objective. A slow clear means you're perpetually a step behind — later to ganks, later to grubs, later to every fight. It's the most fixable jungle mistake and the highest-leverage habit to build.",
      how: "We read your jungle CS from the timeline at the 4-minute mark. Fourteen or more means you cleared efficiently without dallying.",
      threshold: 0.6,
      verify: (g: GameCtx): VerifyResult => {
        const mf = myFrameAt(g.frames, 4, g.myId);
        if (!mf) return NO_ELIG;
        return ok(true, jungleCsOf(mf) >= 14);
      },
    },
    {
      id: "jgl.eco.darkseal",
      category: "economy",
      title: "Dark Seal Opener",
      short: "On a carry jungler, buy a Dark Seal on your first back.",
      why: "On snowball junglers (Kindred, Graves, Kha'Zix, Diana, Ekko…), a 350g Dark Seal is the highest-value first-back purchase in the game. It gives stats immediately and, once you stack it, an absurd gold-efficiency swing that turns an early lead into a game-ending one. Skipping it is leaving free power on the table on exactly the champions built to snowball.",
      how: "On games where you played a carry jungler, we check the timeline for a Dark Seal purchased before ~9:00 (your first or second back). Only carry-jungler games count toward this node.",
      threshold: 0.6,
      verify: (g: GameCtx): VerifyResult => {
        if (!CARRY_JUNGLERS.has(g.champion)) return NO_ELIG; // node only applies to carry junglers
        return ok(true, itemBuys(g.events, g.myId, DARK_SEAL, 9 * MIN) >= 1);
      },
    },

    // ── TEMPO & COMBAT ───────────────────────────────────────────────────
    {
      id: "jgl.tempo.early",
      category: "tempo",
      title: "Early Impact",
      short: "Get a kill or assist before 8:00.",
      why: "A jungler who does nothing but farm for the first eight minutes is a jungler whose lanes are all playing 1v1 with no help. Early impact — a successful gank, a counter-gank, an invade pickup — is how you convert your clear into a real lead for your team. You don't need to force it every game, but a jungler who reliably makes something happen early is dictating the pace instead of reacting to it.",
      how: "We look for a champion kill or assist you were involved in before the 8-minute mark in the timeline.",
      threshold: 0.55,
      verify: (g: GameCtx): VerifyResult => {
        const early = g.events.some((e) => e?.type === "CHAMPION_KILL" && e.timestamp < 8 * MIN && involved(e, g.myId));
        return ok(true, early);
      },
    },
    {
      id: "jgl.tempo.kp",
      category: "tempo",
      title: "Kill Participation",
      short: "Be part of ≥60% of your team's kills.",
      why: "Kill participation is the cleanest single measure of whether you're actually playing WITH your team. High KP means you're showing up to the fights and skirmishes that decide games; low KP means you're farming a side lane while your team dies 4v5. For a jungler especially, KP is your job description — you have the mobility and the tempo to be everywhere the action is.",
      how: "Kills plus assists, divided by your team's total kills, in each game. Sixty percent or more counts.",
      threshold: 0.6,
      verify: (g: GameCtx): VerifyResult => {
        if (g.teamKills <= 0) return NO_ELIG;
        const kp = ((g.me.kills ?? 0) + (g.me.assists ?? 0)) / g.teamKills;
        return ok(true, kp >= 0.6);
      },
    },

    // ── VISION & DISCIPLINE ──────────────────────────────────────────────
    {
      id: "jgl.disc.wards",
      category: "discipline",
      title: "Control Ward Habit",
      short: "Buy ≥3 Control Wards over the game.",
      why: "Control wards are the cheapest power you can buy — 75 gold to deny the enemy vision of an objective, secure a pit before a fight, or safely path through contested jungle. Junglers who don't buy them are playing the map blind and getting collapsed on. Building the habit of grabbing a control ward on every back is one of the simplest, most consistent ways to climb.",
      how: "We count Control Ward (item 2055) purchases in the timeline across the game. Three or more means it's a habit, not an afterthought.",
      threshold: 0.5,
      verify: (g: GameCtx): VerifyResult => ok(true, itemBuys(g.events, g.myId, CONTROL_WARD) >= 3),
    },
    {
      id: "jgl.disc.nofeed",
      category: "discipline",
      title: "Don't Feed Early",
      short: "At most 1 death before 10:00.",
      why: "The early game is where junglers throw the most: overstaying an invade, force-ganking into a ward, coin-flipping a 50/50 skirmish. Every early death doesn't just give gold — it gives the enemy jungler free tempo to take YOUR camps and objectives while you walk back. Discipline in the first ten minutes (respecting vision, backing off losing fights) keeps you on the map and on tempo, which is worth more than the flashy play you died trying to make.",
      how: "We count your deaths before the 10-minute mark in the timeline. One or zero clears this node.",
      threshold: 0.6,
      verify: (g: GameCtx): VerifyResult => {
        const earlyDeaths = g.events.filter((e) => e?.type === "CHAMPION_KILL" && e.victimId === g.myId && e.timestamp < 10 * MIN).length;
        return ok(true, earlyDeaths <= 1);
      },
    },
  ],
};
