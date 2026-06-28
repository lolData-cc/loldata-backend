// src/server/ai/tools.ts
//
// Tool definitions for LOLDATA AI + their executors, wired DIRECTLY to the box:
// the Explorer compile() engine (champion stats, item rankings conditioned on the
// enemy composition, duos, matchups) and the participants table (the user's own
// recent form). Everything is champion-NAME based — compile() keys off
// `champion_name`, so no champion-id resolution is needed for the data tools.

import type Anthropic from "@anthropic-ai/sdk";
import { compile, type ExplorerGraph, type Role } from "../explorer/compile";
import { explorerPool, currentPatchPrefix } from "../explorer/pool";
import {
  warmChampClasses,
  normChamp,
  championsInClass,
  classesOf,
  CHAMP_CLASSES,
  CHAMP_CATEGORIES,
} from "../explorer/champClass";
import { warmItemData, itemName, buildItemPool } from "./itemData";
import { fetchChampionOtps } from "../routes/getChampionOtpRanking";
import { getMatchDetails } from "../riot";
import { latestPatch as latestPatchVersion } from "../services/patchDiff";

export type UserContext = { puuid?: string | null; region?: string | null; nametag?: string | null };

const ROLES = new Set(["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]);
const QUEUES = [420, 440]; // Ranked Solo/Duo + Flex

// platform (matches.platform, e.g. "euw1") → the region segment in /summoners/:region/...
const PLATFORM_REGION: Record<string, string> = {
  euw1: "euw", eun1: "eune", na1: "na", kr: "kr", br1: "br", jp1: "jp",
  la1: "lan", la2: "las", oc1: "oce", tr1: "tr", ru: "ru", ph2: "ph",
  sg2: "sg", th2: "th", tw2: "tw", vn2: "vn",
};
export function regionFromPlatform(p?: string | null): string {
  return PLATFORM_REGION[String(p ?? "").toLowerCase()] ?? "euw";
}
/** Build a /summoners/:region/:slug href the same way the rest of the app does. */
export function summonerHref(name: string, tag: string, region: string): string {
  const slug = `${encodeURIComponent(String(name).trim().replace(/\s+/g, "+"))}-${String(tag).trim()}`;
  return `/summoners/${region}/${slug}`;
}
/** "Name#TAG" + region → summoner href (for the signed-in user's own profile). */
export function summonerHrefFromNametag(nametag?: string | null, region?: string | null): string | null {
  if (!nametag) return null;
  const [name, tag] = String(nametag).split("#");
  if (!name || !tag) return null;
  return summonerHref(name, tag, (region || "euw").toLowerCase());
}
export function championHref(canon: string): string {
  return `/champions/${canon}`;
}

// ── champion-name resolution (display/alias → canonical Data Dragon id) ───────
let _nameMap: Map<string, string> | null = null;
async function nameMap(): Promise<Map<string, string>> {
  await warmChampClasses();
  if (_nameMap) return _nameMap;
  const m = new Map<string, string>();
  for (const cls of CHAMP_CLASSES) for (const id of championsInClass(cls)) m.set(normChamp(id), id);
  _nameMap = m;
  return m;
}
// Champions whose display name differs from the Data Dragon id used in the DB.
const ALIAS: Record<string, string> = {
  wukong: "MonkeyKing", nunu: "Nunu", nunuwillump: "Nunu", mundo: "DrMundo", drmundo: "DrMundo",
  reksai: "RekSai", kaisa: "Kaisa", chogath: "Chogath", khazix: "Khazix", velkoz: "Velkoz",
  kogmaw: "KogMaw", jarvan: "JarvanIV", jarvaniv: "JarvanIV", leblanc: "Leblanc", ksante: "KSante",
  belveth: "Belveth", masteryi: "MasterYi", missfortune: "MissFortune", tahmkench: "TahmKench",
  twistedfate: "TwistedFate", aurelionsol: "AurelionSol", xinzhao: "XinZhao", drmundo2: "DrMundo",
  renataglasc: "Renata", renata: "Renata", monkeyking: "MonkeyKing",
};
export async function resolveChamp(input: string): Promise<string | null> {
  if (!input) return null;
  const norm = normChamp(input);
  const m = await nameMap();
  if (m.has(norm)) return m.get(norm)!;
  if (ALIAS[norm]) return ALIAS[norm];
  return null;
}
function normRole(r?: string): Role | undefined {
  if (!r) return undefined;
  const s = String(r).trim().toUpperCase();
  if (s === "MID" || s === "MIDDLE") return "MIDDLE";
  if (s === "ADC" || s === "BOT" || s === "BOTTOM") return "BOTTOM";
  if (s === "SUPPORT" || s === "SUP" || s === "UTILITY") return "UTILITY";
  if (ROLES.has(s)) return s as Role;
  return undefined;
}

// ── compiled-query runner with a short cache (cold Explorer scans are seconds) ─
type Cached = { ts: number; rows: any[] };
const cache = new Map<string, Cached>();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function runGraph(graph: ExplorerGraph): Promise<any[]> {
  const patch = await currentPatchPrefix();
  const { text, params } = compile(graph, patch);
  const key = text + "|" + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.rows;

  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 15000");
    const r = await client.query(text, params);
    cache.set(key, { ts: Date.now(), rows: r.rows });
    return r.rows;
  } finally {
    client.release();
  }
}

// ── tool definitions (shown to Claude) ───────────────────────────────────────
const CATS = CHAMP_CATEGORIES as readonly string[];

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "champion_overview",
    description:
      "Overall performance of a champion from ranked match data: winrate, games analysed, average KDA, CS and gold. Optionally for a specific role. Use for general 'how good is X', 'X winrate', strength/tier questions.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string", description: "Champion name, e.g. 'Quinn', \"Kai'Sa\", 'Wukong'." },
        role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"], description: "Optional role (BOTTOM = ADC, UTILITY = support)." },
      },
      required: ["champion"],
    },
  },
  {
    name: "best_items",
    description:
      "The strongest build items for a champion, ranked by confidence-weighted winrate (small samples are shrunk toward the average, so flukes don't win). Can be CONDITIONED on the enemy team composition — e.g. items that overperform when the enemy has assassins — or against one specific enemy champion. This is the right tool for build advice and 'best item vs <category/champion>' questions. Returns final-build items (legendaries/boots), so describe the top result as the item to prioritise, not literally the first purchase.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] },
        vs_enemy_category: {
          type: "string",
          enum: CATS as string[],
          description: "Only count games where the ENEMY team contains this kind of champion. Classes: Assassin, Fighter, Mage, Marksman, Support, Tank. Also AD, AP, Melee, Ranged. Use 'Assassin' for 'vs assassins'.",
        },
        vs_enemy_category_min: { type: "number", description: "Minimum number of enemy champions of that category (default 1; use 2 for 'assassin-heavy')." },
        vs_enemy_champion: { type: "string", description: "Only count games against this specific enemy champion." },
      },
      required: ["champion"],
    },
  },
  {
    name: "best_runes",
    description:
      "The best runes for a champion: the most-used and highest-winrate KEYSTONES (e.g. Conqueror, Electrocute, Press the Attack, Grasp of the Undying) plus the dominant primary+secondary rune trees, from ranked games. Optionally for a specific role. This is the right tool for 'best keystone for X', 'what runes does X run', 'best runes for X jungle'.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"], description: "Optional role (BOTTOM = ADC, UTILITY = support)." },
      },
      required: ["champion"],
    },
  },
  {
    name: "best_teammates",
    description:
      "Best duo partners / teammates for a champion, ranked by how much they raise its winrate. For an ADC this returns the best supports; for a support, the best ADCs; otherwise best teammates overall. Use for 'best support for X', 'who should X duo with'.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        partner_role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"], description: "Optional: restrict partners to this role." },
      },
      required: ["champion"],
    },
  },
  {
    name: "matchups",
    description:
      "Lane/enemy matchups for a champion. With an 'opponent', returns the exact head-to-head winrate (subject vs that champion). Without one, returns the champion's most FAVOURABLE matchups (enemies it beats), with winrate and sample size. Use for 'is X good into Y', 'what does X beat', 'X vs Y'.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] },
        opponent: { type: "string", description: "Optional specific enemy champion for an exact head-to-head." },
      },
      required: ["champion"],
    },
  },
  {
    name: "champion_top_players",
    description:
      "The champion's authoritative ranked one-trick (OTP) leaderboard — the SAME list shown on the champion's players page. These are Master+ players who main the champion, ORDERED BY RANK (highest elo first), NOT by winrate. Use this to answer 'who is the best/strongest <champion> player': the FIRST player in the list IS the best — do not re-rank by winrate. Each row has rank position, name/tag, elo (tier + LP), champion games, winrate, region and a ready-made `href`. Cite a player with a markdown link using their exact `href` (e.g. [Name](href)).",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
      },
      required: ["champion"],
    },
  },
  {
    name: "my_performance",
    description:
      "The signed-in user's OWN recent form versus their season average: winrate, KDA and CS over their last ranked games compared to the season. ONLY call this when the user asks about THEIR OWN play ('how am I doing', 'am I improving', 'my recent form'). Takes no arguments — identity comes from the session.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "my_best_game",
    description:
      "The signed-in user's BEST recent ranked game — picks their standout match from the last ~20 (best performance, prioritising wins then KDA + impact) and the UI renders its full MATCH CARD to the user automatically. Call this when the user asks about their best/standout recent game ('what was my best game', 'mostrami il mio game migliore', 'my best recent match'). Takes no arguments — identity comes from the session. After calling, write a short 1-2 sentence compliment; do NOT describe the other players.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "patch_changes",
    description:
      "What changed in a recent PATCH — champion and item buffs/nerfs computed from the official game-data diff. Use this for ANY question about patch changes: 'was X buffed/nerfed', 'cosa è cambiato a X', 'what changed in patch 16.13', 'is X stronger this patch', 'recent changes to <item>'. Args (all optional): `champion` (that champion's changes across recent patches), `item` (an item's changes), `patch` (e.g. '16.13' → that patch's changelog); no args = the latest patch summary. Ground your answer ONLY in what it returns. The full visual changelog is on the /patch-notes page.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        item: { type: "string" },
        patch: { type: "string" },
      },
      required: [],
    },
  },
];

