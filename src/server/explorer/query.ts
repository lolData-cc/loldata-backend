// src/server/explorer/query.ts
//
// POST /api/explorer/query — body is an ExplorerGraph (the node editor's
// normalized output). Compiles it to SQL, runs it on the pg pool, returns
// { columns, rows, meta }. A per-query statement_timeout keeps a pathological
// graph from hanging a connection.

import { compile, type ExplorerGraph } from "./compile";
import { explorerPool, currentPatchPrefix } from "./pool";

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
