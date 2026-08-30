/**
 * POST /api/champion/otp-runes
 *
 * The rune page of the highest-ranked one-trick who plays this champion IN THIS
 * ROLE — what the desktop app offers as "HIGHEST ELO" when you lock a champion
 * in.
 *
 * ⚠️ A NEW ROUTE, not a parameter on /api/champion/otp-ranking, and the reason
 * is a trap rather than a preference. That endpoint's 40% one-trick test is a
 * ratio: `champ_games / total_games`. Role-scoping its numerator while the
 * denominator stays "every game they have played" would quietly raise the bar —
 * a Lee Sin main who plays 45% of his games on Lee Sin, split 30% jungle and
 * 15% top, stops being a one-trick in either role and drops off the website's
 * public list. So that query is left exactly as it is, and this one owns its own
 * definition: the ratio here is measured against the same role-scoped cohort it
 * selects from.
 *
 * ⚠️ ONE ROUND TRIP. The cohort and the page are joined with a LATERAL rather
 * than fetched in two calls, because the caller is a game client sitting in
 * champion select with about twenty seconds of usable time.
 */
import { explorerPool } from "../explorer/pool";
import {
  MASTER_PLUS,
  MIN_CHAMP_GAMES,
  PLAYRATE_THRESHOLD,
  REGION_TO_PLATFORM,
  PLATFORM_TO_REGION,
} from "./getChampionOtpRanking";

export type OtpRunePage = {
  /** Who it came from, so the app can say whose page this is. */
  player: { name: string; tag: string; tier: string; division: string | null; lp: number; region: string };
  /** How much of them is this champion in this role — the claim to authority. */
  games: number;
  wins: number;
  keystone: number;
  primaryStyle: number;
  subStyle: number;
  /** The four primary perks, keystone first. */
  primary: number[];
  /** The two secondary perks. */
  secondary: number[];
  /** The three stat shards. */
  shards: number[];
  /** Games this exact page was run in, by this player, on this champion+role. */
  pageGames: number;
};

export async function getChampionOtpRunesHandler(req: Request): Promise<Response> {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* an empty body is answered by the guard below */
  }

  const championName = String(body?.championName ?? "").trim();
  const role = String(body?.role ?? "").trim().toUpperCase();
  const regionKey = String(body?.region ?? "ALL").toUpperCase();

  if (!championName) {
    return Response.json({ error: "championName is required" }, { status: 400 });
  }
  // ⚠️ The role is REQUIRED here, unlike on the ranking endpoint. Without one
  // this would answer with whoever tops the champion overall, which is the very
  // thing that made the old rune source wrong: a Twisted Fate top given the
  // page of a Twisted Fate mid.
  if (!role) {
    return Response.json({ error: "role is required" }, { status: 400 });
  }

  const platform = REGION_TO_PLATFORM[regionKey] ?? null;

  const sql = `
    WITH champ AS (
      SELECT p.puuid,
             count(*)                      AS role_games,
             count(*) FILTER (WHERE p.win) AS role_wins
        FROM participants p
       WHERE p.champion_name = $1
         AND p.role = $2
         AND p.puuid IS NOT NULL
       GROUP BY p.puuid
    ),
    ranked AS (
      SELECT c.*, pl.game_name, pl.tag_line, pl.tier, pl.division, pl.lp, pl.platform
        FROM champ c
        JOIN players pl ON pl.puuid = c.puuid
       WHERE pl.tier = ANY($3)
         AND c.role_games >= $4
         AND ($5::text IS NULL OR pl.platform = $5)
    ),
    totals AS (
      SELECT puuid, count(*) AS total_games
        FROM participants
       WHERE puuid IN (SELECT puuid FROM ranked)
       GROUP BY puuid
    )
    SELECT r.game_name, r.tag_line, r.tier, r.division, r.lp, r.platform,
           r.role_games, r.role_wins,
           pg.keystone, pg.primary_style, pg.sub_style,
           pg.perk_primary, pg.perk_secondary, pg.stat_perks, pg.page_games
      FROM ranked r
      JOIN totals t ON t.puuid = r.puuid
      -- ⚠️ LATERAL, so the page is the page THIS player actually runs, not the
      -- cohort's average. That is the whole point of asking a person rather
      -- than a population.
      JOIN LATERAL (
        SELECT p.perk_keystone AS keystone, p.perk_primary_style AS primary_style,
               p.perk_sub_style AS sub_style, p.perk_primary, p.perk_secondary, p.stat_perks,
               count(*)::int AS page_games
          FROM participants p
         WHERE p.puuid = r.puuid
           AND p.champion_name = $1
           AND p.role = $2
           AND p.perk_primary IS NOT NULL
           AND p.perk_primary_style IS NOT NULL
         GROUP BY 1, 2, 3, 4, 5, 6
         ORDER BY count(*) DESC
         LIMIT 1
      ) pg ON TRUE
     WHERE (r.role_games::float / NULLIF(t.total_games, 0)) >= $6
     ORDER BY CASE r.tier WHEN 'CHALLENGER' THEN 0 WHEN 'GRANDMASTER' THEN 1 WHEN 'MASTER' THEN 2 ELSE 9 END,
              r.lp DESC
     LIMIT 1;`;

  const client = await explorerPool().connect();
  try {
    // ⚠️ Short, and shorter than the Build tab's 15s. Champion select does not
    // wait: an answer that arrives after the lock-in is worth nothing, and a
    // slot that stays open costs the box while it is worth nothing.
    await client.query("SET statement_timeout = 8000");
    await client.query("SET max_parallel_workers_per_gather = 0");

    const r = await client.query(sql, [
      championName,
      role,
      MASTER_PLUS,
      MIN_CHAMP_GAMES,
      platform,
      PLAYRATE_THRESHOLD,
    ]);

    const row = (r.rows as any[])[0];
    // ⚠️ 204, not an error and not an empty page. "Nobody one-tricks this
    // champion in this role at Master+" is a true answer, and the app must be
    // able to tell it apart from a failure — it offers the option only when
    // there is something behind it.
    if (!row) return new Response(null, { status: 204 });

    const out: OtpRunePage = {
      player: {
        name: String(row.game_name ?? ""),
        tag: String(row.tag_line ?? ""),
        tier: String(row.tier ?? ""),
        division: row.division ?? null,
        lp: Number(row.lp ?? 0),
        region: PLATFORM_TO_REGION[String(row.platform)] ?? "EUW",
      },
      games: Number(row.role_games ?? 0),
      wins: Number(row.role_wins ?? 0),
      keystone: Number(row.keystone),
      primaryStyle: Number(row.primary_style),
      subStyle: Number(row.sub_style),
      primary: ((row.perk_primary as number[]) ?? []).map(Number),
      secondary: ((row.perk_secondary as number[]) ?? []).map(Number),
      shards: ((row.stat_perks as number[]) ?? []).map(Number),
      pageGames: Number(row.page_games ?? 0),
    };

    return Response.json(out, {
      headers: { "Cache-Control": "public, max-age=600" },
    });
  } catch (e: any) {
    console.error("❌ getChampionOtpRunes:", e?.message ?? e);
    return Response.json({ error: "Failed to read the one-trick's runes" }, { status: 500 });
  } finally {
    client.release();
  }
}
