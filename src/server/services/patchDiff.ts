// src/server/services/patchDiff.ts
//
// Patch-awareness engine. Riot has no patch-notes API, but Data Dragon keeps
// EVERY historical version and each version's champion/item JSON carries the
// numbers that change between patches. So we COMPUTE the changelog by diffing
// consecutive versions — reliable, no scraping, auto-updates each patch.
//
// Per version we pull just 3 files: championFull.json (all champs' stats +
// spells), item.json, runesReforged.json. We diff (prev → cur), classify each
// delta as buff / nerf / adjust via a per-field polarity map, and upsert the
// rows into `patch_changes`. The AI tool + the /patch-notes page read from there.
// Optional prose (the designer's "why") is scraped separately into `patch_prose`.

import { explorerPool } from "../explorer/pool";

const DDRAGON = "https://ddragon.leagueoflegends.com";

// polarity: +1 ⇒ a HIGHER value is a buff, -1 ⇒ a higher value is a nerf.
const CHAMP_STAT: Record<string, { label: string; pol: number }> = {
  hp: { label: "Base Health", pol: 1 },
  hpperlevel: { label: "Health / level", pol: 1 },
  hpregen: { label: "Health Regen", pol: 1 },
  hpregenperlevel: { label: "HP Regen / level", pol: 1 },
  mp: { label: "Base Mana", pol: 1 },
  mpperlevel: { label: "Mana / level", pol: 1 },
  mpregen: { label: "Mana Regen", pol: 1 },
  armor: { label: "Armor", pol: 1 },
  armorperlevel: { label: "Armor / level", pol: 1 },
  spellblock: { label: "Magic Resist", pol: 1 },
  spellblockperlevel: { label: "Magic Resist / level", pol: 1 },
  attackdamage: { label: "Attack Damage", pol: 1 },
  attackdamageperlevel: { label: "AD / level", pol: 1 },
  attackspeed: { label: "Attack Speed", pol: 1 },
  attackspeedperlevel: { label: "Attack Speed / level", pol: 1 },
  attackrange: { label: "Attack Range", pol: 1 },
  movespeed: { label: "Move Speed", pol: 1 },
  crit: { label: "Crit", pol: 1 },
  critperlevel: { label: "Crit / level", pol: 1 },
};

// per-spell numeric "burn" strings (e.g. "14/12/10/8/6"). Lower cooldown/cost = buff.
const SPELL_FIELD: Record<string, { label: string; pol: number }> = {
  cooldownBurn: { label: "Cooldown", pol: -1 },
  costBurn: { label: "Cost", pol: -1 },
  rangeBurn: { label: "Range", pol: 1 },
};
const SLOT = ["Q", "W", "E", "R"];

type Change = {
  kind: "champion" | "item" | "rune";
  entityKey: string;
  entityName: string;
  field: string;
  label: string;
  oldValue: string;
  newValue: string;
  direction: "buff" | "nerf" | "adjust";
};

