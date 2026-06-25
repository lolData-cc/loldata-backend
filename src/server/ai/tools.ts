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
      "Top-performing players on a champion in our data: in-game name/tag, winrate, games, region, plus a ready-made `href` to each player's profile page. Use this to name a strong player to follow for a champion, or to answer 'who is the best/strongest <champion> player'. When you cite a player, link them with a markdown link using their exact `href` (e.g. [Name](href)). These are top performers in our sample — for the authoritative ranked one-trick list, the UI will offer a button to the champion's players page.",
    input_schema: {
      type: "object",
      properties: {
        champion: { type: "string" },
        role: { type: "string", enum: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] },
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
];

// ── executors ────────────────────────────────────────────────────────────────
export function makeExecutor(
  ctx: UserContext,
  log?: { name: string; input: any }[]
): (name: string, input: any) => Promise<unknown> {
  return async (name, input) => {
    log?.push({ name, input });
    switch (name) {
      case "champion_overview":
        return championOverview(input);
      case "best_items":
        return bestItems(input);
      case "best_teammates":
        return bestTeammates(input);
      case "matchups":
        return matchups(input);
      case "champion_top_players":
        return championTopPlayers(input);
      case "my_performance":
        return myPerformance(ctx);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
}

async function championTopPlayers(input: any) {
  const champ = await resolveChamp(String(input?.champion ?? ""));
  if (!champ) return { error: "unknown_champion", champion: input?.champion };
  const role = normRole(input?.role);
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");
    const r = await client.query(
      `SELECT p.riot_id_game_name AS name, p.riot_id_tagline AS tag,
              count(*)::int AS games,
              round(avg((p.win)::int) * 100, 1)::float8 AS winrate,
              (array_agg(m.platform ORDER BY m.game_creation DESC))[1] AS platform
         FROM participants p JOIN matches m ON m.match_id = p.match_id
        WHERE p.champion_name = $1
          AND p.riot_id_game_name IS NOT NULL AND p.riot_id_game_name <> ''
          AND m.queue_id = ANY($2)
          ${role ? "AND p.role = $4" : ""}
        GROUP BY p.riot_id_game_name, p.riot_id_tagline
        HAVING count(*) >= $3
        ORDER BY avg((p.win)::int) DESC, count(*) DESC
        LIMIT 8`,
      role ? [champ, QUEUES, 20, role] : [champ, QUEUES, 20]
    );
    if (!r.rows.length) {
      return { champion: champ, note: "Not enough tracked games to surface standout players for this champion yet." };
    }
    return {
      champion: champ,
      note: "Top performers in our sample (by winrate); the UI offers a button to the full ranked one-trick list.",
      players: r.rows.map((x: any) => {
        const region = regionFromPlatform(x.platform);
        return {
          name: x.name,
          tag: x.tag,
          region,
          games: Number(x.games),
          winrate: `${Number(x.winrate).toFixed(1)}%`,
          href: summonerHref(x.name, x.tag, region),
        };
      }),
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
