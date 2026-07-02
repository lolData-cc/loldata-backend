// src/server/routes/prosDirectory.ts
// GET /api/pros?query=&page=&limit= → paginated directory of the SCRAPED box
// pros (lolpros import). Powers the admin "PRO PLAYERS DIRECTORY" box section
// and, later, the public /players index page. Read-only; the curated Cloud
// pro_players live elsewhere and are managed by the existing admin flows.

import { explorerPool } from "../explorer/pool";

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