// ── executors ────────────────────────────────────────────────────────────────
// The log captures {name, input, output} per tool call so the route can derive
// rich `embeds` (rune page, match card) from real tool results afterwards.
export type ToolLogEntry = { name: string; input: any; output?: any };

export function makeExecutor(
  ctx: UserContext,
  log?: ToolLogEntry[]
): (name: string, input: any) => Promise<unknown> {
  return async (name, input) => {
    const entry: ToolLogEntry = { name, input };
    log?.push(entry);
    const run = async (): Promise<unknown> => {
      switch (name) {
        case "champion_overview":
          return championOverview(input);
        case "best_items":
          return bestItems(input);
        case "best_teammates":
          return bestTeammates(input);
        case "best_runes":
          return bestRunes(input);
        case "matchups":
          return matchups(input);
        case "champion_top_players":
          return championTopPlayers(input);
        case "my_performance":
          return myPerformance(ctx);
        case "my_best_game":
          return myBestGame(ctx, input);
        case "patch_changes":
          return patchChanges(input);
        default:
          return { error: `Unknown tool: ${name}` };
      }
    };
    const output = await run();
    entry.output = output;
    // Keep the model's context lean: `_embed` carries a rich UI payload (rune
    // page, match card) meant for the FRONTEND only. Keep it in the log (so the
    // route can collect embeds) but strip it from what the model reads.
    if (output && typeof output === "object" && (output as any)._embed !== undefined) {
      const { _embed, ...rest } = output as any;
      return rest;
    }
    return output;
  };
}

