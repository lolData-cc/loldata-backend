// src/server/routes/getTierlist.ts
// Generates daily tier list snapshots (per-region) and serves them via API.

import { supabaseAdmin } from "../supabase/client";

const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] as const;
const SNAPSHOT_REGIONS = ["ALL", "EUW", "NA", "KR"] as const;
const MIN_GAMES = 200;

// Platform prefix → region mapping
const PLATFORM_TO_REGION: Record<string, string> = {
  euw1: "EUW", euw: "EUW",
  na1: "NA", na: "NA",
  kr: "KR",
};

function matchRegion(matchId: string): string {
  const prefix = matchId.split("_")[0]?.toLowerCase() ?? "";
  return PLATFORM_TO_REGION[prefix] ?? "OTHER";
}

// ── Cache for GET requests ──
const _cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

// ── Resolve latest patch from matches table ──
async function getLatestPatch(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("matches")
    .select("game_version")
    .order("game_creation", { ascending: false })
    .limit(1)
    .single();
  if (!data?.game_version) return "16.6";
  return String(data.game_version).split(".").slice(0, 2).join(".");
}

// ── Assign tier labels based on percentile position ──
function assignTier(rank: number, total: number): string {
  const pct = rank / total;
  if (pct <= 0.05) return "S";
  if (pct <= 0.20) return "A";
  if (pct <= 0.50) return "B";
  if (pct <= 0.80) return "C";
  return "D";
}

// ── POST /api/tierlist/snapshot — Generate today's snapshot for all regions ──
export async function generateSnapshotHandler(req: Request): Promise<Response> {
  try {
    const patch = await getLatestPatch();
    const patchPrefix = patch + ".";
    const today = new Date().toISOString().split("T")[0];

    console.log(`📊 Generating tier list snapshot for patch ${patch}, date ${today}`);

    // Paginate to get ALL solo queue match IDs
    // Include all matches (many have null game_version from cron ingestion)
    const allMatchIds: string[] = [];
    let from = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data: page, error: pgErr } = await supabaseAdmin
        .from("matches")
        .select("match_id")
        .eq("queue_id", 420)
        .range(from, from + PAGE_SIZE - 1);
      if (pgErr || !page?.length) break;
      allMatchIds.push(...page.map((m) => m.match_id));
      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    console.log(`📦 Found ${allMatchIds.length} total solo queue matches`);
    if (allMatchIds.length === 0) {
      return Response.json({ error: "No solo queue matches found" }, { status: 404 });
    }

    // Batch-fetch participants
    const BATCH = 200;
    const allParts: { match_id: string; champion_id: number; champion_name: string; role: string; win: boolean }[] = [];
    for (let i = 0; i < allMatchIds.length; i += BATCH) {
      const batch = allMatchIds.slice(i, i + BATCH);
      const { data: parts, error: pErr } = await supabaseAdmin
        .from("participants")
        .select("match_id, champion_id, champion_name, role, win")
        .in("match_id", batch);
      if (pErr) { console.error(`❌ Participants batch ${i} error:`, pErr.message); continue; }
      if (parts) allParts.push(...(parts as any));
    }
    console.log(`👥 Found ${allParts.length} participants`);

    // Build match→region map
    const matchRegionMap = new Map<string, string>();
    for (const id of allMatchIds) {
      matchRegionMap.set(id, matchRegion(id));
    }

    // Aggregate per (region, champion, role) — both per-region AND global "ALL"
    type AggKey = string;
    type AggVal = { champion_id: number; champion_name: string; role: string; region: string; games: number; wins: number };
    const agg = new Map<AggKey, AggVal>();

    for (const p of allParts) {
      const role = normalizeRole(p.role);
      if (!role) continue;
      const mr = matchRegionMap.get(p.match_id) ?? "OTHER";

      // Per-region entry
      if (PLATFORM_TO_REGION[mr.toLowerCase()] || mr === "EUW" || mr === "NA" || mr === "KR") {
        const key = `${mr}:${p.champion_id}:${role}`;
        let e = agg.get(key);
        if (!e) { e = { champion_id: p.champion_id, champion_name: p.champion_name, role, region: mr, games: 0, wins: 0 }; agg.set(key, e); }
        e.games++;
        if (p.win) e.wins++;
      }

      // Global "ALL" entry
      const gKey = `ALL:${p.champion_id}:${role}`;
      let ge = agg.get(gKey);
      if (!ge) { ge = { champion_id: p.champion_id, champion_name: p.champion_name, role, region: "ALL", games: 0, wins: 0 }; agg.set(gKey, ge); }
      ge.games++;
      if (p.win) ge.wins++;
    }

    const rows = Array.from(agg.values());

    // Group by region+role, compute totals, tier scores, tiers
    const upsertRows: any[] = [];

    for (const region of SNAPSHOT_REGIONS) {
      const regionRows = rows.filter(r => r.region === region);
      const totalPerRole = new Map<string, number>();
      for (const r of regionRows) {
        totalPerRole.set(r.role, (totalPerRole.get(r.role) ?? 0) + r.games);
      }

      // Group by role
      const byRole = new Map<string, typeof regionRows>();
      for (const r of regionRows) {
        if (r.games < MIN_GAMES) continue;
        if (!byRole.has(r.role)) byRole.set(r.role, []);
        byRole.get(r.role)!.push(r);
      }

      for (const [role, entries] of byRole) {
        const totalGames = totalPerRole.get(role) ?? 1;

        const scored = entries.map(e => {
          const winrate = e.wins / e.games;
          const pickrate = e.games / totalGames;
          // Bayesian-adjusted WR: pulls toward 50% for small samples
          // C = confidence parameter (higher = more shrinkage for small samples)
          const C = 200
          const adjWr = (e.wins + C * 0.5) / (e.games + C)
          // PR multiplier: sub-2% PR gets penalized, above 2% is full score
          const prMult = pickrate >= 0.02 ? 1.0 : 0.6 + (pickrate / 0.02) * 0.4
          const tier_score = ((adjWr - 0.5) * 100) * prMult;
          return {
            ...e,
            winrate: Math.round(winrate * 10000) / 100,
            pickrate: Math.round(pickrate * 10000) / 100,
            tier_score: Math.round(tier_score * 10000) / 10000,
          };
        });

        scored.sort((a, b) => b.tier_score - a.tier_score);

        scored.forEach((e, idx) => {
          upsertRows.push({
            snapshot_date: today,
            patch,
            region,
            role,
            champion_id: e.champion_id,
            champion_name: e.champion_name,
            games: e.games,
            wins: e.wins,
            winrate: e.winrate,
            pickrate: e.pickrate,
            tier_score: e.tier_score,
            tier: assignTier(idx, scored.length),
            tier_rank: idx + 1,
          });
        });
      }
    }

    if (upsertRows.length === 0) {
      return Response.json({ error: "No data to snapshot" }, { status: 400 });
    }

    // Delete today's old data first (in case MIN_GAMES changed and stale rows remain)
    await supabaseAdmin.from("tierlist_snapshots").delete().eq("snapshot_date", today);

    // Insert in batches
    const UPSERT_BATCH = 500;
    for (let i = 0; i < upsertRows.length; i += UPSERT_BATCH) {
      const batch = upsertRows.slice(i, i + UPSERT_BATCH);
      const { error: uErr } = await supabaseAdmin
        .from("tierlist_snapshots")
        .upsert(batch, { onConflict: "snapshot_date,region,role,champion_id" });
      if (uErr) {
        console.error("❌ Tierlist upsert error:", uErr);
      }
    }

    // Clear cache
    _cache.clear();

    const summary: Record<string, number> = {};
    for (const r of SNAPSHOT_REGIONS) {
      summary[r] = upsertRows.filter(row => row.region === r).length;
    }

    console.log(`✅ Tier list snapshot generated: ${upsertRows.length} entries`, summary);
    return Response.json({ ok: true, date: today, patch, entries: upsertRows.length, perRegion: summary });

  } catch (err: any) {
    console.error("❌ generateSnapshot error:", err);
    return new Response("Internal error", { status: 500 });
  }
}

