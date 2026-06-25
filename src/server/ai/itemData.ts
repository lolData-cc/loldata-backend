// src/server/ai/itemData.ts
//
// Data Dragon item.json loader for the AI tools: an id→name map (so answers name
// items instead of printing raw ids) and the set of COMPLETED build items
// (legendaries + boots + finished starters, minus components / consumables /
// trinkets). The Explorer item-ranking needs that pool — without it the ranking
// falls back to "any non-empty slot" and surfaces components/wards. Loaded once
// from DDragon and cached; a tiny built-in fallback keeps it usable if the fetch
// fails (the ranking just widens to all non-empty slots).

const VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
const itemJsonUrl = (v: string) =>
  `https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/item.json`;

let _names: Map<number, string> | null = null;
let _pool: number[] = [];
let _loading: Promise<void> | null = null;

async function fetchItems(): Promise<void> {
  const names = new Map<number, string>();
  const pool: number[] = [];
  try {
    const vRes = await fetch(VERSIONS_URL, { signal: AbortSignal.timeout(10_000) });
    const versions = (await vRes.json()) as string[];
    const version = versions?.[0];
    if (!version) throw new Error("no version");

    const iRes = await fetch(itemJsonUrl(version), { signal: AbortSignal.timeout(15_000) });
    const json = (await iRes.json()) as { data: Record<string, any> };
    const data = json?.data ?? {};

    for (const idStr of Object.keys(data)) {
      const id = Number(idStr);
      const it = data[idStr];
      if (!Number.isFinite(id) || !it?.name) continue;
      names.set(id, String(it.name));

      // A "completed" build item = purchasable, on Summoner's Rift, not a
      // consumable/trinket, and NOT a component (components always have an
      // `into` array). This keeps legendaries, boots and finished starters,
      // and drops Long Sword / potions / wards / control wards / trinkets.
      const onSR = it?.maps?.["11"] === true;
      const purchasable = it?.gold?.purchasable === true;
      const total = Number(it?.gold?.total) || 0;
      const isComponent = Array.isArray(it?.into) && it.into.length > 0;
      const consumable = it?.consumed === true || it?.consumeOnFull === true;
      const tags: string[] = Array.isArray(it?.tags) ? it.tags : [];
      const trinket = tags.includes("Trinket");
      if (onSR && purchasable && !isComponent && !consumable && !trinket && total >= 800) {
        pool.push(id);
      }
    }

    _names = names;
    _pool = pool;
    console.log(`[itemData] loaded ${names.size} items, ${pool.length} build items (v${version})`);
  } catch (e) {
    _names = names; // possibly empty
    _pool = pool;
    console.warn("[itemData] Data Dragon item fetch failed:", (e as Error)?.message ?? e);
  }
}

/** Kick off the load (idempotent). Call at boot, or it lazy-loads on first use. */
export function warmItemData(): Promise<void> {
  if (_names) return Promise.resolve();
  if (!_loading) _loading = fetchItems();
  return _loading;
}

/** Item name for an id, or "Item <id>" if unknown / not yet loaded. */
export function itemName(id: number): string {
  return _names?.get(Number(id)) ?? `Item ${id}`;
}

/**
 * Completed-build item ids to rank within. Empty → caller omits `itemPool` and
 * the Explorer ranking widens to all non-empty slots (noisier, but works).
 */
export function buildItemPool(): number[] {
  return _pool.length ? [..._pool] : [];
}