// Collect the rich embeds produced by the tools the agent ran (rune page, match
// card). Reads each log entry's captured output `_embed`. Deduped, capped.
export type AiEmbed =
  | { type: "rune_page"; data: AiRunePage }
  | { type: "match_card"; data: any };

export function collectEmbeds(log: ToolLogEntry[]): AiEmbed[] {
  const out: AiEmbed[] = [];
  const seen = new Set<string>();
  for (const e of log) {
    const emb = (e.output as any)?._embed;
    if (!emb || !emb.type) continue;
    const key =
      emb.type === "rune_page"
        ? `rune:${emb.data?.champion}:${emb.data?.role ?? ""}`
        : emb.type === "match_card"
        ? `match:${emb.data?.matchId}`
        : JSON.stringify(emb).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(emb);
  }
  return out.slice(0, 3);
}

async function championTopPlayers(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  // Reuse the champion page's exact OTP ranking: Master+ one-tricks ordered by
  // RANK (tier, then LP) — NOT by winrate. otps[0] is the best / highest-elo
  // player. This keeps the chatbot and the OTP page in lockstep, and stops the
  // old "highest winrate at lower elo" answer.
  const otps = await fetchChampionOtps(champ, "ALL", 8);
  if (!otps.length) {
    return {
      champion: champ,
      note: "No ranked one-trick (Master+) for this champion in our data yet — too few games, or no high-elo main found.",
    };
  }
  return {
    champion: champ,
    note: "The champion's ranked one-trick leaderboard (Master+), ordered by rank — highest elo first. players[0] IS the best one-trick; do not re-order by winrate.",
    players: otps.map((p: any) => ({
      rank: p.rank,
      name: p.name,
      tag: p.tag,
      elo: `${p.tier}${p.division ? " " + p.division : ""} ${p.lp} LP`.trim(),
      region: p.region,
      champGames: p.champGames,
      winrate: `${p.champWinrate}%`,
      href: summonerHref(p.name, p.tag, String(p.region).toLowerCase()),
    })),
  };
}