// ── GET /api/tierlist?role=JUNGLE&region=EUW&date=2026-03-25 ──
export async function getTierlistHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const role = (url.searchParams.get("role") ?? "JUNGLE").toUpperCase();
    const region = (url.searchParams.get("region") ?? "ALL").toUpperCase();
    const dateParam = url.searchParams.get("date");

    const cacheKey = `${region}:${role}:${dateParam ?? "latest"}`;
    const cached = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return Response.json(cached.data);
    }

    let query = supabaseAdmin
      .from("tierlist_snapshots")
      .select("*")
      .eq("role", role)
      .eq("region", region)
      .order("tier_rank", { ascending: true });

    if (dateParam) {
      query = query.eq("snapshot_date", dateParam);
    } else {
      const { data: latest } = await supabaseAdmin
        .from("tierlist_snapshots")
        .select("snapshot_date")
        .eq("region", region)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .single();

      if (!latest) {
        return Response.json({ snapshot_date: null, patch: null, champions: [] });
      }
      query = query.eq("snapshot_date", latest.snapshot_date);
    }

    const { data, error } = await query;
    if (error) {
      console.error("❌ getTierlist query error:", error);
      return Response.json({ snapshot_date: null, patch: null, champions: [] });
    }

    const result = {
      snapshot_date: data?.[0]?.snapshot_date ?? null,
      patch: data?.[0]?.patch ?? null,
      region,
      champions: data ?? [],
    };

    _cache.set(cacheKey, { data: result, ts: Date.now() });
    return Response.json(result);

  } catch (err: any) {
    console.error("❌ getTierlist error:", err);
    return new Response("Internal error", { status: 500 });
  }
}

// ── Normalize Riot role strings ──
function normalizeRole(role: string | null): string | null {
  if (!role) return null;
  const r = role.toUpperCase();
  const map: Record<string, string> = {
    TOP: "TOP", JUNGLE: "JUNGLE", MIDDLE: "MIDDLE", MID: "MIDDLE",
    BOTTOM: "BOTTOM", ADC: "BOTTOM", UTILITY: "UTILITY", SUPPORT: "UTILITY", SUP: "UTILITY",
  };
  return map[r] ?? null;
}
