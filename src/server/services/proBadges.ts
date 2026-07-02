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

export type BadgeData = { pros: Set<string>; streamers: Set<string> };

let _cache: { ts: number; data: BadgeData } | null = null;
const TTL = 10 * 60 * 1000;

export async function getBadgeData(): Promise<BadgeData> {
  if (_cache && Date.now() - _cache.ts < TTL) return _cache.data;

  const pros = new Set<string>();
  const streamers = new Set<string>();

  const [boxAccs, cloudPros, cloudProAccs, cloudStreamers, cloudStreamerAccs] =
    await Promise.all([
      explorerPool().query(`SELECT summoner_name FROM pro_accounts`),
      supabaseAdmin.from("pro_players").select("username"),
      supabaseAdmin.from("pro_player_accounts").select("username"),
      supabaseAdmin.from("streamers").select("lol_nametag"),
      supabaseAdmin.from("streamer_accounts").select("username"),
    ]);

  for (const r of boxAccs.rows as { summoner_name: string | null }[])
    if (r.summoner_name) pros.add(r.summoner_name.toLowerCase());
  for (const r of (cloudPros.data ?? []) as { username: string | null }[])
    if (r.username) pros.add(r.username.toLowerCase());
  for (const r of (cloudProAccs.data ?? []) as { username: string | null }[])
    if (r.username) pros.add(r.username.toLowerCase());
  for (const r of (cloudStreamers.data ?? []) as { lol_nametag: string | null }[])
    if (r.lol_nametag) streamers.add(r.lol_nametag.toLowerCase());
  for (const r of (cloudStreamerAccs.data ?? []) as { username: string | null }[])
    if (r.username) streamers.add(r.username.toLowerCase());

  _cache = { ts: Date.now(), data: { pros, streamers } };
  return _cache.data;
}
