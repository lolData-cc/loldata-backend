// src/server/routes/playerProfile.ts
// GET /api/players/:slug → the unified pro/streamer profile for the
// /players/<slug> "map" page: identity + socials, every linked LoL account with
// its current solo-queue rank + recency, and the top champions across all
// accounts. Identity comes from Supabase Cloud (service role), live rank from
// Riot, recency + top champions from the box. Cached 5 min per slug.

import { supabaseAdmin } from "../supabase/client";
import { explorerPool } from "../explorer/pool";
import { getAccountByRiotId, getRankedDataBySummonerId } from "../riot";
import { getApexCutoffs } from "../services/apexCutoffs";

const slugify = (s: string) =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

type Region = "EUW" | "EUNE" | "NA" | "KR" | "BR" | "LAN" | "LAS" | "OCE" | "JP" | "TR" | "RU";
// Every riot.ts routing key, longest-prefix first so "EUNE" wins over "EUW"
// and "LAS" doesn't get eaten by "LAN".
const REGIONS: Region[] = ["EUNE", "EUW", "LAN", "LAS", "OCE", "NA", "KR", "BR", "JP", "TR", "RU"];
// Stored region OR (fallback) inferred from the Riot tag → a riot.ts routing key.
// Do NOT blind-default to EUW when the stored server is a real region — pro
// accounts (lolpros import) live on NA/BR/KR shards too.
function normRegion(stored: string | null | undefined, tag: string): Region {
  const s = String(stored || "").toUpperCase();
  if (s.startsWith("EUN")) return "EUNE"; // accepts "EUN1" too
  for (const r of REGIONS) if (s === r || s.startsWith(r)) return r;
  const t = String(tag || "").toUpperCase();
  if (t.includes("EUW")) return "EUW";
  if (t.includes("EUN")) return "EUNE";
  if (t.includes("KR")) return "KR";
  if (t.includes("NA")) return "NA";
  if (t.includes("BR")) return "BR";
  return "EUW";
}

type Account = {
  nametag: string; region: Region;
  tier: string | null; division: string | null; lp: number | null;
  wins: number; losses: number; puuid: string | null; lastGameMs: number | null;
};

const _cache = new Map<string, { ts: number; data: unknown }>();
const TTL = 5 * 60 * 1000;

