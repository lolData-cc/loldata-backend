// src/server/explorer/query.ts
//
// POST /api/explorer/query — body is an ExplorerGraph (the node editor's
// normalized output). Compiles it to SQL, runs it on the pg pool, returns
// { columns, rows, meta }. A per-query statement_timeout keeps a pathological
// graph from hanging a connection.

import { compile, type ExplorerGraph } from "./compile";
import { explorerPool, currentPatchPrefix, recentPatches } from "./pool";
import { readPatchVariation, rebuildPatchStats, type PatchStatRow } from "./patchStats";

export async function explorerQueryHandler(req: Request): Promise<Response> {
  let graph: ExplorerGraph;
  try {
    graph = (await req.json()) as ExplorerGraph;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!graph?.subject?.champion) {
    return Response.json({ error: "A Subject champion is required" }, { status: 400 });
  }
  if (!graph.output?.kind) {
    return Response.json({ error: "An Output node is required" }, { status: 400 });
  }

  const t0 = Date.now();
  let client: Awaited<ReturnType<ReturnType<typeof explorerPool>["connect"]>> | undefined;
  try {
    const patch = await currentPatchPrefix();
    const { text, params, mode } = compile(graph, patch);

    client = await explorerPool().connect();
    await client.query("SET statement_timeout = 20000"); // 20s hard cap
    const r = await client.query(text, params);

    const ms = Date.now() - t0;
    const columns = r.fields.map((f) => f.name);
    const rows = r.rows;
    const games =
      graph.output.kind === "stats"
        ? Number((rows[0] as any)?.games ?? 0)
        : rows.reduce((sum, x: any) => sum + Number(x.games ?? 0), 0);

    return Response.json({ columns, rows, meta: { games, ms, mode, patch } });
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    console.error("[explorer] query error:", msg);
    const friendly = /statement timeout|canceling statement/i.test(msg)
      ? "Query too heavy — narrow it (current patch, a tier filter, or more constraints)."
      : "Query failed — check the graph and try again.";
    return Response.json({ error: friendly }, { status: 500 });
  } finally {
    client?.release();
  }
}

// POST /api/explorer/patches — FAST, subject-level patch variation read straight
// from the precomputed `explorer_patch_stats` table. Honours the subject's
// champion + role and the Filter module's tiers; does NOT reflect ally/item/rune
// constraints (the frontend offers the slow /exact path for those). Instant.
export async function explorerPatchHandler(req: Request): Promise<Response> {
  let graph: ExplorerGraph;
  try {
    graph = (await req.json()) as ExplorerGraph;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!graph?.subject?.champion) {
    return Response.json({ error: "A Subject champion is required" }, { status: 400 });
  }
  try {
    const rows = await readPatchVariation(graph);
    return Response.json({ rows, exact: false });
  } catch (e: any) {
    console.error("[explorer] patch-variation read error:", String(e?.message ?? ""));
    return Response.json({ error: "Patch variation failed." }, { status: 500 });
  }
}

// POST /api/admin/rebuild-patch-stats — refresh the precomputed table (full
// re-aggregation). Run alongside the snapshot rebuild; not on the request path.
export async function rebuildPatchStatsHandler(_req: Request): Promise<Response> {
  try {
    const rows = await rebuildPatchStats();
    console.log(`[explorer] explorer_patch_stats rebuilt: ${rows} rows`);
    return Response.json({ ok: true, rows });
  } catch (e: any) {
    console.error("[explorer] rebuild-patch-stats error:", String(e?.message ?? ""));
    return Response.json({ error: "Rebuild failed." }, { status: 500 });
  }
}

// POST /api/explorer/patches/exact — SLOW, honours the full graph (ally/item/rune
// constraints) by running the tuned single-patch `stats` query once per recent
// patch. Sequential on ONE connection: the first (cold) patch warms the
// champion's participant rows so later patches read warm (~2.5s vs ~20s cold);
// running them in parallel while cold makes them contend and trip the timeout.
// A patch that errors/times out is dropped; an overall deadline bounds the total.
function comparePatch(a: string, b: string): number {
  const [a1, a2] = a.split(".").map(Number);
  const [b1, b2] = b.split(".").map(Number);
  return (a1 - b1) || ((a2 || 0) - (b2 || 0));
}

export async function explorerPatchExactHandler(req: Request): Promise<Response> {
  let graph: ExplorerGraph;
  try {
    graph = (await req.json()) as ExplorerGraph;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!graph?.subject?.champion) {
    return Response.json({ error: "A Subject champion is required" }, { status: 400 });
  }
  // Each patch is one forced current-patch query — the patch IS the axis here.
  const perPatch: ExplorerGraph = {
    ...graph,
    filters: { ...graph.filters, scope: "current_patch" },
    output: { kind: "stats" },
  };

  const patches = await recentPatches(6); // newest-first
  if (!patches.length) return Response.json({ rows: [], patches: [], exact: true });

  // Sequential on ONE connection: the first (cold) patch warms the champion's
  // participant rows in shared buffers, so every later patch reads warm (~2.5s
  // vs ~20s cold). Running them in parallel while cold makes them contend and
  // all trip the timeout. A patch that errors/times out is dropped; an overall
  // deadline bounds the total so a pathological graph can't hang the request.
  const rows: PatchStatRow[] = [];
  let client: Awaited<ReturnType<ReturnType<typeof explorerPool>["connect"]>> | undefined;
  try {
    client = await explorerPool().connect();
    await client.query("SET statement_timeout = 15000"); // 15s per patch
    const deadline = Date.now() + 24_000; // stop starting new patches after 24s

    for (const patch of patches) {
      if (Date.now() > deadline) break;
      try {
        const { text, params } = compile(perPatch, patch);
        const r = await client.query(text, params);
        const row = (r.rows[0] ?? {}) as any;
        if (Number(row.games ?? 0) > 0) {
          rows.push({
            patch,
            games: Number(row.games),
            winrate: row.winrate ?? null,
            avg_kills: row.avg_kills ?? null,
            avg_deaths: row.avg_deaths ?? null,
            avg_assists: row.avg_assists ?? null,
            avg_cs: row.avg_cs ?? null,
            avg_gold: row.avg_gold ?? null,
          });
        }
      } catch (e: any) {
        // statement_timeout only cancels the statement; the session stays usable
        // for the next patch (whose reads are now partly warmed). Drop and move on.
        console.warn(`[explorer] patch-variation ${patch} dropped:`, String(e?.message ?? ""));
      }
    }
  } catch (e: any) {
    console.error("[explorer] patch-variation error:", String(e?.message ?? ""));
    return Response.json({ error: "Patch variation failed." }, { status: 500 });
  } finally {
    client?.release();
  }

  rows.sort((a, b) => comparePatch(a.patch, b.patch)); // oldest → newest
  return Response.json({ rows, patches, exact: true });
}