// Keystone + style id → display name (fixed set, rarely changes — no DDragon fetch).
const KEYSTONE_NAME: Record<number, string> = {
  8005: "Press the Attack", 8008: "Lethal Tempo", 8021: "Fleet Footwork", 8010: "Conqueror",
  8112: "Electrocute", 8124: "Predator", 8128: "Dark Harvest", 9923: "Hail of Blades",
  8214: "Summon Aery", 8229: "Arcane Comet", 8230: "Phase Rush",
  8437: "Grasp of the Undying", 8439: "Aftershock", 8465: "Guardian",
  8351: "Glacial Augment", 8360: "Unsealed Spellbook", 8369: "First Strike",
};
const STYLE_NAME: Record<number, string> = {
  8000: "Precision", 8100: "Domination", 8200: "Sorcery", 8300: "Inspiration", 8400: "Resolve",
};

async function bestRunes(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  const role = normRole(input?.role);
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");
    const ks = await client.query(
      `SELECT p.perk_keystone AS k, count(*)::int AS games,
              round(avg((p.win)::int) * 100, 1)::float8 AS winrate
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.champion_name = $1 AND m.queue_id = ANY($2) AND p.perk_keystone IS NOT NULL
          ${role ? "AND p.role = $3" : ""}
        GROUP BY p.perk_keystone
        ORDER BY games DESC LIMIT 5`,
      role ? [champ, QUEUES, role] : [champ, QUEUES]
    );
    if (!ks.rows.length) return { champion: champ, role: role ?? "main role", note: "Not enough games to rank keystones." };
    const total = ks.rows.reduce((s: number, r: any) => s + Number(r.games), 0) || 1;
    const tree = await client.query(
      `SELECT p.perk_primary_style AS prim, p.perk_sub_style AS sub, count(*)::int AS games
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.champion_name = $1 AND m.queue_id = ANY($2) AND p.perk_primary_style IS NOT NULL
          ${role ? "AND p.role = $3" : ""}
        GROUP BY p.perk_primary_style, p.perk_sub_style
        ORDER BY games DESC LIMIT 1`,
      role ? [champ, QUEUES, role] : [champ, QUEUES]
    );
    const t = tree.rows[0];
    // Full precise rune page → rendered as a standard rune tree in the chat.
    // Null when there's no precise-rune sample yet (a growing subset of games).
    const page = await fetchPreciseRunePage(champ, role);
    return {
      champion: champ,
      role: role ?? "main role",
      keystones: ks.rows.map((r: any) => ({
        keystone: KEYSTONE_NAME[Number(r.k)] ?? `keystone ${r.k}`,
        winrate: `${Number(r.winrate).toFixed(1)}%`,
        pickrate: `${((Number(r.games) / total) * 100).toFixed(0)}%`,
        games: Number(r.games),
      })),
      most_common_trees: t ? `${STYLE_NAME[Number(t.prim)] ?? t.prim} (primary) + ${STYLE_NAME[Number(t.sub)] ?? t.sub} (secondary)` : null,
      hint: page
        ? "The full rune page is shown to the user automatically as a rune tree. Lead with the highest-pickrate keystone and call out a notably higher-winrate alternative; DON'T list every rune in text."
        : "Lead with the highest-pickrate keystone as the default pick; call out a notably higher-winrate alternative if one stands out.",
      ...(page ? { _embed: { type: "rune_page", data: page } } : {}),
    };
  } finally {
    client.release();
  }
}

async function championOverview(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  const role = normRole(input?.role);
  const graph: ExplorerGraph = {
    subject: { champion: champ, ...(role ? { role } : {}) },
    filters: { scope: "all", queues: QUEUES },
    output: { kind: "stats" },
  };
  const rows = await runGraph(graph);
  const r = rows[0] ?? {};
  if (!Number(r.games)) return { champion: champ, role: role ?? "all", games: 0, note: "No games found for that champion/role." };
  return {
    champion: champ,
    role: role ?? "all roles",
    games: Number(r.games),
    winrate: `${Number(r.winrate).toFixed(1)}%`,
    avg_kda: `${Number(r.avg_kills).toFixed(1)}/${Number(r.avg_deaths).toFixed(1)}/${Number(r.avg_assists).toFixed(1)}`,
    avg_cs: Number(r.avg_cs),
    avg_gold: Number(r.avg_gold),
  };
}

