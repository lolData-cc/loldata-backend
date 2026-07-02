// src/jobs/lolpros-scrape.ts
//
// Bulk import of pro players from lolpros.gg into the box tables
// `pros` + `pro_accounts` (created 2026-07-02; see the DDL in the tables'
// comments below). The /players/:slug endpoint then resolves scraped pros
// straight from the box by indexed slug.
//
// Source: the public LOLPros JSON API (api.lolpros.gg/es/*):
//   /es/ladder?page=N        → 20 ranked players per page (slug enumeration)
//   /es/teams?page=N         → team list; /es/teams/:slug → current_members
//   /es/profiles/:slug       → full profile: country, position, teams,
//                              social_media, league_player.accounts[] with
//                              summoner_name "Name#TAG", server, rank, peak,
//                              summoner name history.
//
// NOTE: LOLPros' `encrypted_puuid` is encrypted with THEIR Riot key and is
// useless to us — puuids are resolved live by playerProfile.ts via our key.
//
// Run ON THE BOX (needs DATABASE_URL in env, bun auto-loads .env from cwd):
//   bun run src/jobs/lolpros-scrape.ts                # full scrape (resumable)
//   bun run src/jobs/lolpros-scrape.ts --limit 5      # smoke test: 5 profiles
//   bun run src/jobs/lolpros-scrape.ts --fresh        # ignore saved state
//   bun run src/jobs/lolpros-scrape.ts --discover-only# just count slugs
//
// Politeness: ~2.5 req/s with jitter, exponential backoff on 429/5xx
// (honours Retry-After), honest User-Agent.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { explorerPool } from "../server/explorer/pool";

const API = "https://api.lolpros.gg/es";
const UA = "Mozilla/5.0 (compatible; loldata-importer/1.0; +https://loldata.cc)";
const STATE_FILE = ".lolpros-scrape-state.json";
const THROTTLE_MS = 350; // + 0-150ms jitter ≈ 2-2.8 req/s
const MAX_LADDER_PAGES = 600; // hard stop (ladder was empty by page ~300)
const MAX_TEAM_PAGES = 200;

// ── CLI ──
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const LIMIT = Number(opt("--limit") || 0) || Infinity;
const FRESH = flag("--fresh");
const DISCOVER_ONLY = flag("--discover-only");

// ── state (resume support) ──
type State = { done: string[]; failed: Record<string, string> };
const state: State = (() => {
  if (!FRESH && existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State; } catch { /* corrupt → fresh */ }
  }
  return { done: [], failed: {} };
})();
const doneSet = new Set(state.done);
const saveState = () => {
  state.done = [...doneSet];
  writeFileSync(STATE_FILE, JSON.stringify(state));
};

// ── polite fetch ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function fetchJson<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    // global throttle
    const wait = lastReq + THROTTLE_MS + Math.random() * 150 - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(`${API}${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 404) return null; // legit missing
      if (res.ok) return (await res.json()) as T;
      // 429/5xx → backoff (honour Retry-After when present)
      const ra = Number(res.headers.get("retry-after") || 0);
      const backoff = ra > 0 ? ra * 1000 : [2_000, 8_000, 20_000][attempt] ?? 30_000;
      console.warn(`  HTTP ${res.status} on ${path} → backoff ${backoff}ms`);
      await sleep(backoff);
    } catch (e: any) {
      const backoff = [2_000, 8_000, 20_000][attempt] ?? 30_000;
      console.warn(`  network error on ${path} (${e?.message}) → backoff ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw new Error(`gave up on ${path}`);
}

// ── LOLPros shapes (the fields we consume) ──
type LadderItem = { slug: string };
type TeamListItem = { slug: string };
type TeamDetail = {
  current_members?: { slug: string; role?: string }[];
};
type Rank = {
  tier?: string; division?: number; league_points?: number;
  wins?: number; losses?: number; created_at?: string;
} | null;
type Profile = {
  uuid: string;
  name: string;
  slug: string;
  country: string | null;
  other_countries?: string[];
  social_media?: Record<string, string | null>;
  teams?: { name: string; tag: string; leave_date: string | null; role?: string; logo?: { url?: string } }[];
  league_player?: {
    position?: string;
    score?: number;
    accounts?: {
      uuid: string;
      server: string;
      summoner_name: string; // "Name#TAG"
      gamename?: string;
      tagline?: string;
      rank?: Rank;
      peak?: Rank;
      summoner_names?: { name: string; created_at: string }[];
    }[];
  } | null;
};