// average of a "a/b/c" burn string → number (for direction on per-rank values).
function burnAvg(s: string): number | null {
  if (s == null) return null;
  const parts = String(s).split("/").map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x));
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function classify(oldN: number | null, newN: number | null, pol: number): "buff" | "nerf" | "adjust" {
  if (oldN == null || newN == null || oldN === newN) return "adjust";
  const higher = newN > oldN;
  return (higher ? pol : -pol) > 0 ? "buff" : "nerf";
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function ddragonVersions(): Promise<string[]> {
  const v = await fetchJson(`${DDRAGON}/api/versions.json`);
  return Array.isArray(v) ? v : [];
}

// "16.13.1" → "16.13" (the patch label users know).
export function patchLabel(version: string): string {
  const p = String(version).split(".");
  return p.length >= 2 ? `${p[0]}.${p[1]}` : version;
}

// ── champion diff ────────────────────────────────────────────────────────────
function diffChampions(prev: any, cur: any): Change[] {
  const out: Change[] = [];
  const pc = prev?.data ?? {};
  const cc = cur?.data ?? {};
  for (const key of Object.keys(cc)) {
    const a = pc[key];
    const b = cc[key];
    if (!a || !b) continue; // new champ (no prev) → skip stat diff
    const name = b.name ?? key;
    // base stats
    for (const [f, meta] of Object.entries(CHAMP_STAT)) {
      const ov = a.stats?.[f];
      const nv = b.stats?.[f];
      if (ov == null || nv == null) continue;
      if (Number(ov) !== Number(nv)) {
        out.push({
          kind: "champion", entityKey: key, entityName: name,
          field: `stats.${f}`, label: meta.label,
          oldValue: String(ov), newValue: String(nv),
          direction: classify(Number(ov), Number(nv), meta.pol),
        });
      }
    }
    // spells (match by slot index; ult = R)
    const aS = a.spells ?? [];
    const bS = b.spells ?? [];
    for (let i = 0; i < Math.min(bS.length, 4); i++) {
      const as = aS[i];
      const bs = bS[i];
      if (!as || !bs) continue;
      for (const [f, meta] of Object.entries(SPELL_FIELD)) {
        const ov = as[f];
        const nv = bs[f];
        if (ov == null || nv == null) continue;
        if (String(ov) !== String(nv)) {
          out.push({
            kind: "champion", entityKey: key, entityName: name,
            field: `${SLOT[i]}.${f.replace("Burn", "")}`,
            label: `${SLOT[i]} ${meta.label}`,
            oldValue: String(ov), newValue: String(nv),
            direction: classify(burnAvg(ov), burnAvg(nv), meta.pol),
          });
        }
      }
    }
  }
  return out;
}

// ── item diff ────────────────────────────────────────────────────────────────
function prettyStat(k: string): string {
  // FlatPhysicalDamageMod → "Attack Damage", PercentAttackSpeedMod → "Attack Speed", …
  const map: Record<string, string> = {
    FlatPhysicalDamageMod: "Attack Damage",
    FlatMagicDamageMod: "Ability Power",
    FlatHPPoolMod: "Health",
    FlatMPPoolMod: "Mana",
    FlatArmorMod: "Armor",
    FlatSpellBlockMod: "Magic Resist",
    PercentAttackSpeedMod: "Attack Speed",
    FlatCritChanceMod: "Crit Chance",
    FlatMovementSpeedMod: "Move Speed",
    PercentMovementSpeedMod: "Move Speed %",
    FlatHPRegenMod: "Health Regen",
    PercentLifeStealMod: "Life Steal",
  };
  return map[k] ?? k.replace(/^(Flat|Percent)/, "").replace(/Mod$/, "").replace(/([A-Z])/g, " $1").trim();
}

function diffItems(prev: any, cur: any): Change[] {
  const out: Change[] = [];
  const pi = prev?.data ?? {};
  const ci = cur?.data ?? {};
  for (const id of Object.keys(ci)) {
    const a = pi[id];
    const b = ci[id];
    if (!a || !b) continue;
    if (b.gold?.purchasable === false) continue; // skip non-purchasable
    // Summoner's Rift only (map 11). DDragon item.json bundles Arena / special
    // variants (e.g. Eclipse as id 226692) whose ids won't match SR match data
    // and would pollute the changelog. SR items carry maps["11"] === true.
    if (b.maps && b.maps["11"] === false) continue;
    const name = b.name ?? id;
    // gold (cheaper = buff)
    if (a.gold?.total != null && b.gold?.total != null && a.gold.total !== b.gold.total) {
      out.push({
        kind: "item", entityKey: id, entityName: name,
        field: "gold.total", label: "Total Cost",
        oldValue: String(a.gold.total), newValue: String(b.gold.total),
        direction: classify(Number(a.gold.total), Number(b.gold.total), -1),
      });
    }
    // stats (more = buff)
    const keys = new Set([...Object.keys(a.stats ?? {}), ...Object.keys(b.stats ?? {})]);
    for (const k of keys) {
      const ov = a.stats?.[k];
      const nv = b.stats?.[k];
      if (Number(ov ?? 0) === Number(nv ?? 0)) continue;
      out.push({
        kind: "item", entityKey: id, entityName: name,
        field: `stats.${k}`, label: prettyStat(k),
        oldValue: ov == null ? "—" : String(ov),
        newValue: nv == null ? "—" : String(nv),
        direction: classify(Number(ov ?? 0), Number(nv ?? 0), 1),
      });
    }
  }
  return out;
}

// ── persistence ────────────────────────────────────────────────────────────
let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      const c = await explorerPool().connect();
      try {
        await c.query(`
          CREATE TABLE IF NOT EXISTS patch_changes (
            id bigserial PRIMARY KEY,
            patch text NOT NULL,
            prev_patch text,
            kind text NOT NULL,
            entity_key text NOT NULL,
            entity_name text NOT NULL,
            field text NOT NULL,
            label text NOT NULL,
            old_value text,
            new_value text,
            direction text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (patch, kind, entity_key, field)
          );
          CREATE INDEX IF NOT EXISTS idx_patch_changes_patch ON patch_changes (patch);
          CREATE INDEX IF NOT EXISTS idx_patch_changes_entity ON patch_changes (kind, entity_key);
          CREATE TABLE IF NOT EXISTS patch_prose (
            patch text NOT NULL,
            kind text NOT NULL,
            entity_key text NOT NULL,
            summary text,
            PRIMARY KEY (patch, kind, entity_key)
          );
          CREATE TABLE IF NOT EXISTS patch_diff_runs (
            patch text PRIMARY KEY,
            prev_patch text,
            change_count int,
            computed_at timestamptz NOT NULL DEFAULT now()
          );
        `);
      } finally {
        c.release();
      }
    })().catch((e) => { _ensured = null; throw e; });
  }
  return _ensured;
}