async function bestItems(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  await warmItemData();
  const role = normRole(input?.role);

  const graph: ExplorerGraph = {
    subject: { champion: champ, ...(role ? { role } : {}) },
    filters: { scope: "all", queues: QUEUES },
    output: { kind: "rank", dimension: "item", limit: 12, minGames: 20, itemPool: buildItemPool() },
  };

  const cat = String(input?.vs_enemy_category ?? "").trim();
  if (cat && (CHAMP_CATEGORIES as string[]).includes(cat)) {
    const min = Math.max(1, Number(input?.vs_enemy_category_min) | 0 || 1);
    (graph as any).categories = [{ side: "enemy", cls: cat, min }];
  }
  const vsChampRaw = String(input?.vs_enemy_champion ?? "").trim();
  if (vsChampRaw) {
    const vs = await resolveChamp(vsChampRaw);
    if (vs) (graph as any).constraints = [{ type: "enemy", champion: vs }];
  }

  const rows = await runGraph(graph);
  if (!rows.length) return { champion: champ, condition: cat || vsChampRaw || "none", note: "Not enough games for this condition." };
  const cohort = Number(rows[0]?.cohort_games ?? 0);
  return {
    champion: champ,
    role: role ?? "main role",
    condition: cat ? `enemy has ${input?.vs_enemy_category_min || 1}+ ${cat}` : vsChampRaw ? `vs ${vsChampRaw}` : "all games",
    cohort_games: cohort,
    items: rows.map((x) => ({
      item: itemName(Number(x.dimension)),
      winrate: `${Number(x.winrate).toFixed(1)}%`,
      lift: `${Number(x.lift) >= 0 ? "+" : ""}${Number(x.lift).toFixed(1)}%`,
      games: Number(x.games),
    })),
  };
}

async function bestTeammates(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  let partnerRole = normRole(input?.partner_role);
  if (!partnerRole) {
    const classes = classesOf(champ);
    if (classes.includes("Marksman")) partnerRole = "UTILITY";
    else if (classes.includes("Support")) partnerRole = "BOTTOM";
  }
  const graph: ExplorerGraph = {
    subject: { champion: champ },
    filters: { scope: "all", queues: QUEUES },
    output: { kind: "rank", dimension: "ally", ...(partnerRole ? { role: partnerRole } : {}), limit: 15, minGames: 30 },
  };
  const rows = await runGraph(graph);
  if (!rows.length) return { champion: champ, note: "Not enough games to rank teammates." };
  return {
    champion: champ,
    partner_role: partnerRole ?? "any",
    cohort_games: Number(rows[0]?.cohort_games ?? 0),
    teammates: rows.map((x) => ({
      champion: String(x.dimension),
      winrate: `${Number(x.winrate).toFixed(1)}%`,
      lift: `${Number(x.lift) >= 0 ? "+" : ""}${Number(x.lift).toFixed(1)}%`,
      games: Number(x.games),
    })),
  };
}

async function matchups(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  const role = normRole(input?.role);
  const oppRaw = String(input?.opponent ?? "").trim();

  // Exact head-to-head: subject winrate in games where the enemy team has the opponent.
  if (oppRaw) {
    const opp = await resolveChamp(oppRaw);
    if (!opp) return { error: "unknown_champion", champion: oppRaw };
    const graph: ExplorerGraph = {
      subject: { champion: champ, ...(role ? { role } : {}) },
      constraints: [{ type: "enemy", champion: opp, ...(role ? { role } : {}) }] as any,
      filters: { scope: "all", queues: QUEUES },
      output: { kind: "stats" },
    };
    const rows = await runGraph(graph);
    const r = rows[0] ?? {};
    if (!Number(r.games)) return { subject: champ, opponent: opp, note: "Not enough games for this matchup." };
    return {
      subject: champ,
      opponent: opp,
      games: Number(r.games),
      subject_winrate: `${Number(r.winrate).toFixed(1)}%`,
      subject_avg_kda: `${Number(r.avg_kills).toFixed(1)}/${Number(r.avg_deaths).toFixed(1)}/${Number(r.avg_assists).toFixed(1)}`,
    };
  }

  // Favourable matchups (enemies the subject beats), confidence-weighted.
  const graph: ExplorerGraph = {
    subject: { champion: champ, ...(role ? { role } : {}) },
    filters: { scope: "all", queues: QUEUES },
    output: { kind: "rank", dimension: "enemy", limit: 12, minGames: 30 },
  };
  const rows = await runGraph(graph);
  if (!rows.length) return { champion: champ, note: "Not enough games to rank matchups." };
  return {
    champion: champ,
    role: role ?? "main role",
    note: "Most favourable matchups (enemies this champion beats most).",
    favourable: rows.map((x) => ({
      opponent: String(x.dimension),
      winrate: `${Number(x.winrate).toFixed(1)}%`,
      games: Number(x.games),
    })),
  };
}

