// src/routes/getChampionStats.ts
import { supabaseMatchAdmin as supabaseAdmin } from "../supabase/client"; // match data → box (hybrid)
import { explorerPool } from "../explorer/pool"; // raw pg for the patch/region filter path
type ChampionStatsBody = {
  championId?: number | string;
  champion?: string | null; // DDragon name — needed for the live patch/region path
  patch?: string | null;
  region?: string | null;
  queueId?: number | null;
  role?: string | null;
  tier?: string | null;
  opponents?: { championId: number; role?: string | null; itemId?: number | null }[] | null;
};
const CACHE_TTL_MS = Number(process.env.CHAMP_STATS_CACHE_TTL_MS ?? "300000"); // 5 min
const _cache = new Map<string, { exp: number; value: unknown }>();
function cacheGet(key: string) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key: string, value: unknown) {
  _cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
}

// ── Snapshot preload cache ──────────────────────────────────
// Key: "champId:role:tier" → snapshot data. Rebuilt into a fresh map on each
// (re)load and swapped in atomically, so a reload never serves a half-empty
// cache. `let` (not `const`) so the swap can replace the reference.
let _snapCache = new Map<string, any>();
let _snapLoaded = false;

function snapKey(champId: number, role: string, tier: string | null) {
  return `${champId}:${role}:${tier ?? "ALL"}`;
}

export function getSnap(champId: number, role: string, tier: string | null) {
  return _snapCache.get(snapKey(champId, role, tier)) ?? null;
}

export function getChampRoles(champId: number): { role: string; games: number }[] {
  const roles: { role: string; games: number }[] = [];
  for (const [key, data] of _snapCache.entries()) {
    if (key.startsWith(`${champId}:`) && key.endsWith(":ALL")) {
      const role = key.split(":")[1];
      roles.push({ role, games: data?.core?.gamesAnalyzed ?? 0 });
    }
  }
  return roles.sort((a, b) => b.games - a.games);
}

