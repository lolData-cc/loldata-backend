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
// confidence-weighted lift as /api/explorer/query. The self-join is heavy on the
// ~86M-row participants table (20s → 500 under load), so the DEFAULT payload is
// served from a persistent L2 cache (cbs_duos, nightly warm + write-through);
// only a not-yet-warmed champion falls back to the live compute.

import { compile, type ExplorerGraph } from "../explorer/compile";
import { explorerPool, currentPatchPrefix } from "../explorer/pool";
import { supabaseMatch as supabase } from "../supabase/client"; // match data → box (hybrid)

type Cached = { ts: number; payload: unknown };
const cache = new Map<number, Cached>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6h in-process L1
const L2_FRESH = "2 days";

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

export type DuosPayload = {
  duos: { champion: string; games: number; winrate: number; lift: number }[];
  primaryRole: string;
  partnerRole: string | null;
  cohortGames: number;
  patch: string;
};

// The heavy Explorer ally-ranking. Exported so warmBuild.ts can precompute it.
// The caller sets statement_timeout / parallelism on `client` beforehand.
export async function computeDuos(client: any, champKey: number, championName: string): Promise<DuosPayload> {
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
  const r = await client.query(text, params);
  const rows = r.rows;

  const cohortGames = Number(rows[0]?.cohort_games ?? 0);
  const duos = rows.map((x: any) => ({
    champion: x.dimension as string,
    games: Number(x.games ?? 0),
    winrate: Number(x.winrate ?? 0),
    lift: Number(x.lift ?? 0),
  }));
  return { duos, primaryRole, partnerRole: partnerRole ?? null, cohortGames, patch };
}

async function readDuosL2(client: any, champKey: number): Promise<DuosPayload | null> {
  const r = await client.query(
    `SELECT payload FROM cbs_duos WHERE champ_key = $1 AND computed_at > now() - interval '${L2_FRESH}'`,
    [champKey]
  );
  return (r.rows[0]?.payload as DuosPayload) ?? null;
}

export async function upsertDuosL2(client: any, champKey: number, payload: DuosPayload): Promise<void> {
  await client.query(
    `INSERT INTO cbs_duos (champ_key, payload, computed_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (champ_key) DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()`,
    [champKey, JSON.stringify(payload)]
  );
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

    const client = await explorerPool().connect();
    let payload: DuosPayload;
    try {
      await client.query("SET statement_timeout = 20000");
      const cached = await readDuosL2(client, champKey);
      if (cached) {
        payload = cached;
      } else {
        // single-threaded: the Explorer self-join's parallel workers exhaust the
        // supabase-db 64MB /dev/shm under concurrent load.
        await client.query("SET max_parallel_workers_per_gather = 0");
        payload = await computeDuos(client, champKey, championName);
        try { await upsertDuosL2(client, champKey, payload); } catch { /* non-fatal */ }
      }
    } finally {
      client.release();
    }

    cache.set(champKey, { ts: Date.now(), payload });
    return Response.json(payload);
  } catch (e: any) {
    console.error("❌ getChampionDuos exception:", e?.message ?? e);
    return Response.json({ error: "Failed to compute duos" }, { status: 500 });
  }
}