export async function playerProfileHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const slug = decodeURIComponent(url.pathname.split("/").pop() || "");
    if (!slug) return Response.json({ error: "missing slug" }, { status: 400 });

    const hit = _cache.get(slug);
    if (hit && Date.now() - hit.ts < TTL) return Response.json(hit.data);

    // ── resolve slug → pro or streamer ──
    let identity: Record<string, unknown> | null = null;
    let rawAccounts: { username: string; region: string | null }[] = [];

    const { data: pros } = await supabaseAdmin
      .from("pro_players")
      .select("id, username, nickname, first_name, last_name, team, nationality, region, profile_image_url, twitter_url, youtube_url, twitch_url");
    const pro = (pros ?? []).find((p: any) => slugify(p.nickname || String(p.username).split("#")[0]) === slug);

    if (pro) {
      const { data: accs } = await supabaseAdmin
        .from("pro_player_accounts").select("username, region").eq("pro_player_id", pro.id);
      rawAccounts = [{ username: pro.username, region: pro.region }, ...((accs as any[]) ?? [])];
      let teamLogo: string | null = null;
      if (pro.team) {
        const { data: t } = await supabaseAdmin.from("teams").select("logo_url").eq("name", pro.team).maybeSingle();
        teamLogo = (t as any)?.logo_url ?? null;
      }
      identity = {
        type: "pro", slug,
        name: pro.nickname || String(pro.username).split("#")[0],
        nickname: pro.nickname ?? null,
        realName: [pro.first_name, pro.last_name].filter(Boolean).join(" ") || null,
        team: pro.team ?? null, teamLogo, nationality: pro.nationality ?? null,
        avatar: pro.profile_image_url ?? null, isLive: false,
        socials: { twitter: pro.twitter_url ?? null, youtube: pro.youtube_url ?? null, twitch: pro.twitch_url ?? null },
      };
    }

    // ── box: scraped pros (lolpros import) — real UNIQUE slug column, so this
    // is an indexed point lookup, not a scan. Curated Cloud pros win above.
    if (!identity) {
      const { rows: boxPros } = await explorerPool().query(
        `SELECT id, name, country, position, team_name, team_logo, avatar_url,
                twitter, twitch, youtube, instagram
           FROM pros WHERE slug = $1`,
        [slug]
      );
      if (boxPros.length) {
        const bp = boxPros[0] as Record<string, any>;
        const { rows: accs } = await explorerPool().query(
          `SELECT summoner_name, server FROM pro_accounts
            WHERE pro_id = $1
            ORDER BY league_points DESC NULLS LAST, summoner_name`,
          [bp.id]
        );
        rawAccounts = (accs as any[]).map((a) => ({ username: a.summoner_name, region: a.server }));
        identity = {
          type: "pro", slug,
          name: bp.name, nickname: bp.name, realName: null,
          team: bp.team_name ?? null, teamLogo: bp.team_logo ?? null,
          nationality: bp.country ?? null,
          avatar: bp.avatar_url ?? null, isLive: false,
          position: bp.position ?? null,
          socials: {
            twitter: bp.twitter ?? null,
            youtube: bp.youtube ?? null,
            twitch: bp.twitch ?? null,
            instagram: bp.instagram ?? null,
          },
        };
      }
    }

    if (!identity) {
      const { data: streamers } = await supabaseAdmin
        .from("streamers")
        .select("id, lol_nametag, twitch_login, region, profile_image_url, twitter_url, youtube_url, is_live");
      const st = (streamers ?? []).find((s: any) => slugify(s.twitch_login) === slug);
      if (st) {
        const { data: accs } = await supabaseAdmin
          .from("streamer_accounts").select("username, region").eq("streamer_id", st.id);
        rawAccounts = [
          ...(st.lol_nametag ? [{ username: st.lol_nametag, region: st.region }] : []),
          ...((accs as any[]) ?? []),
        ];
        identity = {
          type: "streamer", slug,
          name: st.twitch_login, nickname: st.twitch_login, realName: null,
          team: null, teamLogo: null, nationality: null,
          avatar: st.profile_image_url ?? null, isLive: !!st.is_live,
          socials: { twitter: st.twitter_url ?? null, youtube: st.youtube_url ?? null, twitch: `https://twitch.tv/${st.twitch_login}` },
        };
      }
    }

    if (!identity) return Response.json({ error: "not_found" }, { status: 404 });

    // dedupe accounts by nametag
    const seen = new Set<string>();
    const accInputs = rawAccounts
      .filter((a) => a.username && !seen.has(a.username.toLowerCase()) && seen.add(a.username.toLowerCase()))
      .map((a) => {
        const [name, tag = ""] = a.username.split("#");
        // `region` = the stored/admin region (best guess for the platform);
        // `tagRegion` = the region implied by the Riot tagline. League data is
        // per-platform, so if an admin mis-set the region (e.g. an EUW account
        // tagged #EUW stored as "NA"), the rank lookup is retried on tagRegion.
        return { nametag: a.username, name, tag, region: normRegion(a.region, tag), tagRegion: normRegion(null, tag) };
      });

    // ── per-account live solo-queue rank (Riot) ──
    const accounts: Account[] = await Promise.all(accInputs.map(async (a) => {
      const base: Account = { nametag: a.nametag, region: a.region, tier: null, division: null, lp: null, wins: 0, losses: 0, puuid: null, lastGameMs: null };
      try {
        // account-v1 by-riot-id is global → the puuid resolves on any cluster.
        const acct = await getAccountByRiotId(a.name, a.tag, a.region);
        base.puuid = acct?.puuid ?? null;
        if (base.puuid) {
          // Try the stored region first, then the tag-inferred one: an EUW
          // account whose region was mis-set to NA would otherwise read NA's
          // (empty) ladder and show as unranked. Land on the region that hits.
          for (const reg of [...new Set([a.region, a.tagRegion])]) {
            const ranked = await getRankedDataBySummonerId(base.puuid, reg);
            const solo = ((ranked as any[]) ?? []).find((e: any) => e.queueType === "RANKED_SOLO_5x5");
            if (solo) {
              base.tier = solo.tier; base.division = solo.rank; base.lp = solo.leaguePoints;
              base.wins = solo.wins; base.losses = solo.losses; base.region = reg;
              break;
            }
          }
        }
      } catch { /* unreachable account → leave unranked */ }
      return base;
    }));

    // ── recency + top champions from the box (by puuid) ──
    const puuids = accounts.map((a) => a.puuid).filter(Boolean) as string[];
    let topChampions: { championName: string; games: number; wins: number }[] = [];
    if (puuids.length) {
      const client = await explorerPool().connect();
      try {
        const rec = await client.query(
          `SELECT p.puuid, max(m.game_creation) AS last_game
             FROM participants p JOIN matches m ON m.match_id = p.match_id
            WHERE p.puuid = ANY($1) GROUP BY p.puuid`, [puuids]);
        const recMap = new Map<string, number>((rec.rows as any[]).map((r) => [r.puuid, Number(r.last_game)]));
        for (const a of accounts) if (a.puuid && recMap.has(a.puuid)) a.lastGameMs = recMap.get(a.puuid)!;
        const champs = await client.query(
          `SELECT champion_name, count(*)::int games, sum(case when win then 1 else 0 end)::int wins
             FROM participants WHERE puuid = ANY($1) AND champion_name IS NOT NULL
            GROUP BY champion_name ORDER BY games DESC LIMIT 8`, [puuids]);
        topChampions = (champs.rows as any[]).map((r) => ({ championName: r.champion_name, games: r.games, wins: r.wins }));
      } finally { client.release(); }
    }

    // Apex (Master+) accounts need the GM/Challenger LP cutoffs to draw their
    // progress-to-next-rank bar; only hit the table when there's an apex account.
    const hasApex = accounts.some((a) => a.tier && (a.tier === "MASTER" || a.tier === "GRANDMASTER" || a.tier === "CHALLENGER"));
    const cutoffs = hasApex ? await getApexCutoffs() : {};

    const data = { ...identity, accounts, topChampions, cutoffs };
    _cache.set(slug, { ts: Date.now(), data });
    return Response.json(data);
  } catch (e: any) {
    console.error("[players] error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}
