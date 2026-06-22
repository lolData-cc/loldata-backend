// src/server/explorer/champClass.ts
//
// Champion → class (Assassin / Fighter / Mage / Marksman / Support / Tank) and
// damage profile (AD / AP / Hybrid), sourced from Riot Data Dragon champion.json
// (the `tags` array for classes, the `info.attack`/`info.magic` ratings for the
// damage profile), loaded once and cached in memory.
//
// Powers two Explorer features:
//   1. Champion-CATEGORY constraints ("enemy team has ≥N assassins") — compile.ts
//      expands a category to the list of champion_names in it and counts the
//      relevant team's participants.
//   2. Conditional ITEM-STRENGTH analysis ("Death's Dance is +X% WR vs AD-heavy
//      comps") — itemStrength.ts buckets matches by enemy composition.
//
// `champion_name` in the `participants` table is Riot's `championName`, which is
// the Data Dragon champion id (e.g. "Kaisa", "MonkeyKing", "Belveth"). We match
// case/punctuation-insensitively to be safe across odd ids.

export type ChampClass =
  | "Assassin"
  | "Fighter"
  | "Mage"
  | "Marksman"
  | "Support"
  | "Tank";

export const CHAMP_CLASSES: ChampClass[] = [
  "Assassin",
  "Fighter",
  "Mage",
  "Marksman",
  "Support",
  "Tank",
];

export type DamageType = "AD" | "AP" | "Hybrid";
export type AttackType = "Melee" | "Ranged";

// The full set of champion CATEGORIES usable as Explorer team-comp filters and
// item-strength buckets: the 6 roster classes + damage profile (AD/AP) + attack
// type (Melee/Ranged). "Hybrid" damage is intentionally NOT exposed (too fuzzy).
export type ChampCategory = ChampClass | "AD" | "AP" | "Melee" | "Ranged";
export const EXTRA_CATEGORIES = ["AD", "AP", "Melee", "Ranged"] as const;
export const CHAMP_CATEGORIES: ChampCategory[] = [...CHAMP_CLASSES, ...EXTRA_CATEGORIES];

export type ChampInfo = { classes: ChampClass[]; damage: DamageType; attackType: AttackType };

const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
// championFull.json carries `tags` + `info` (like champion.json) PLUS `stats`,
// which is the only place attackrange (→ Melee/Ranged) lives in one fetch.
const championJsonUrl = (v: string) =>
  `https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/championFull.json`;

const VALID_CLASSES = new Set<string>(CHAMP_CLASSES);