// ── mappers ──
const stripPrefix = (s?: string | null) => (s ? s.replace(/^\d+_/, "") : null); // "30_mid"→"mid", "00_challenger"→"challenger"
const httpsify = (u?: string | null) => (u ? u.replace(/^http:\/\//, "https://") : null);
const socialUrl = (kind: string, v?: string | null): string | null => {
  const s = (v || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return httpsify(s);
  switch (kind) {
    case "twitter": return `https://twitter.com/${s.replace(/^@/, "")}`;
    case "twitch": return `https://twitch.tv/${s}`;
    case "instagram": return `https://instagram.com/${s.replace(/^@/, "")}`;
    case "facebook": return `https://facebook.com/${s}`;
    default: return s;
  }
};

// ── upsert one profile (transactional) ──
async function upsertProfile(p: Profile): Promise<"ok" | "skipped"> {
  const accounts = p.league_player?.accounts ?? [];
  if (!accounts.length) return "skipped"; // staff / no LoL accounts → not a playable pro profile

  const team = (p.teams ?? []).find((t) => !t.leave_date && (t.role ?? "player") === "player")
    ?? (p.teams ?? []).find((t) => !t.leave_date);
  const sm = p.social_media ?? {};

  const pool = explorerPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertPro = async (slug: string) =>
      client.query<{ id: string }>(
        `INSERT INTO pros (slug, name, country, other_countries, position,
                           team_name, team_tag, team_logo,
                           twitter, twitch, youtube, instagram, facebook, discord,
                           lolpros_uuid, lolpros_slug, lolpros_score, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'lolpros',now())
         ON CONFLICT (lolpros_uuid) DO UPDATE SET
           slug=EXCLUDED.slug, name=EXCLUDED.name, country=EXCLUDED.country,
           other_countries=EXCLUDED.other_countries, position=EXCLUDED.position,
           team_name=EXCLUDED.team_name, team_tag=EXCLUDED.team_tag, team_logo=EXCLUDED.team_logo,
           twitter=EXCLUDED.twitter, twitch=EXCLUDED.twitch, youtube=EXCLUDED.youtube,
           instagram=EXCLUDED.instagram, facebook=EXCLUDED.facebook, discord=EXCLUDED.discord,
           lolpros_slug=EXCLUDED.lolpros_slug, lolpros_score=EXCLUDED.lolpros_score,
           updated_at=now()
         RETURNING id`,
        [
          slug, p.name, p.country ?? null, p.other_countries ?? [], stripPrefix(p.league_player?.position),
          team?.name ?? null, team?.tag ?? null, httpsify(team?.logo?.url) ?? null,
          socialUrl("twitter", sm.twitter), socialUrl("twitch", sm.twitch), null,
          socialUrl("instagram", sm.instagram), socialUrl("facebook", sm.facebook), socialUrl("discord", sm.discord),
          p.uuid, p.slug, p.league_player?.score ?? null,
        ]
      );

    let proId: string;
    try {
      proId = (await insertPro(p.slug)).rows[0].id;
    } catch (e: any) {
      if (e?.code === "23505" && /pros_slug_key/.test(e?.constraint ?? "")) {
        // same slug, different lolpros uuid (their slugs are unique, so this
        // only fires on weird edge data) → suffix and move on
        proId = (await insertPro(`${p.slug}-lp`)).rows[0].id;
      } else throw e;
    }

    // accounts: upsert current set, prune the ones gone from lolpros
    const uuids = accounts.map((a) => a.uuid);
    await client.query(
      `DELETE FROM pro_accounts WHERE pro_id = $1 AND lolpros_account_uuid IS NOT NULL AND NOT (lolpros_account_uuid = ANY($2::uuid[]))`,
      [proId, uuids]
    );
    for (const a of accounts) {
      const r = a.rank ?? null;
      await client.query(
        `INSERT INTO pro_accounts (pro_id, lolpros_account_uuid, server, summoner_name, gamename, tagline,
                                   tier, division, league_points, wins, losses, rank_updated_at,
                                   peak, summoner_names, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
         ON CONFLICT (lolpros_account_uuid) DO UPDATE SET
           pro_id=EXCLUDED.pro_id, server=EXCLUDED.server, summoner_name=EXCLUDED.summoner_name,
           gamename=EXCLUDED.gamename, tagline=EXCLUDED.tagline,
           tier=EXCLUDED.tier, division=EXCLUDED.division, league_points=EXCLUDED.league_points,
           wins=EXCLUDED.wins, losses=EXCLUDED.losses, rank_updated_at=EXCLUDED.rank_updated_at,
           peak=EXCLUDED.peak, summoner_names=EXCLUDED.summoner_names, updated_at=now()`,
        [
          proId, a.uuid, a.server, a.summoner_name, a.gamename ?? null, a.tagline ?? null,
          stripPrefix(r?.tier)?.toUpperCase() ?? null, r?.division ?? null, r?.league_points ?? null,
          r?.wins ?? null, r?.losses ?? null, r?.created_at ?? null,
          a.peak ? JSON.stringify(a.peak) : null,
          a.summoner_names ? JSON.stringify(a.summoner_names) : null,
        ]
      );
    }

    await client.query("COMMIT");
    return "ok";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── discovery ──
async function discoverSlugs(): Promise<string[]> {
  const slugs = new Set<string>();

  // smoke tests (--limit N) shouldn't pay for the full enumeration
  const ladderCap = LIMIT === Infinity ? MAX_LADDER_PAGES : 3;

  console.log("discovering: ladder…");
  for (let page = 1; page <= ladderCap; page++) {
    const items = await fetchJson<LadderItem[]>(`/ladder?page=${page}`);
    if (!items || !items.length) break;
    for (const it of items) if (it.slug) slugs.add(it.slug);
    if (page % 25 === 0) console.log(`  ladder page ${page} → ${slugs.size} slugs so far`);
  }
  console.log(`ladder done → ${slugs.size} slugs`);
  if (LIMIT !== Infinity) return [...slugs]; // smoke test: ladder sample only

  console.log("discovering: teams…");
  const teamSlugs: string[] = [];
  for (let page = 1; page <= MAX_TEAM_PAGES; page++) {
    const items = await fetchJson<TeamListItem[]>(`/teams?page=${page}`);
    if (!items || !items.length) break;
    for (const t of items) if (t.slug) teamSlugs.push(t.slug);
  }
  console.log(`  ${teamSlugs.length} teams; fetching rosters…`);
  let before = slugs.size;
  for (let i = 0; i < teamSlugs.length; i++) {
    const detail = await fetchJson<TeamDetail>(`/teams/${encodeURIComponent(teamSlugs[i])}`);
    for (const m of detail?.current_members ?? []) {
      if (m.slug && (m.role ?? "player") === "player") slugs.add(m.slug);
    }
    if ((i + 1) % 50 === 0) console.log(`  rosters ${i + 1}/${teamSlugs.length} → +${slugs.size - before} new`);
  }
  console.log(`teams done → +${slugs.size - before} extra slugs (total ${slugs.size})`);

  return [...slugs];
}

// ── main ──
async function main() {
  console.log(`lolpros-scrape starting (resume: ${!FRESH && state.done.length ? `${state.done.length} done` : "no"})`);
  const slugs = await discoverSlugs();
  console.log(`discovered ${slugs.length} unique player slugs`);
  if (DISCOVER_ONLY) return;

  const todo = slugs.filter((s) => !doneSet.has(s)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`fetching ${todo.length} profiles…`);

  let ok = 0, skipped = 0, failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const slug = todo[i];
    try {
      const p = await fetchJson<Profile>(`/profiles/${encodeURIComponent(slug)}`);
      if (!p) { skipped++; doneSet.add(slug); continue; }
      const res = await upsertProfile(p);
      res === "ok" ? ok++ : skipped++;
      doneSet.add(slug);
      delete state.failed[slug];
    } catch (e: any) {
      failed++;
      state.failed[slug] = String(e?.message ?? e);
      console.warn(`  FAILED ${slug}: ${e?.message ?? e}`);
    }
    if ((i + 1) % 25 === 0) {
      saveState();
      console.log(`  ${i + 1}/${todo.length} (ok ${ok}, skipped ${skipped}, failed ${failed})`);
    }
  }
  saveState();

  const { rows } = await explorerPool().query(
    `SELECT (SELECT count(*) FROM pros) AS pros, (SELECT count(*) FROM pro_accounts) AS accounts`
  );
  console.log(`DONE. ok ${ok}, skipped ${skipped}, failed ${failed}`);
  console.log(`DB now has ${rows[0].pros} pros, ${rows[0].accounts} accounts`);
  if (failed) console.log(`failed slugs saved in ${STATE_FILE} → rerun to retry`);
  await explorerPool().end();
}

main().catch((e) => { console.error(e); process.exit(1); });