async function myPerformance(ctx: UserContext) {
  if (!ctx?.puuid) {
    return { error: "not_linked", message: "The user is not signed in or has not linked a Riot account. Tell them to sign in and link their account to use this." };
  }
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");
    const recentRes = await client.query(
      `SELECT p.win, p.kills, p.deaths, p.assists, p.total_cs, p.champion_name
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.puuid = $1 AND m.queue_id = ANY($2)
        ORDER BY m.game_creation DESC
        LIMIT 20`,
      [ctx.puuid, QUEUES]
    );
    const seasonRes = await client.query(
      `SELECT count(*)::int AS n,
              round(avg((p.win)::int) * 100, 1)::float8 AS wr,
              round(avg(p.kills), 1)::float8 AS k,
              round(avg(p.deaths), 1)::float8 AS d,
              round(avg(p.assists), 1)::float8 AS a,
              round(avg(p.total_cs), 1)::float8 AS cs
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.puuid = $1 AND m.queue_id = ANY($2)`,
      [ctx.puuid, QUEUES]
    );

    const recent = recentRes.rows as any[];
    if (!recent.length) {
      return { name: ctx.nametag ?? "you", note: "No ranked games found in our database for this account yet — play a ranked game and refresh the profile page." };
    }
    const n = recent.length;
    const wins = recent.filter((g) => g.win).length;
    const sum = recent.reduce(
      (s, g) => ({ k: s.k + Number(g.kills), d: s.d + Number(g.deaths), a: s.a + Number(g.assists), cs: s.cs + Number(g.total_cs) }),
      { k: 0, d: 0, a: 0, cs: 0 }
    );
    const champCount = new Map<string, number>();
    for (const g of recent) champCount.set(g.champion_name, (champCount.get(g.champion_name) ?? 0) + 1);
    const topChamps = [...champCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, g]) => `${c} (${g})`);

    const s = seasonRes.rows[0] ?? {};
    return {
      name: ctx.nametag ?? "you",
      recent: {
        games: n,
        winrate: `${((wins / n) * 100).toFixed(1)}%`,
        avg_kda: `${(sum.k / n).toFixed(1)}/${(sum.d / n).toFixed(1)}/${(sum.a / n).toFixed(1)}`,
        avg_cs: Number((sum.cs / n).toFixed(1)),
        most_played: topChamps,
      },
      season: {
        games: Number(s.n ?? 0),
        winrate: `${Number(s.wr ?? 0).toFixed(1)}%`,
        avg_kda: `${Number(s.k ?? 0).toFixed(1)}/${Number(s.d ?? 0).toFixed(1)}/${Number(s.a ?? 0).toFixed(1)}`,
        avg_cs: Number(s.cs ?? 0),
      },
      hint: "Compare 'recent' to 'season' and tell the user whether they are trending up or down on winrate, KDA and CS. 'season' includes the recent games, so treat it as their typical baseline.",
    };
  } finally {
    client.release();
  }
}

// ── Precise full rune page (for the rune_page embed) ─────────────────────────
// Mirrors the precise-rune query in getChampionBuild.ts: the most-played full
// page for a champion (+ role) from the perk_*/stat_perks arrays. Returns null
// when the champion has no precise-rune sample yet (a growing subset of games).
export type AiRunePage = {
  champion: string;
  role: string | null;
  keystone: number;
  primaryStyle: number;
  subStyle: number;
  primary: number[];   // full primary tree perks (keystone + 3 minors)
  secondary: number[]; // 2 secondary-tree minors
  shards: number[];    // 3 stat shards
  games: number;
  winrate: number;
};