export async function preloadSnapshots() {
  console.log("⏳ Preloading champion snapshots...");
  const t0 = Date.now();

  // Fetch in pages to avoid timeout
  const PAGE = 200;
  let offset = 0;
  let total = 0;
  const seen = new Set<string>();
  const next = new Map<string, any>(); // built fresh, swapped in at the end

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("champion_stats_snapshots")
      .select("champion_id, role, tier, data, snapshot_date")
      // snapshot_date alone is NOT unique — paginating a non-unique sort makes
      // PostgREST reorder rows across .range() pages, silently skipping some and
      // picking the wrong "latest". The (champion_id, role, tier) tiebreaker makes
      // the total order deterministic so pagination is stable. Without it the cache
      // was loading 549/579 keys and mis-dating champions (e.g. Jinx → stale row).
      .order("snapshot_date", { ascending: false })
      .order("champion_id", { ascending: true })
      .order("role", { ascending: true })
      .order("tier", { ascending: true, nullsFirst: false })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error(`❌ Snapshot preload failed at offset ${offset}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      const k = snapKey(row.champion_id, row.role, row.tier);
      if (seen.has(k)) continue;
      seen.add(k);
      next.set(k, row.data);
    }

    total += data.length;
    offset += PAGE;
    if (data.length < PAGE) break;
  }

  _snapCache = next; // atomic swap — readers never observe a half-built cache
  _snapLoaded = true;
  console.log(`✅ Preloaded ${_snapCache.size} snapshots (${total} rows) in ${Date.now() - t0}ms`);
}
function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── resolve latest patch from DB (cached) ──────────────────
let _latestPatch: { value: string; exp: number } | null = null;
async function getLatestPatch(): Promise<string | null> {
  if (_latestPatch && Date.now() < _latestPatch.exp) return _latestPatch.value;
  const { data } = await supabaseAdmin
    .from("matches")
    .select("game_version")
    .order("game_creation", { ascending: false })
    .limit(1)
    .single();
  if (data?.game_version) {
    // "15.13.548.9786" → "15.13"
    const short = String(data.game_version).split(".").slice(0, 2).join(".");
    // cache for 10 min — patch doesn't change often
    _latestPatch = { value: short, exp: Date.now() + 600_000 };
    return short;
  }
  return null;
}

// ── live TOTAL games for a champion (all roles / queues / patches in the box),
// cached briefly. The default snapshot path only knows the per-role sample
// (e.g. mid = 4.2k) from the nightly rebuild, which badly undercounts a fresh,
// heavily-played champion. This is the same count the Explorer reports, so the
// hero "Games" stat matches reality. Index-only scan on idx_participants_champion.
const _totalGamesCache = new Map<number, { value: number; exp: number }>();
async function getChampionTotalGames(champNum: number): Promise<number | null> {
  const hit = _totalGamesCache.get(champNum);
  if (hit && Date.now() < hit.exp) return hit.value;
  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 8000");
    const r = await client.query(
      `SELECT count(*)::int AS games FROM participants WHERE champion_id = $1`,
      [champNum],
    );
    const games = Number(r.rows?.[0]?.games ?? 0);
    _totalGamesCache.set(champNum, { value: games, exp: Date.now() + 300_000 }); // 5 min
    return games;
  } catch {
    return null; // never break the stats response over the headline count
  } finally {
    client.release();
  }
}
// ── Live patch/region filter path ───────────────────────────────────
// The precomputed snapshots have NO patch/region dimension, and the legacy
// get_champion_stats_full RPC ignores those params (and is heavy → 500s). So when
// a patch and/or region filter is set we compute the FILTERABLE stats — core
// (winrate / KDA / CS / gold / dmg), items and runes — live from `participants`,
// scoped to the chosen patch/region/role/tier via the same matches semi-join the
// Explorer uses. The heavy season analytics (matchups, synergies, objectives,
// game phases) have no cheap per-patch/region form, so they're carried over from
// the season snapshot and the UI labels them as season-wide.
async function computeFilteredStats(opts: {
  champName: string;
  champNum: number;
  role: string | null;
  tier: string | null;
  patch: string | null;
  region: string | null;
  queueId: number;
}): Promise<any | null> {
  const { champName, champNum, tier, patch, region, queueId } = opts;
  let role = opts.role;
  if (!role) {
    const rs = getChampRoles(champNum);
    role = rs.length ? rs[0].role : null;
  }

  // Build a single parameterized cohort predicate reused by all three queries.
  const params: any[] = [champName];
  const cohort: string[] = [`champion_name = $1`];
  if (role) { params.push(role); cohort.push(`role = $${params.length}`); }
  if (tier) { params.push(tier); cohort.push(`tier = $${params.length}`); }
  const match: string[] = [];
  if (patch) { params.push(patch); match.push(`patch = $${params.length}`); }
  if (region) { params.push(region); match.push(`platform = $${params.length}`); }
  params.push([queueId]); match.push(`queue_id = ANY($${params.length})`);
  const matchSelect = `SELECT match_id FROM matches WHERE ${match.join(" AND ")}`;
  // patch-scoped → ARRAY() so the planner index-seeks idx_participants_cname_match;
  // region-only (no patch) → plain IN to avoid materialising a huge all-patch array.
  cohort.push(patch ? `match_id = ANY(ARRAY(${matchSelect}))` : `match_id IN (${matchSelect})`);
  const where = cohort.join(" AND ");

  const client = await explorerPool().connect();
  try {
    await client.query("SET statement_timeout = 12000");

    const coreR = await client.query(
      `SELECT count(*)::int AS games,
              round(avg((win)::int) * 100, 2)::float8 AS winrate,
              round(avg(kills), 2)::float8 AS k,
              round(avg(deaths), 2)::float8 AS d,
              round(avg(assists), 2)::float8 AS a,
              round(avg(total_cs), 1)::float8 AS cs,
              round(avg(gold_earned))::int AS gold,
              round(avg(total_damage_to_champions))::int AS dmg
       FROM participants WHERE ${where}`,
      params
    );
    const c = coreR.rows[0] || {};
    const games = Number(c.games || 0);
    if (!games) return null;

    const itemsR = await client.query(
      `SELECT item AS item_id, count(*)::int AS games, sum((win)::int)::int AS wins,
              round(avg((win)::int) * 100, 2)::float8 AS winrate
       FROM (SELECT unnest(ARRAY[item0,item1,item2,item3,item4,item5,item6]) AS item, win
             FROM participants WHERE ${where}) t
       WHERE item > 0 GROUP BY item ORDER BY games DESC LIMIT 25`,
      params
    );

    const runesR = await client.query(
      `SELECT perk_keystone, perk_primary_style, perk_sub_style,
              count(*)::int AS games, sum((win)::int)::int AS wins,
              round(avg((win)::int) * 100, 2)::float8 AS winrate
       FROM participants WHERE ${where} AND perk_keystone IS NOT NULL
       GROUP BY perk_keystone, perk_primary_style, perk_sub_style
       ORDER BY games DESC LIMIT 12`,
      params
    );

    const pr = (g: number) => Math.round((g / games) * 1000) / 10;
    const items = itemsR.rows.map((r: any) => ({
      item_id: Number(r.item_id), games: Number(r.games), wins: Number(r.wins),
      winrate: Number(r.winrate), pick_rate: pr(Number(r.games)),
    }));
    const runes = runesR.rows.map((r: any) => ({
      perk_keystone: Number(r.perk_keystone), perk_primary_style: Number(r.perk_primary_style),
      perk_sub_style: Number(r.perk_sub_style), games: Number(r.games), wins: Number(r.wins),
      winrate: Number(r.winrate), pick_rate: pr(Number(r.games)),
    }));

    // Heavy analytics: carry from the season snapshot (no patch/region form).
    const snap: any = role ? getSnap(champNum, role, tier ?? null) : null;

    return {
      core: {
        winrate: Number(c.winrate ?? 0),
        pickrate: null, // not computed in the filtered path
        banrate: null,
        gamesAnalyzed: games,
        avgKDA: { kills: Number(c.k ?? 0), deaths: Number(c.d ?? 0), assists: Number(c.a ?? 0) },
        avgCS: Number(c.cs ?? 0),
        avgGold: Number(c.gold ?? 0),
        avgDamage: Number(c.dmg ?? 0),
      },
      items,
      runes,
      bestMatchups: snap?.bestMatchups ?? null,
      worstMatchups: snap?.worstMatchups ?? null,
      bestSynergies: snap?.bestSynergies ?? null,
      worstCounters: snap?.worstCounters ?? null,
      gamePhaseWinrates: snap?.gamePhaseWinrates ?? null,
      objectiveWinrates: snap?.objectiveWinrates ?? null,
      dragonSoulWinrates: snap?.dragonSoulWinrates ?? null,
      meta: { patch: patch ?? null, queueId, lastUpdatedUtc: new Date().toISOString(), role, filtered: true },
    };
  } finally {
    client.release();
  }
}

export async function getChampionStatsHandler(req: Request): Promise<Response> {
  const requestId =
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    crypto.randomUUID();
  try {
    const raw = await req.text();
    const body: ChampionStatsBody | null = raw ? (safeJson(raw) as any) : null;
    const championId = body?.championId;
    const rawPatch = body?.patch ?? null;
    const patch = rawPatch || null; // null = use materialized views (fast path)
    const region = body?.region ?? null;
    const queueId = body?.queueId ?? 420;
    const role = body?.role ?? null;
    const tier = body?.tier ?? null;
    const opponents = body?.opponents?.length ? body.opponents : null;
    // champion NAME (DDragon id, e.g. "Senna") — participants is keyed by name,
    // not numeric id. Required for the live patch/region path.
    const champName = typeof body?.champion === "string" && body.champion.trim() ? body.champion.trim() : null;
    if (championId === undefined || championId === null || championId === "") {
      return new Response("Missing championId", { status: 400 });
    }
    const champNum = Number(championId);
    if (!Number.isFinite(champNum) || champNum <= 0) {
      return new Response("Invalid championId", { status: 400 });
    }
    const roleNorm = role ? String(role).toUpperCase() : null;
    const cacheKey = `champStats:${champNum}:${patch ?? "any"}:${region ?? "all"}:${queueId}:${roleNorm ?? "any"}:${tier ?? "any"}:${JSON.stringify(opponents ?? [])}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return Response.json(cached, {
        headers: {
          "x-cache": "HIT",
          "x-request-id": requestId,
        },
      });
    }
    const t0 = Date.now();

    // Fast path: serve from preloaded snapshot cache
    if (!opponents && !region && !patch && _snapLoaded) {
      let effectiveRole = roleNorm;
      if (!effectiveRole) {
        const roles = getChampRoles(champNum);
        if (roles.length) effectiveRole = roles[0].role;
      }

      if (effectiveRole) {
        const snapData = getSnap(champNum, effectiveRole, tier ?? null);
        if (snapData) {
          const ms = Date.now() - t0;
          // Headline "Games" = live total across ALL roles (not just this
          // snapshot's primary-role sample). Additive: existing fields untouched.
          const totalGames = await getChampionTotalGames(champNum);
          const out = totalGames != null ? { ...snapData, totalGames } : snapData;
          console.log(`✅ champion stats from snapshot (${ms}ms)`, { champNum, roleNorm: effectiveRole, tier: tier ?? "ALL" });
          cacheSet(cacheKey, out);
          return Response.json(out, {
            headers: {
              "x-cache": "SNAPSHOT",
              "x-request-id": requestId,
              "server-timing": `db;dur=${ms}`,
            },
          });
        }
      }
    }

    // Patch/region filter path — compute core/items/runes live (the snapshot has
    // no patch/region dimension and the legacy RPC ignores them + 500s). Only for
    // the non-VS case; VS keeps its own fast path below.
    if ((patch || region) && !opponents && champName) {
      try {
        const filtered = await computeFilteredStats({
          champName, champNum, role: roleNorm, tier, patch, region, queueId: queueId ?? 420,
        });
        if (filtered) {
          const ms = Date.now() - t0;
          console.log(`✅ champion stats FILTERED (${ms}ms)`, { champNum, role: roleNorm, tier, patch, region });
          cacheSet(cacheKey, filtered);
          return Response.json(filtered, {
            headers: { "x-cache": "FILTERED", "x-request-id": requestId, "server-timing": `db;dur=${ms}` },
          });
        }
        // No games for this exact filter combo → valid empty payload (UI shows
        // "no data for this filter" instead of erroring).
        return Response.json({
          core: null, items: [], runes: [],
          bestMatchups: null, worstMatchups: null, bestSynergies: null, worstCounters: null,
          gamePhaseWinrates: null, objectiveWinrates: null, dragonSoulWinrates: null,
          meta: { patch: patch ?? null, queueId: queueId ?? 420, lastUpdatedUtc: new Date().toISOString(), role: roleNorm, filtered: true },
        }, { headers: { "x-cache": "FILTERED_EMPTY", "x-request-id": requestId } });
      } catch (e: any) {
        console.error("[champ stats filtered] error:", { requestId, message: String(e?.message ?? e) });
        // fall through to the legacy path
      }
    }

    // Fast path for single opponent: use champion_vs_stats (uses mv_lane_opponents, ~50-200ms)
    if (opponents?.length === 1 && roleNorm) {
      const oppId = opponents[0].championId;
      console.log(`⚡ Fast VS query: ${champNum} vs ${oppId}, role=${roleNorm}, tier=${tier}`);
      const { data: vsData, error: vsErr } = await supabaseAdmin.rpc("champion_vs_stats", {
        p_champion_id: champNum,
        p_opponent_id: oppId,
        p_role: roleNorm,
        p_tier: tier ?? null,
      });
      if (!vsErr && vsData) {
        const ms = Date.now() - t0;
        console.log(`✅ VS stats in ${ms}ms`);
        cacheSet(cacheKey, vsData);
        return Response.json(vsData, {
          headers: {
            "x-cache": "VS_FAST",
            "x-request-id": requestId,
            "server-timing": `db;dur=${ms}`,
          },
        });
      }
    }

    // Slow path: compute live from get_champion_stats_full (fallback)
    console.log(`⏳ Live query for champion ${champNum}, role=${roleNorm}, tier=${tier}, opponents=${JSON.stringify(opponents)}`);
    const { data, error } = await supabaseAdmin.rpc("get_champion_stats_full", {
      p_champion_id: champNum,
      p_role: roleNorm,
      p_tier: tier,
      p_queue_id: queueId ?? 420,
      p_opponents: opponents ?? null,
    });
    const ms = Date.now() - t0;
    if (error) {
      console.error("❌ get_champion_stats_full rpc error", {
        requestId,
        message: error.message,
        details: (error as any).details,
        hint: (error as any).hint,
        code: (error as any).code,
        ms,
        champNum,
        roleNorm,
        tier,
      });
      return new Response("Failed to load champion stats", {
        status: 500,
        headers: { "x-request-id": requestId },
      });
    }
    cacheSet(cacheKey, data);
    return Response.json(data, {
      headers: {
        "x-cache": "MISS",
        "x-request-id": requestId,
        "server-timing": `db;dur=${ms}`,
      },
    });
  } catch (err: any) {
    console.error("Errore in getChampionStatsHandler:", {
      requestId,
      message: err?.message,
      stack: err?.stack,
    });
    return new Response("Errore interno", {
      status: 500,
      headers: { "x-request-id": requestId },
    });
  }
}

// ── GET available patches ──────────────────────────────────
let _patchesCache: { value: string[]; exp: number } | null = null;
export async function getAvailablePatchesHandler(_req: Request): Promise<Response> {
  if (_patchesCache && Date.now() < _patchesCache.exp) {
    return Response.json({ patches: _patchesCache.value });
  }
  const { data, error } = await supabaseAdmin
    .from("matches")
    .select("game_version")
    .order("game_creation", { ascending: false })
    .limit(500);
  if (error || !data) {
    return Response.json({ patches: [] });
  }
  // dedupe & shorten: "15.13.548.9786" → "15.13"
  const seen = new Set<string>();
  const patches: string[] = [];
  for (const row of data) {
    const short = String(row.game_version ?? "").split(".").slice(0, 2).join(".");
    if (short && !seen.has(short)) {
      seen.add(short);
      patches.push(short);
    }
  }
  // cache 10 min
  _patchesCache = { value: patches, exp: Date.now() + 600_000 };
  return Response.json({ patches });
}
