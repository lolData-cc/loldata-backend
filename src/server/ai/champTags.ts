// src/server/ai/champTags.ts
//
// Curated champion tags that Data Dragon's class data doesn't carry: reliable
// HARD CC (where tenacity / Mercury's Treads matters) and hard ENGAGE (the
// initiators a team plays around). Used by timelineAnalysis.ts to categorize the
// two comps so the AI can reason about matchup-aware itemization and win
// conditions. Keyed by normalized champion id (normChamp) — values are Data
// Dragon ids (e.g. Wukong = "MonkeyKing", Cho'Gath = "Chogath").

import { normChamp } from "../explorer/champClass";

// Champions with reliable, hard, mostly point-and-click or unavoidable CC
// (stun / root / knock-up / suppress / long lockdown). 3+ of these on a team =
// a genuinely CC-heavy comp → Mercs/tenacity is usually worth it.
const HEAVY_CC_LIST = [
  // top / jungle / fighters & tanks
  "Amumu", "Sejuani", "Maokai", "Zac", "Skarner", "Vi", "JarvanIV", "MonkeyKing", "Hecarim", "Gragas",
  "Nunu", "Rammus", "Warwick", "Volibear", "Sett", "Ornn", "Malphite", "Sion", "Galio", "Poppy",
  "Gnar", "Chogath", "Trundle", "Shen", "Jax", "Renekton", "Pantheon", "Riven", "Camille", "Diana",
  "Kennen", "Fiddlesticks", "Nocturne", "Elise", "Rell", "KSante", "Mordekaiser", "Nautilus", "Lillia",
  // mid mages
  "Annie", "Veigar", "Syndra", "Lissandra", "Cassiopeia", "TwistedFate", "Taliyah", "Ahri", "Lux",
  "Neeko", "Zoe", "Orianna", "Ryze", "Anivia", "Brand", "Zyra", "Swain", "Seraphine",
  // supports / enchanters w/ hard CC
  "Leona", "Thresh", "Blitzcrank", "Pyke", "Rakan", "Alistar", "Braum", "Nami", "Sona", "Bard",
  "Renata", "Zilean", "Lulu", "Morgana",
  // marksmen w/ reliable CC
  "Ashe", "Varus", "Jhin", "Senna",
];

// Champions that hard-ENGAGE / initiate — the playmakers a team builds fights
// around (when they're not behind).
const ENGAGE_LIST = [
  "Malphite", "Amumu", "JarvanIV", "Leona", "Nautilus", "Sejuani", "Zac", "Rell", "Hecarim", "Vi",
  "MonkeyKing", "Sion", "Ornn", "Maokai", "Rakan", "Alistar", "Galio", "Kennen", "Diana", "Camille",
  "Skarner", "Pantheon", "Gragas", "Nocturne", "Gnar", "Shen", "Poppy", "Lissandra", "Fiddlesticks",
  "Nunu", "Volibear", "KSante",
];

export const HEAVY_CC = new Set(HEAVY_CC_LIST.map(normChamp));
export const ENGAGE = new Set(ENGAGE_LIST.map(normChamp));