export async function fetchPreciseRunePage(champ: string, role: string | null): Promise<AiRunePage | null> {
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");
    const r = await client.query(
      `SELECT perk_keystone AS keystone, perk_primary_style AS primary_style, perk_sub_style AS sub_style,
              perk_primary, perk_secondary, stat_perks,
              count(*)::int AS games, round(avg((win)::int) * 100, 1)::float8 AS winrate
         FROM participants
        WHERE champion_name = $1 ${role ? "AND role = $2" : ""}
          AND perk_primary IS NOT NULL AND perk_primary_style IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6
        ORDER BY games DESC
        LIMIT 1`,
      role ? [champ, role] : [champ]
    );
    const p = (r.rows as any[])[0];
    if (!p) return null;
    return {
      champion: champ,
      role: role ?? null,
      keystone: Number(p.keystone),
      primaryStyle: Number(p.primary_style),
      subStyle: Number(p.sub_style),
      primary: ((p.perk_primary as number[]) ?? []).map(Number),
      secondary: ((p.perk_secondary as number[]) ?? []).map(Number),
      shards: ((p.stat_perks as number[]) ?? []).map(Number),
      games: Number(p.games),
      winrate: Number(p.winrate),
    };
  } finally {
    client.release();
  }
}

// ── "Best recent game" → full MatchCardData for the match_card embed ─────────
const QUEUE_LABEL: Record<number, string> = { 420: "Ranked Solo/Duo", 440: "Ranked Flex" };

// Map a Riot match-v5 object + the user's puuid into the frontend MatchCardData
// shape (the same fields the scout feed assembles), so <MatchCard> renders it.
function assembleMatchCard(match: any, puuid: string, region: string) {
  const info = match?.info ?? {};
  const meta = match?.metadata ?? {};
  const parts: any[] = info.participants ?? [];
  const me = parts.find((p) => p.puuid === puuid) ?? {};
  const platform = String(meta.matchId ?? "").split("_")[0] || null; // e.g. "EUW1"
  const items = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6].map((x) => Number(x ?? 0));
  const dur = Number(info.gameDuration ?? 0);
  return {
    matchId: meta.matchId ?? "",
    queueLabel: QUEUE_LABEL[Number(info.queueId)] ?? "Ranked",
    win: !!me.win,
    isRemake: dur > 0 && dur < 300,
    gameDurationSeconds: dur,
    gameCreationMs: Number(info.gameStartTimestamp ?? info.gameCreation ?? 0),
    championName: me.championName ?? "Unknown",
    championLevel: me.champLevel ?? null,
    keystoneId: me.perks?.styles?.[0]?.selections?.[0]?.perk ?? null,
    secondaryStyleId: me.perks?.styles?.[1]?.style ?? null,
    kills: Number(me.kills ?? 0),
    deaths: Number(me.deaths ?? 0),
    assists: Number(me.assists ?? 0),
    cs: Number(me.totalMinionsKilled ?? 0) + Number(me.neutralMinionsKilled ?? 0),
    role: me.teamPosition || me.individualPosition || null,
    gold: me.goldEarned ?? null,
    items,
    region: region.toUpperCase(),
    highlightPuuid: puuid,
    allParticipants: parts.map((p) => ({
      puuid: p.puuid,
      summonerName: p.riotIdGameName ?? p.summonerName ?? null,
      riotTagline: p.riotIdTagline ?? null,
      championName: p.championName ?? null,
      teamId: p.teamId ?? null,
      platform,
      win: !!p.win,
      kills: Number(p.kills ?? 0),
      deaths: Number(p.deaths ?? 0),
      assists: Number(p.assists ?? 0),
    })),
  };
}

async function myBestGame(ctx: UserContext, _input: any) {
  if (!ctx?.puuid || !ctx?.region) {
    return { error: "not_linked", message: "The user is not signed in or has not linked a Riot account. Tell them to sign in and link their account to use this." };
  }
  // 1. recent ranked games from the box (cheap, one query)
  const client = await explorerPool().connect();
  let rows: any[];
  try {
    await client.query("SET statement_timeout = 12000");
    const r = await client.query(
      `SELECT p.match_id, m.game_creation, p.champion_name, p.win, p.kills, p.deaths, p.assists
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.puuid = $1 AND m.queue_id = ANY($2)
        ORDER BY m.game_creation DESC
        LIMIT 20`,
      [ctx.puuid, QUEUES]
    );
    rows = r.rows as any[];
  } finally {
    client.release();
  }
  if (!rows.length) {
    return { note: "No recent ranked games found in our database for this account yet — play a ranked game and refresh the profile page." };
  }
  // 2. "best" = prioritise wins, then KDA + raw impact (kills + assists).
  const score = (g: any) => {
    const k = Number(g.kills) || 0, d = Number(g.deaths) || 0, a = Number(g.assists) || 0;
    const kda = (k + a) / Math.max(1, d);
    return (g.win ? 1000 : 0) + kda * 12 + (k + a);
  };
  const best = rows.slice().sort((x, y) => score(y) - score(x))[0];
  // 3. fetch that one match in full from Riot (all 10 players) + assemble the card.
  let card: any = null;
  try {
    const match = await getMatchDetails(best.match_id, ctx.region);
    card = assembleMatchCard(match, ctx.puuid, ctx.region);
  } catch {
    return { note: "Found your best recent game but couldn't load its full details right now — try again in a moment." };
  }
  // The full card goes to the frontend via `_embed` (stripped from the model's
  // view); the model only gets a short summary to write a compliment from.
  return {
    matchId: best.match_id,
    champion: best.champion_name,
    win: !!best.win,
    kda: `${best.kills}/${best.deaths}/${best.assists}`,
    note: "This IS the user's best recent ranked game and its match card is shown to them automatically. Write a short, specific 1-2 sentence compliment (champion, KDA, win/loss). Do NOT list the other 9 players or restate raw item ids.",
    _embed: { type: "match_card", data: card },
  };
}

