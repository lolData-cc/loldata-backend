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
    const today = new Date().toISOString().split("T")[0];

    console.log(`📊 Generating tier list snapshot for patch ${patch}, date ${today}`);

    // Use DB-side aggregation instead of fetching all rows into memory
    const { data: aggRows, error: aggErr } = await supabaseAdmin.rpc("aggregate_tierlist_data");

    // If the RPC doesn't exist, fall back to a raw query approach
    let rows: { champion_id: number; champion_name: string; role: string; region: string; games: number; wins: number }[];

    if (aggErr || !aggRows) {
      console.log("RPC not available, using direct participants aggregation...");

      {
        // Aggregate directly from participants table (skip stale materialized view)
        rows = [];
        const PAGE_SIZE = 50000;
        let offset = 0;
        const agg = new Map<string, { champion_id: number; champion_name: string; role: string; region: string; games: number; wins: number }>();

        while (true) {
          const { data: page, error: pgErr } = await supabaseAdmin
            .from("participants")
            .select("match_id, champion_id, champion_name, role, win")
            .not("role", "is", null)
            .not("role", "eq", "")
            .range(offset, offset + PAGE_SIZE - 1);

          if (pgErr) {
            console.error("❌ Participants query error:", pgErr.message);
            break;
          }
          if (!page?.length) {
            console.log(`  No more rows at offset ${offset}`);
            break;
          }
          console.log(`  Fetched ${page.length} rows at offset ${offset}`);

          for (const p of page) {
            const role = normalizeRole(p.role);
            if (!role) continue;
            const mr = matchRegion(p.match_id);

            // Per-region
            if (["EUW", "NA", "KR"].includes(mr)) {
              const key = `${mr}:${p.champion_id}:${role}`;
              let e = agg.get(key);
              if (!e) { e = { champion_id: p.champion_id, champion_name: p.champion_name, role, region: mr, games: 0, wins: 0 }; agg.set(key, e); }
              e.games++;
              if (p.win) e.wins++;
            }

            // Global
            const gKey = `ALL:${p.champion_id}:${role}`;
            let ge = agg.get(gKey);
            if (!ge) { ge = { champion_id: p.champion_id, champion_name: p.champion_name, role, region: "ALL", games: 0, wins: 0 }; agg.set(gKey, ge); }
            ge.games++;
            if (p.win) ge.wins++;
          }

          if (page.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
          console.log(`  ... processed ${offset} participants`);
        }

        rows = Array.from(agg.values());
      }
    } else {
      rows = aggRows as any[];
    }

    console.log(`📦 Aggregated ${rows.length} champion-role entries`);

    // Fill in missing champion names from Data Dragon
    const missingNames = rows.some(r => !r.champion_name);
    if (missingNames) {
      console.log("⚠️ Some champion names are empty, fetching from Data Dragon...");
      try {
        const ddragonRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
        const versions = await ddragonRes.json() as string[];
        const latestPatch = versions[0];
        const champRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latestPatch}/data/en_US/champion.json`);
        const champData = await champRes.json() as { data: Record<string, { key: string; id: string }> };
        const idMap = new Map<number, string>();
        for (const c of Object.values(champData.data)) {
          idMap.set(Number(c.key), c.id);
        }
        for (const r of rows) {
          if (!r.champion_name && idMap.has(r.champion_id)) {
            r.champion_name = idMap.get(r.champion_id)!;
          }
        }
        console.log(`✅ Filled champion names from Data Dragon (patch ${latestPatch})`);
      } catch (e) {
        console.error("Failed to fetch champion names from Data Dragon:", e);
      }
    }

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
          // PR multiplier: steeper penalty for low pickrate
          // - Below 1% PR: heavily penalized (down to 0.2x)
          // - 1-3% PR: moderate scaling (0.5x to 1.0x)
          // - Above 3% PR: bonus up to 1.3x for very popular picks
          let prMult: number;
          if (pickrate < 0.01) {
            prMult = 0.2 + (pickrate / 0.01) * 0.3; // 0.2 → 0.5
          } else if (pickrate < 0.03) {
            prMult = 0.5 + ((pickrate - 0.01) / 0.02) * 0.5; // 0.5 → 1.0
          } else {
            prMult = 1.0 + Math.min((pickrate - 0.03) / 0.07, 1.0) * 0.3; // 1.0 → 1.3
          }
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
