// src/server/routes/prosDirectory.ts
// GET /api/pros?query=&page=&limit= → paginated directory of the SCRAPED box
// pros (lolpros import). Powers the admin "PRO PLAYERS DIRECTORY" box section
// and, later, the public /players index page. Read-only; the curated Cloud
// pro_players live elsewhere and are managed by the existing admin flows.

import { explorerPool } from "../explorer/pool";
import { supabaseAdmin } from "../supabase/client";
import { getBadgeData } from "../services/proBadges";

const slugify = (s: string) =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── GET /api/pros/badge-map ──────────────────────────────────────────────────
// Every known pro/streamer account nametag (lowercased) in two flat arrays.
// The frontend loads this once per page and does Set.has() checks for the
// scoreboard/leaderboard nameplates — replaces the old browser→Supabase reads.
export async function prosBadgeMapHandler(_req: Request): Promise<Response> {
  try {
    const { pros, streamers, proNames, streamerNames } = await getBadgeData();
    return Response.json(
      {
        pros: [...pros],
        streamers: [...streamers],
        // nametag → { name, slug }. Lets a nameplate show WHO the pro is
        // ("Faker") and link to their profile, without a call per player.
        proNames: Object.fromEntries(proNames),
        streamerNames: Object.fromEntries(streamerNames),
      },
      { headers: { "Cache-Control": "public, max-age=600" } }
    );
  } catch (e: any) {
    console.error("[pros] badge-map error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}

// ── GET /api/pros/identity?nametag=Name%23TAG ────────────────────────────────
// The summoner-page header identity for one account: curated Cloud pros win,
// then the scraped box pros, then streamers. 5-min cache per nametag.
const _idCache = new Map<string, { ts: number; data: unknown }>();
const ID_TTL = 5 * 60 * 1000;

export async function prosIdentityHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const nametag = (url.searchParams.get("nametag") || "").trim();
    if (!nametag.includes("#")) return Response.json({ type: null });
    const key = nametag.toLowerCase();
    const hit = _idCache.get(key);
    if (hit && Date.now() - hit.ts < ID_TTL) return Response.json(hit.data);

    let data: Record<string, unknown> = { type: null };

    // 1) curated Cloud pro — direct username or linked account
    const cols = "id, username, nickname, first_name, last_name, team, nationality, profile_image_url";
    let pro: any = (await supabaseAdmin.from("pro_players").select(cols).ilike("username", nametag).limit(1)).data?.[0] ?? null;
    if (!pro) {
      const acc = (await supabaseAdmin.from("pro_player_accounts").select("pro_player_id").ilike("username", nametag).limit(1)).data?.[0];
      if (acc) pro = (await supabaseAdmin.from("pro_players").select(cols).eq("id", acc.pro_player_id).limit(1)).data?.[0] ?? null;
    }
    if (pro) {
      let teamLogo: string | null = null;
      if (pro.team) {
        const { data: t } = await supabaseAdmin.from("teams").select("logo_url").eq("name", pro.team).maybeSingle();
        teamLogo = (t as any)?.logo_url ?? null;
      }
      const { data: accs } = await supabaseAdmin.from("pro_player_accounts").select("username").eq("pro_player_id", pro.id);
      data = {
        type: "pro",
        slug: slugify(pro.nickname || String(pro.username).split("#")[0]),
        name: pro.nickname || String(pro.username).split("#")[0],
        realName: [pro.first_name, pro.last_name].filter(Boolean).join(" ") || null,
        team: pro.team ?? null,
        teamLogo,
        nationality: pro.nationality ?? null,
        avatar: pro.profile_image_url ?? null,
        accounts: [pro.username, ...((accs ?? []) as any[]).map((a) => a.username)],
      };
    }

    // 2) scraped box pro — indexed account match
    if (!data.type) {
      const { rows } = await explorerPool().query(
        `SELECT p.id, p.slug, p.name, p.country, p.position, p.team_name, p.team_tag, p.team_logo, p.avatar_url
           FROM pros p JOIN pro_accounts a ON a.pro_id = p.id
          WHERE lower(a.summoner_name) = lower($1) LIMIT 1`,
        [nametag]
      );
      if (rows.length) {
        const bp = rows[0] as Record<string, any>;
        const { rows: accs } = await explorerPool().query(
          `SELECT summoner_name FROM pro_accounts WHERE pro_id = $1 ORDER BY league_points DESC NULLS LAST, summoner_name`,
          [bp.id]
        );
        data = {
          type: "pro",
          slug: bp.slug,
          name: bp.name,
          realName: null,
          team: bp.team_name ?? null,
          teamLogo: bp.team_logo ?? null,
          nationality: bp.country ?? null,
          avatar: bp.avatar_url ?? null,
          position: bp.position ?? null,
          accounts: (accs as any[]).map((a) => a.summoner_name),
        };
      }
    }

    // 3) streamer — main nametag or linked account
    if (!data.type) {
      const scols = "id, twitch_login, region, profile_image_url";
      let st: any = (await supabaseAdmin.from("streamers").select(scols).ilike("lol_nametag", nametag).maybeSingle()).data ?? null;
      if (!st) {
        const acc = (await supabaseAdmin.from("streamer_accounts").select("streamer_id").ilike("username", nametag).limit(1)).data?.[0];
        if (acc) st = (await supabaseAdmin.from("streamers").select(scols).eq("id", acc.streamer_id).maybeSingle()).data ?? null;
      }
      if (st) {
        data = {
          type: "streamer",
          slug: slugify(st.twitch_login),
          name: st.twitch_login,
          twitchLogin: st.twitch_login,
          region: st.region ?? null,
          avatar: st.profile_image_url ?? null,
        };
      }
    }

    _idCache.set(key, { ts: Date.now(), data });
    return Response.json(data);
  } catch (e: any) {
    console.error("[pros] identity error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}

// ── GET /api/pros/search?query= ──────────────────────────────────────────────
// ≤3 pro suggestions for the search dialog: curated Cloud pros first (they
// have avatars), then box pros by lolpros score. Each row carries the main
// account name+tag so the dialog can route to the summoner page.
export async function prosSearchHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("query") || "").trim();
    if (q.length < 2) return Response.json({ suggestions: [] });
    const like = `%${q}%`;

    const [cloud, box] = await Promise.all([
      supabaseAdmin
        .from("pro_players")
        .select("username, nickname, profile_image_url, team, region")
        .or(`nickname.ilike.${like},username.ilike.${like}`)
        .limit(3),
      explorerPool().query(
        `SELECT p.slug, p.name, p.team_tag, p.team_name, m.summoner_name AS main_account, m.server AS main_server
           FROM pros p
           LEFT JOIN LATERAL (
             SELECT a.summoner_name, a.server FROM pro_accounts a
              WHERE a.pro_id = p.id
              ORDER BY a.league_points DESC NULLS LAST LIMIT 1
           ) m ON true
          WHERE p.name ILIKE $1 OR p.slug ILIKE $1
          ORDER BY p.lolpros_score DESC NULLS LAST
          LIMIT 3`,
        [like]
      ),
    ]);

    // `region` = the ACCOUNT's real shard (EUW/NA/BR/KR…) so the search dialog
    // routes to the right summoner page — never assume the selected region.
    type Sug = { name: string; tag: string; nickname: string | null; avatar: string | null; team: string | null; slug: string; region: string | null };
    const out: Sug[] = [];
    const seen = new Set<string>();
    for (const p of (cloud.data ?? []) as any[]) {
      const [name, tag = ""] = String(p.username || "").split("#");
      const k = (p.nickname || name).toLowerCase();
      if (!name || seen.has(k)) continue;
      seen.add(k);
      out.push({ name, tag, nickname: p.nickname ?? null, avatar: p.profile_image_url ?? null, team: p.team ?? null, slug: slugify(p.nickname || name), region: p.region ?? null });
    }
    for (const r of box.rows as any[]) {
      if (!r.main_account) continue;
      const k = String(r.name).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const [name, tag = ""] = String(r.main_account).split("#");
      out.push({ name, tag, nickname: r.name, avatar: null, team: r.team_tag ?? r.team_name ?? null, slug: r.slug, region: r.main_server ?? null });
      if (out.length >= 3) break;
    }

    return Response.json({ suggestions: out.slice(0, 3) });
  } catch (e: any) {
    console.error("[pros] search error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}

export async function prosDirectoryHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const query = (url.searchParams.get("query") || "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = (page - 1) * limit;

    const params: unknown[] = [limit, offset];
    let where = "";
    if (query) {
      params.push(`%${query}%`);
      where = `WHERE p.name ILIKE $3 OR p.slug ILIKE $3 OR p.team_name ILIKE $3 OR p.team_tag ILIKE $3`;
    }

    const { rows } = await explorerPool().query(
      `SELECT p.slug, p.name, p.country, p.position,
              p.team_name, p.team_tag, p.team_logo,
              p.twitter, p.twitch, p.lolpros_score,
              (SELECT count(*)::int FROM pro_accounts a WHERE a.pro_id = p.id) AS accounts,
              count(*) OVER()::int AS total
         FROM pros p
         ${where}
        ORDER BY p.lolpros_score DESC NULLS LAST, p.name
        LIMIT $1 OFFSET $2`,
      params
    );

    const total = (rows[0] as any)?.total ?? 0;
    const pros = (rows as any[]).map(({ total: _t, ...r }) => r);
    return Response.json({ total, page, limit, pros });
  } catch (e: any) {
    console.error("[pros] directory error:", e?.message ?? e);
    return new Response("Internal server error", { status: 500 });
  }
}