/** Normalize a champion id/name for lookup: lowercase, strip non-alphanumerics. */
export function normChamp(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Graceful-degradation fallback for ~35 popular champions, used only if the
// Data Dragon fetch fails. The live fetch (below) is authoritative and covers
// the full roster — this just keeps category filters partially working offline.
const FALLBACK: Record<string, [ChampClass[], DamageType]> = {
  Aatrox: [["Fighter", "Tank"], "AD"],
  Ahri: [["Mage", "Assassin"], "AP"],
  Akali: [["Assassin"], "AP"],
  Ashe: [["Marksman", "Support"], "AD"],
  Caitlyn: [["Marksman"], "AD"],
  Darius: [["Fighter", "Tank"], "AD"],
  Ekko: [["Assassin", "Mage"], "AP"],
  Ezreal: [["Marksman", "Mage"], "Hybrid"],
  Fizz: [["Assassin", "Fighter"], "AP"],
  Garen: [["Fighter", "Tank"], "AD"],
  Jhin: [["Marksman", "Mage"], "AD"],
  Jinx: [["Marksman"], "AD"],
  Kaisa: [["Marksman"], "Hybrid"],
  Kassadin: [["Assassin", "Mage"], "AP"],
  Katarina: [["Assassin", "Mage"], "AP"],
  Khazix: [["Assassin"], "AD"],
  LeeSin: [["Fighter", "Assassin"], "AD"],
  Leona: [["Tank", "Support"], "AD"],
  Lucian: [["Marksman"], "AD"],
  Lux: [["Mage", "Support"], "AP"],
  Malphite: [["Tank", "Mage", "Fighter"], "Hybrid"],
  MasterYi: [["Assassin", "Fighter"], "AD"],
  MissFortune: [["Marksman"], "AD"],
  Nasus: [["Fighter", "Tank"], "AD"],
  Orianna: [["Mage", "Support"], "AP"],
  Riven: [["Fighter", "Assassin"], "AD"],
  Sett: [["Fighter", "Tank"], "AD"],
  Thresh: [["Support", "Fighter", "Tank"], "AD"],
  Vayne: [["Marksman", "Assassin"], "AD"],
  Veigar: [["Mage"], "AP"],
  Yasuo: [["Fighter", "Assassin"], "AD"],
  Yone: [["Assassin", "Fighter"], "AD"],
  Zed: [["Assassin"], "AD"],
  Ziggs: [["Mage"], "AP"],
  Zyra: [["Mage", "Support"], "AP"],
};

// normalized-id → info
let _byNorm: Map<string, ChampInfo> | null = null;
// class → list of canonical champion ids (DB champion_name form)
let _byClass: Map<ChampClass, string[]> | null = null;
let _loading: Promise<void> | null = null;

function damageFromInfo(attack: number, magic: number): DamageType {
  const a = Number(attack) || 0;
  const m = Number(magic) || 0;
  if (a >= m + 2) return "AD";
  if (m >= a + 2) return "AP";
  return "Hybrid";
}

// Melee champs sit at ~125–225 attackrange, ranged at ~425–650; nothing real
// falls in 250–400, so 300 is a clean split. (Gnar/Jayce/Nidalee use their base
// form's range from championFull.)
function attackTypeFromRange(range: number): AttackType {
  return (Number(range) || 0) >= 300 ? "Ranged" : "Melee";
}

function seedFallback(byNorm: Map<string, ChampInfo>, byClass: Map<ChampClass, string[]>) {
  for (const [id, [classes, damage]] of Object.entries(FALLBACK)) {
    // No attackrange in the static fallback → approximate: Marksmen + pure Mages
    // are ranged, everyone else melee. Only used in the rare ddragon-down path.
    const attackType: AttackType =
      classes.includes("Marksman") || (classes.includes("Mage") && !classes.includes("Assassin") && !classes.includes("Fighter") && !classes.includes("Tank"))
        ? "Ranged"
        : "Melee";
    byNorm.set(normChamp(id), { classes, damage, attackType });
    for (const c of classes) byClass.get(c)!.push(id);
  }
}

async function fetchDdragon(): Promise<void> {
  const byNorm = new Map<string, ChampInfo>();
  const byClass = new Map<ChampClass, string[]>();
  for (const c of CHAMP_CLASSES) byClass.set(c, []);

  try {
    const vRes = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(10_000) });
    const versions = (await vRes.json()) as string[];
    const version = versions?.[0];
    if (!version) throw new Error("no version");

    const cRes = await fetch(championJsonUrl(version), { signal: AbortSignal.timeout(15_000) });
    const json = (await cRes.json()) as { data: Record<string, any> };
    const data = json?.data ?? {};

    let count = 0;
    for (const id of Object.keys(data)) {
      const c = data[id];
      const classes = (Array.isArray(c?.tags) ? c.tags : []).filter((t: string) =>
        VALID_CLASSES.has(t)
      ) as ChampClass[];
      if (classes.length === 0) continue;
      const damage = damageFromInfo(c?.info?.attack, c?.info?.magic);
      const attackType = attackTypeFromRange(c?.stats?.attackrange);
      const canonical = String(c?.id ?? id);
      byNorm.set(normChamp(canonical), { classes, damage, attackType });
      for (const cls of classes) byClass.get(cls)!.push(canonical);
      count++;
    }

    if (count < 50) {
      // suspiciously small payload — backfill with the fallback so we don't ship
      // a half-empty map
      seedFallback(byNorm, byClass);
    }
    _byNorm = byNorm;
    _byClass = byClass;
    console.log(`[champClass] loaded ${count} champions (v${version})`);
  } catch (e) {
    // Data Dragon unreachable → use the static fallback so category filters still
    // work for the popular roster. Logged, not thrown.
    seedFallback(byNorm, byClass);
    _byNorm = byNorm;
    _byClass = byClass;
    console.warn(
      `[champClass] Data Dragon fetch failed, using fallback (${byNorm.size} champs):`,
      (e as Error)?.message ?? e
    );
  }
}

