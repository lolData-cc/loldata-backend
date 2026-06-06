// src/server/routes/getMatchTimeline.ts
//
// POST /api/matchtimeline
// Body: { matchId: string, region: string }
// Returns: { timeline: MatchTimelineDTO }
//
// Caching strategy:
//   Match timelines are IMMUTABLE once the game has ended. There is
//   zero reason to re-fetch the same matchId after the first hit.
//   We keep an in-process LRU bounded at MAX_ENTRIES — each timeline
//   is ~200-800 KB JSON; 500 entries ≈ 100-400 MB RSS which is fine
//   on Railway. Bigger lobbies / heavier load can lift the cap.
//
// We intentionally do NOT persist to Supabase here. Disk-cached blobs
// would be nicer but they're ops overhead we don't need yet — the
// MatchReplayDialog frontend mainly re-opens the same handful of
// matches per session, which the in-memory map handles trivially.

import { getMatchTimeline } from "../riot"

type Cached = { timeline: any; ts: number }

const MAX_ENTRIES = 500
const cache = new Map<string, Cached>()

function cacheGet(key: string): any | null {
  const hit = cache.get(key)
  if (!hit) return null
  // Move-to-end for LRU recency.
  cache.delete(key)
  cache.set(key, hit)
  return hit.timeline
}

function cacheSet(key: string, timeline: any) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, { timeline, ts: Date.now() })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export async function getMatchTimelineHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { matchId, region } = body as { matchId?: string; region?: string }

    if (!matchId || !region) {
      console.error("❌ Missing matchId or region")
      return new Response("Missing matchId or region", { status: 400 })
    }

    const cacheKey = `${region.toUpperCase()}::${matchId}`
    const cached = cacheGet(cacheKey)
    if (cached) {
      return Response.json({ timeline: cached, cached: true })
    }

    const timeline = await getMatchTimeline(matchId, region)
    cacheSet(cacheKey, timeline)
    return Response.json({ timeline, cached: false })
  } catch (err) {
    console.error("❌ Error in getMatchTimelineHandler:", err)
    return new Response("Internal server error", { status: 500 })
  }
}