// ── Patch changes (patch-awareness) ──────────────────────────────────────────
// Reads the computed `patch_changes` changelog (the diff of consecutive DDragon
// versions). Champion names match normalized, so "Kai'Sa" → entity_key "Kaisa".
async function patchChanges(input: any) {
  const champRaw = String(input?.champion ?? "").trim();
  const itemRaw = String(input?.item ?? "").trim();
  const patchRaw = String(input?.patch ?? "").trim();
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");
    const where: string[] = [];
    const params: any[] = [];
    if (champRaw) {
      const norm = champRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
      params.push(norm);
      where.push(`kind = 'champion' AND (regexp_replace(lower(entity_key),'[^a-z0-9]','','g') = $${params.length} OR regexp_replace(lower(entity_name),'[^a-z0-9]','','g') = $${params.length})`);
    } else if (itemRaw) {
      params.push(`%${itemRaw.toLowerCase()}%`);
      where.push(`kind = 'item' AND lower(entity_name) LIKE $${params.length}`);
    }
    if (patchRaw) {
      params.push(patchRaw.split(".").slice(0, 2).join(".")); // accept "16.13" or "16.13.1"
      where.push(`patch = $${params.length}`);
    }
    const r = await client.query(
      `SELECT patch, kind, entity_name, label, old_value, new_value, direction
         FROM patch_changes
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY patch DESC, kind, entity_name, field
        LIMIT ${champRaw || itemRaw ? 60 : 200}`,
      params
    );
    const rows = r.rows as any[];
    if (!rows.length) {
      const lp = await latestPatchVersion();
      return {
        note: champRaw || itemRaw
          ? `No tracked changes for ${champRaw || itemRaw}${patchRaw ? " in patch " + patchRaw : " in the recent patches we track"}.`
          : `No patch changelog available yet${lp ? " (latest tracked: " + lp + ")" : ""}.`,
      };
    }
    const fmtRow = (x: any) => ({ name: x.entity_name, change: `${x.label}: ${x.old_value} → ${x.new_value}`, direction: x.direction });
    if (champRaw || itemRaw) {
      const byPatch = new Map<string, any[]>();
      for (const x of rows) {
        if (!byPatch.has(x.patch)) byPatch.set(x.patch, []);
        byPatch.get(x.patch)!.push(fmtRow(x));
      }
      return {
        subject: rows[0].entity_name,
        patches: [...byPatch.entries()].map(([p, list]) => ({ patch: p, changes: list })),
        hint: "Say whether it was net buffed or nerfed in the most recent patch that touched it, then summarise the concrete changes. Don't invent anything beyond these.",
      };
    }
    // whole-patch changelog → summarise (the /patch-notes page shows the full list).
    const thePatch = rows[0].patch;
    const inPatch = rows.filter((x) => x.patch === thePatch);
    return {
      patch: thePatch,
      totals: {
        buffs: inPatch.filter((x) => x.direction === "buff").length,
        nerfs: inPatch.filter((x) => x.direction === "nerf").length,
        championRows: inPatch.filter((x) => x.kind === "champion").length,
        itemRows: inPatch.filter((x) => x.kind === "item").length,
      },
      championChanges: inPatch.filter((x) => x.kind === "champion").slice(0, 30).map(fmtRow),
      itemChanges: inPatch.filter((x) => x.kind === "item").slice(0, 20).map(fmtRow),
      note: "Summarise the patch at a high level (notable buffs/nerfs). The full changelog is on the /patch-notes page; keep it tight.",
    };
  } finally {
    client.release();
  }
}
