// src/server/services/proBadges.ts
// The single source of truth for "is this LoL account a pro / streamer?".
// Merges every known account nametag (lowercased "name#tag") from:
//   - box `pro_accounts` (the lolpros.gg bulk import — thousands of rows)
//   - Cloud `pro_players` + `pro_player_accounts` (hand-curated)
//   - Cloud `streamers` + `streamer_accounts`
// Cached in-process for 10 minutes. Powers /api/pros/badge-map (frontend
// scoreboard badges), the leaderboard badge enrichment, and identity checks.

import { supabaseAdmin } from "../supabase/client";
import { explorerPool } from "../explorer/pool";

/** Who an account belongs to — the handle everyone knows them by ("Faker")
 *  plus the slug of their /players page. */
export type BadgeIdentity = { name: string; slug: string };

export type BadgeData = {
  pros: Set<string>;
  streamers: Set<string>;
  /** lowercased "name#tag" → identity. Same keys as the sets above; kept
   *  separate so the existing Set.has() badge checks stay O(1) and untouched. */
  proNames: Map<string, BadgeIdentity>;
  streamerNames: Map<string, BadgeIdentity>;
};

let _cache: { ts: number; data: BadgeData } | null = null;
const TTL = 10 * 60 * 1000;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function getBadgeData(): Promise<BadgeData> {
  if (_cache && Date.now() - _cache.ts < TTL) return _cache.data;

  const pros = new Set<string>();
  const streamers = new Set<string>();
  const proNames = new Map<string, BadgeIdentity>();
  const streamerNames = new Map<string, BadgeIdentity>();

  const [
    boxAccs,
    cloudPros,
    cloudProAccs,
    cloudStreamers,
    cloudStreamerAccs,
  ] = await Promise.all([
    // Join through to `pros` so the scraped accounts carry a display name.
    explorerPool().query(
      `SELECT a.summoner_name, p.name, p.slug
         FROM pro_accounts a JOIN pros p ON p.id = a.pro_id`
    ),
    supabaseAdmin.from("pro_players").select("id, username, nickname"),
    supabaseAdmin.from("pro_player_accounts").select("username, pro_player_id"),
    supabaseAdmin.from("streamers").select("id, lol_nametag, twitch_login"),
    supabaseAdmin.from("streamer_accounts").select("username, streamer_id"),
  ]);

  // 1) box scrape (lolpros.gg bulk import) — the broad, lower-precedence layer
  for (const r of boxAccs.rows as { summoner_name: string | null; name: string; slug: string }[]) {
    if (!r.summoner_name) continue;
    const key = r.summoner_name.toLowerCase();
    pros.add(key);
    proNames.set(key, { name: r.name, slug: r.slug });
  }

  // 2) curated Cloud pros — overwrite the scrape, same precedence order as
  //    /api/players/:slug (curated wins over scraped).
  const proById = new Map<string, BadgeIdentity>();
  for (const r of (cloudPros.data ?? []) as any[]) {
    const name = r.nickname || String(r.username ?? "").split("#")[0];
    if (!name) continue;
    const identity = { name, slug: slugify(name) };
    proById.set(r.id, identity);
    if (r.username) {
      const key = String(r.username).toLowerCase();
      pros.add(key);
      proNames.set(key, identity);
    }
  }
  for (const r of (cloudProAccs.data ?? []) as any[]) {
    if (!r.username) continue;
    const key = String(r.username).toLowerCase();
    pros.add(key);
    const identity = proById.get(r.pro_player_id);
    if (identity) proNames.set(key, identity);
  }

  // 3) streamers
  const streamerById = new Map<string, BadgeIdentity>();
  for (const r of (cloudStreamers.data ?? []) as any[]) {
    const name = r.twitch_login || String(r.lol_nametag ?? "").split("#")[0];
    if (!name) continue;
    const identity = { name, slug: slugify(name) };
    streamerById.set(r.id, identity);
    if (r.lol_nametag) {
      const key = String(r.lol_nametag).toLowerCase();
      streamers.add(key);
      streamerNames.set(key, identity);
    }
  }
  for (const r of (cloudStreamerAccs.data ?? []) as any[]) {
    if (!r.username) continue;
    const key = String(r.username).toLowerCase();
    streamers.add(key);
    const identity = streamerById.get(r.streamer_id);
    if (identity) streamerNames.set(key, identity);
  }

  _cache = { ts: Date.now(), data: { pros, streamers, proNames, streamerNames } };
  return _cache.data;
}

/**
 * Resolve a batch of "name#tag" strings to the pros/streamers among them.
 * Used by the Discord embed to name the notable players in a game.
 */
export async function lookupBadgeIdentities(
  nametags: (string | null | undefined)[]
): Promise<Map<string, BadgeIdentity & { kind: "pro" | "streamer" }>> {
  const { proNames, streamerNames } = await getBadgeData();
  const out = new Map<string, BadgeIdentity & { kind: "pro" | "streamer" }>();
  for (const raw of nametags) {
    if (!raw) continue;
    const key = raw.toLowerCase();
    const pro = proNames.get(key);
    if (pro) {
      out.set(raw, { ...pro, kind: "pro" });
      continue;
    }
    const streamer = streamerNames.get(key);
    if (streamer) out.set(raw, { ...streamer, kind: "streamer" });
  }
  return out;
}