async function persist(patch: string, prevPatch: string, changes: Change[]): Promise<void> {
  await ensure();
  const c = await explorerPool().connect();
  try {
    await c.query("BEGIN");
    // clean-replace this patch's rows so a recompute drops anything now-excluded.
    await c.query(`DELETE FROM patch_changes WHERE patch = $1`, [patch]);
    for (const ch of changes) {
      await c.query(
        `INSERT INTO patch_changes (patch, prev_patch, kind, entity_key, entity_name, field, label, old_value, new_value, direction)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (patch, kind, entity_key, field)
         DO UPDATE SET old_value = EXCLUDED.old_value, new_value = EXCLUDED.new_value,
                       direction = EXCLUDED.direction, label = EXCLUDED.label, entity_name = EXCLUDED.entity_name`,
        [patch, prevPatch, ch.kind, ch.entityKey, ch.entityName, ch.field, ch.label, ch.oldValue, ch.newValue, ch.direction]
      );
    }
    await c.query(
      `INSERT INTO patch_diff_runs (patch, prev_patch, change_count) VALUES ($1,$2,$3)
       ON CONFLICT (patch) DO UPDATE SET prev_patch = EXCLUDED.prev_patch, change_count = EXCLUDED.change_count, computed_at = now()`,
      [patch, prevPatch, changes.length]
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Fetch both versions + diff (no DB). Pure — used to verify data quality too. */
export async function computeChanges(prevVersion: string, curVersion: string): Promise<Change[]> {
  const [pChamp, cChamp, pItem, cItem] = await Promise.all([
    fetchJson(`${DDRAGON}/cdn/${prevVersion}/data/en_US/championFull.json`),
    fetchJson(`${DDRAGON}/cdn/${curVersion}/data/en_US/championFull.json`),
    fetchJson(`${DDRAGON}/cdn/${prevVersion}/data/en_US/item.json`),
    fetchJson(`${DDRAGON}/cdn/${curVersion}/data/en_US/item.json`),
  ]);
  const changes: Change[] = [];
  if (pChamp && cChamp) changes.push(...diffChampions(pChamp, cChamp));
  if (pItem && cItem) changes.push(...diffItems(pItem, cItem));
  return changes;
}

// ── prose enrichment (best-effort scrape of the official patch notes) ────────
// Riot's marketing patch number differs from DDragon's (2025+ is year-based:
// DDragon "16.13" ↔ notes "26.13"/"25.13"), and the pages are JS-ish + bot-shy.
// So we try a few major candidates for the same MINOR and — crucially — only
// attach a champion's blurb when that champion's name actually appears on the
// fetched page, so a wrong-patch page can never attach false prose.
const PROSE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ").trim();
}

export async function ingestPatchProse(ddragonVersion: string, names: { key: string; name: string }[]): Promise<number> {
  if (!names.length) return 0;
  const [maj, min] = ddragonVersion.split(".");
  const M = parseInt(maj, 10);
  // try the 2026 (M+10), 2025 (M+9) and legacy (M) majors for this minor.
  const candidates = [M + 10, M + 9, M].map((x) => `patch-${x}-${min}-notes`);
  let html: string | null = null;
  for (const slug of candidates) {
    try {
      const r = await fetch(`https://www.leagueoflegends.com/en-us/news/game-updates/${slug}/`, { headers: { "User-Agent": PROSE_UA } });
      if (!r.ok) continue;
      const h = await r.text();
      if (h.length > 5000 && names.some((n) => h.includes(n.name))) { html = h; break; }
    } catch { /* try next */ }
  }
  if (!html) return 0;
  await ensure();
  const c = await explorerPool().connect();
  let n = 0;
  try {
    const patch = patchLabel(ddragonVersion);
    for (const { key, name } of names) {
      const idx = html.indexOf(name);
      if (idx < 0) continue;
      const m = html.slice(idx, idx + 4000).match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
      const summary = m ? stripTags(m[1]).slice(0, 600) : "";
      if (summary.length < 12) continue;
      await c.query(
        `INSERT INTO patch_prose (patch, kind, entity_key, summary) VALUES ($1,'champion',$2,$3)
         ON CONFLICT (patch, kind, entity_key) DO UPDATE SET summary = EXCLUDED.summary`,
        [patch, key, summary]
      );
      n++;
    }
  } finally {
    c.release();
  }
  return n;
}

/** Compute + store the diff between two DDragon versions (curVersion is the new patch). */
export async function ingestPatchDiff(prevVersion: string, curVersion: string): Promise<number> {
  const changes = await computeChanges(prevVersion, curVersion);
  await persist(patchLabel(curVersion), patchLabel(prevVersion), changes);
  // best-effort champion prose (never fatal; only attaches when the champ is on the page).
  try {
    const names = [
      ...new Map(
        changes.filter((c) => c.kind === "champion").map((c) => [c.entityKey, { key: c.entityKey, name: c.entityName }])
      ).values(),
    ];
    const pn = await ingestPatchProse(curVersion, names);
    if (pn) console.log(`[patch-diff] ${patchLabel(curVersion)}: +${pn} prose blurbs`);
  } catch { /* prose is optional */ }
  return changes.length;
}

/** Ensure the last `count` patch transitions are computed (idempotent, skips done). */
export async function ensureRecentPatchDiffs(count = 4): Promise<void> {
  await ensure();
  const versions = await ddragonVersions();
  if (versions.length < 2) return;
  const c = await explorerPool().connect();
  let done: Set<string>;
  try {
    const r = await c.query(`SELECT patch FROM patch_diff_runs`);
    done = new Set((r.rows as any[]).map((x) => x.patch));
  } finally {
    c.release();
  }
  // versions[0] is newest. pair (versions[i+1] → versions[i]).
  for (let i = 0; i < Math.min(count, versions.length - 1); i++) {
    const cur = versions[i];
    const prev = versions[i + 1];
    if (done.has(patchLabel(cur))) continue;
    try {
      const n = await ingestPatchDiff(prev, cur);
      console.log(`[patch-diff] ${patchLabel(prev)} → ${patchLabel(cur)}: ${n} changes`);
    } catch (e) {
      console.warn(`[patch-diff] ${patchLabel(cur)} failed:`, (e as any)?.message ?? e);
    }
  }
}

// ── reads (for the API + the AI tool) ────────────────────────────────────────
export async function latestPatch(): Promise<string | null> {
  await ensure();
  const c = await explorerPool().connect();
  try {
    const r = await c.query(`SELECT patch FROM patch_diff_runs ORDER BY computed_at DESC LIMIT 1`);
    return (r.rows as any[])[0]?.patch ?? null;
  } finally {
    c.release();
  }
}

export async function listPatches(): Promise<string[]> {
  await ensure();
  const c = await explorerPool().connect();
  try {
    // newest patch first by NUMBER (16.13 > 16.12 > 16.9), not by compute time.
    const r = await c.query(
      `SELECT patch FROM patch_diff_runs
        ORDER BY string_to_array(patch, '.')::int[] DESC`
    );
    return (r.rows as any[]).map((x) => x.patch);
  } finally {
    c.release();
  }
}

// Compact net-direction map for the LATEST patch — powers the small buff/nerf/
// adjust badge on every champion + item icon across the site. Net per entity:
// more buffs than nerfs → "buff", more nerfs → "nerf", otherwise "adjust".
export async function latestPatchMap(): Promise<{ patch: string | null; champions: Record<string, string>; items: Record<string, string> }> {
  const patches = await listPatches();
  const patch = patches[0] ?? null;
  if (!patch) return { patch: null, champions: {}, items: {} };
  const rows = await patchChangesFor({ patch, limit: 5000 });
  const agg = (kind: string): Record<string, string> => {
    const tally: Record<string, { b: number; n: number }> = {};
    for (const r of rows) {
      if (r.kind !== kind) continue;
      if (!tally[r.entity_key]) tally[r.entity_key] = { b: 0, n: 0 };
      if (r.direction === "buff") tally[r.entity_key].b++;
      else if (r.direction === "nerf") tally[r.entity_key].n++;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(tally)) out[k] = v.b > v.n ? "buff" : v.n > v.b ? "nerf" : "adjust";
    return out;
  };
  return { patch, champions: agg("champion"), items: agg("item") };
}

// Detailed per-entity change list for the LATEST patch — powers the hover
// tooltip on each buff/nerf badge. Champions are keyed by a normalized id
// (lowercase, alnum-only) to match the frontend's lookup; items by their id.
const _normChamp = (s: string | number) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
type ChangeDetail = { label: string; old: string | null; new: string | null; direction: string };
export async function latestPatchChanges(): Promise<{ patch: string | null; champions: Record<string, ChangeDetail[]>; items: Record<string, ChangeDetail[]> }> {
  const patches = await listPatches();
  const patch = patches[0] ?? null;
  if (!patch) return { patch: null, champions: {}, items: {} };
  const rows = await patchChangesFor({ patch, limit: 5000 });
  const champions: Record<string, ChangeDetail[]> = {};
  const items: Record<string, ChangeDetail[]> = {};
  for (const r of rows) {
    const d: ChangeDetail = { label: r.label, old: r.old_value, new: r.new_value, direction: r.direction };
    if (r.kind === "champion") (champions[_normChamp(r.entity_key)] ??= []).push(d);
    else if (r.kind === "item") (items[String(r.entity_key)] ??= []).push(d);
  }
  return { patch, champions, items };
}

export async function proseFor(patch: string): Promise<Record<string, string>> {
  await ensure();
  const c = await explorerPool().connect();
  try {
    const r = await c.query(`SELECT entity_key, summary FROM patch_prose WHERE patch = $1`, [patch]);
    const out: Record<string, string> = {};
    for (const x of r.rows as any[]) if (x.summary) out[x.entity_key] = x.summary;
    return out;
  } finally {
    c.release();
  }
}

// Run the diff sweep on boot + once a day so new patches get picked up.
let _sweepStarted = false;
export function startPatchDiffSweep(): void {
  if (_sweepStarted) return;
  _sweepStarted = true;
  const run = () => ensureRecentPatchDiffs(4).catch((e) => console.warn("[patch-diff] sweep:", (e as any)?.message ?? e));
  setTimeout(run, 20_000); // after warmup
  setInterval(run, 24 * 60 * 60 * 1000);
}

export async function patchChangesFor(opts: { patch?: string; kind?: string; entityKey?: string; limit?: number }): Promise<any[]> {
  await ensure();
  const c = await explorerPool().connect();
  try {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.patch) { params.push(opts.patch); where.push(`patch = $${params.length}`); }
    if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
    if (opts.entityKey) { params.push(opts.entityKey); where.push(`entity_key = $${params.length}`); }
    params.push(Math.min(opts.limit ?? 500, 2000));
    const r = await c.query(
      `SELECT patch, prev_patch, kind, entity_key, entity_name, field, label, old_value, new_value, direction
         FROM patch_changes
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY patch DESC, kind, entity_name, field
        LIMIT $${params.length}`,
      params
    );
    return r.rows;
  } finally {
    c.release();
  }
}
