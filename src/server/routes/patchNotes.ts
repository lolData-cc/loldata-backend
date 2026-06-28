// src/server/routes/patchNotes.ts
// GET /api/patch-notes?patch=16.13 → the computed changelog for the /patch-notes
// page: the patch list (selector), the change rows, and any scraped champion
// prose. Read-only — the diff sweep (startPatchDiffSweep) populates the data.

import { listPatches, patchChangesFor, proseFor, startPatchDiffSweep } from "../services/patchDiff";

export async function patchNotesHandler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const patches = await listPatches();
    const patch = url.searchParams.get("patch") || patches[0];
    if (!patch) {
      startPatchDiffSweep(); // not computed yet → kick it off, return empty for now
      return Response.json({ patch: null, patches: [], changes: [], prose: {} });
    }
    const [changes, prose] = await Promise.all([
      patchChangesFor({ patch, limit: 2000 }),
      proseFor(patch),
    ]);
    return Response.json({ patch, patches, changes, prose });
  } catch (err) {
    console.error("patch-notes error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
