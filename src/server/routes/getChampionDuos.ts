// routes/getChampionDuos.ts
//
// POST /api/champion/duos  body: { champKey: number, champion: string (DDragon id) }
//
// "Best duo partners for <champion>", role-adaptive:
//   ADC subject     → best supports   (ally role = UTILITY)
//   Support subject → best ADC carries (ally role = BOTTOM)
//   other roles     → best teammates overall (no ally-role restriction)
//
// Reuses the Explorer compile() so the ranking is the SAME Bayesian-shrunk,
// confidence-weighted lift as /api/explorer/query (small-sample flukes don't
// bury the reliable partners), and reports the full cohort sample. The query
// scans tens of thousands of rows (seconds cold), so results are cached per
// champion for 6h.

import { compile, type ExplorerGraph } from "../explorer/compile";
import { explorerPool, currentPatchPrefix } from "../explorer/pool";
import { supabaseMatch as supabase } from "../supabase/client"; // match data → box (hybrid)

type Cached = { ts: number; payload: unknown };
const cache = new Map<number, Cached>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

function canonRole(r?: string): string {
  const s = (r || "").trim().toUpperCase();
  if (["BOT", "BOTTOM", "DUO_CARRY", "CARRY", "MARKSMAN", "ADC"].includes(s)) return "ADC";
  if (["SUP", "SUPP", "UTILITY", "DUO_SUPPORT", "SUPPORT"].includes(s)) return "SUPPORT";
  if (["MID", "MIDDLE"].includes(s)) return "MID";
  if (["JNG", "JUNG", "JUNGLE"].includes(s)) return "JUNGLE";
  if (["TOP", "TOPLANE"].includes(s)) return "TOP";
  return s;
}

// Map the subject's primary lane to the bot-lane PARTNER's Riot teamPosition.
function partnerRoleFor(primary: string): "UTILITY" | "BOTTOM" | undefined {
  if (primary === "ADC") return "UTILITY"; // an ADC's duo is the support
  if (primary === "SUPPORT") return "BOTTOM"; // a support's duo is the ADC
  return undefined; // top / mid / jungle → best teammates, any role
}

export async function getChampionDuosHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const champKey = Number(body?.champKey);
    const championName = String(body?.champion ?? "").trim();
    if (!Number.isFinite(champKey) || !championName) {
      return Response.json({ error: "champKey and champion (name) are required" }, { status: 400 });
    }

    const hit = cache.get(champKey);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      return Response.json(hit.payload);
    }

    // primary role → partner role
    const { data: me } = await supabase
      .from("champions")
      .select("roles")
      .eq("id", champKey)
      .single<{ roles: string[] | null }>();
    const primaryRole = canonRole((me?.roles || []).map(canonRole).filter(Boolean)[0]);
    const partnerRole = partnerRoleFor(primaryRole);

    const graph: ExplorerGraph = {
      subject: { champion: championName },
      filters: { scope: "all", queues: [420, 440] },
      output: { kind: "rank", dimension: "ally", role: partnerRole, limit: 30, minGames: 30 },
    };

    const patch = await currentPatchPrefix();
    const { text, params } = compile(graph, patch);

    const client = await explorerPool().connect();
    let rows: any[] = [];
    try {
      await client.query("SET statement_timeout = 20000");
      const r = await client.query(text, params);
      rows = r.rows;
    } finally {
      client.release();
    }

    const cohortGames = Number(rows[0]?.cohort_games ?? 0);
    const duos = rows.map((x) => ({
      champion: x.dimension as string,
      games: Number(x.games ?? 0),
      winrate: Number(x.winrate ?? 0),
      lift: Number(x.lift ?? 0),
    }));

    const payload = { duos, primaryRole, partnerRole: partnerRole ?? null, cohortGames, patch };
    cache.set(champKey, { ts: Date.now(), payload });
    return Response.json(payload);
  } catch (e: any) {
    console.error("❌ getChampionDuos exception:", e?.message ?? e);
    return Response.json({ error: "Failed to compute duos" }, { status: 500 });
  }
}