/** Kick off the load (call once at server boot). Idempotent. */
export function warmChampClasses(): Promise<void> {
  if (_byNorm) return Promise.resolve();
  if (!_loading) _loading = fetchDdragon();
  return _loading;
}

/** True once the map is populated (from either Data Dragon or the fallback). */
export function champClassesReady(): boolean {
  return _byNorm != null && _byNorm.size > 0;
}

/** Classes for a champion_name, or [] if unknown / not yet loaded. */
export function classesOf(championName: string): ChampClass[] {
  return _byNorm?.get(normChamp(championName))?.classes ?? [];
}

/** Damage profile for a champion_name, or null if unknown / not yet loaded. */
export function damageOf(championName: string): DamageType | null {
  return _byNorm?.get(normChamp(championName))?.damage ?? null;
}

/**
 * Canonical champion_name ids that belong to `cls`. Used by the compiler to turn
 * a category constraint into `champion_name = ANY(<list>)`. Returns [] if the map
 * isn't loaded yet (the constraint then no-ops, which is the safe default).
 */
export function championsInClass(cls: ChampClass): string[] {
  return _byClass?.get(cls) ? [..._byClass.get(cls)!] : [];
}

/** All champion_name ids whose damage profile is `dmg` (e.g. "AD"). */
export function championsByDamage(dmg: DamageType): string[] {
  if (!_byNorm) return [];
  const out: string[] = [];
  // _byNorm keys are normalized; we need canonical ids, so derive from _byClass’s
  // canonical lists (union) filtered by damage. Build once per call (small roster).
  const seen = new Set<string>();
  for (const list of _byClass?.values() ?? []) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (_byNorm.get(normChamp(id))?.damage === dmg) out.push(id);
    }
  }
  return out;
}

/** All champion_name ids whose attack type is `at` ("Melee"/"Ranged"). */
export function championsByAttackType(at: AttackType): string[] {
  if (!_byNorm) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of _byClass?.values() ?? []) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (_byNorm.get(normChamp(id))?.attackType === at) out.push(id);
    }
  }
  return out;
}

/** Attack type for a champion_name, or null if unknown / not yet loaded. */
export function attackTypeOf(championName: string): AttackType | null {
  return _byNorm?.get(normChamp(championName))?.attackType ?? null;
}

/**
 * Unified resolver: canonical champion_name ids for ANY category — a roster class
 * (Assassin…Tank), a damage profile (AD/AP), or an attack type (Melee/Ranged).
 * Used by compile.ts (team-comp constraints) and itemStrength.ts (buckets).
 */
export function categoryMembers(category: string): string[] {
  if ((CHAMP_CLASSES as string[]).includes(category)) return championsInClass(category as ChampClass);
  if (category === "AD" || category === "AP") return championsByDamage(category);
  if (category === "Melee" || category === "Ranged") return championsByAttackType(category);
  return [];
}

/** True if `category` is a recognised champion category (class / AD / AP / Melee / Ranged). */
export function isChampCategory(category: string): category is ChampCategory {
  return (CHAMP_CATEGORIES as string[]).includes(category);
}

export const ALL_CHAMP_CLASSES = CHAMP_CLASSES;
