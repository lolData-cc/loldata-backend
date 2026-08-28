import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client"
import { getAccountByRiotId } from "../riot"

// Shape returned to the frontend for each suggestion. `users` rows have the
// rich fields; scout_lobby_accounts rows fill nulls — the search dialog
// already renders a fallback avatar + "Unranked" when those are missing.
type Suggestion = {
  name: string
  tag: string
  icon_id: number | null
  rank: string | null
  region: string
  // Custom uploaded profile pic (premium). When set, the frontend shows it
  // instead of the LoL profile icon. Enriched from `profile_players` below.
  avatar_url?: string | null
  // Paid tier ("premium" | "elite") for the badge — null/absent = free.
  plan?: string | null
}

export async function autocompleteHandler(req: Request): Promise<Response> {
  const body = await req.json()
  const { query, region } = body

  if (!query || !region) {
    return new Response("Missing query or region", { status: 400 })
  }

  if (query.length < 2) {
    return Response.json({ results: [] })
  }

  // If query contains #, try exact Riot API lookup in parallel with DB search
  const hasTag = query.includes("#")
  let riotResult: Suggestion | null = null

  if (hasTag) {
    const [namePart, tagPart] = query.split("#")
    if (namePart.trim() && tagPart.trim()) {
      try {
        const account = await getAccountByRiotId(namePart.trim(), tagPart.trim(), region)
        if (account) {
          // Check if we have this player in DB for extra info
          const { data: dbRow } = await supabaseMatchAdmin
            .from("users")
            .select("name, tag, icon_id, rank, region")
            .eq("name", account.gameName)
            .eq("tag", account.tagLine)
            .maybeSingle()

          riotResult = dbRow ?? {
            name: account.gameName,
            tag: account.tagLine,
            icon_id: null,
            rank: null,
            region: region.toUpperCase(),
          }
        }
      } catch {
        // Riot lookup failed, continue with DB search
      }
    }
  }

  const searchName = query.split("#")[0].trim()
  const regionUpper = String(region).toUpperCase()

  // Phase 1 — starts-with on BOTH `users` and `scout_lobby_accounts`,
  // in parallel. The original handler only searched `users`, so scout
  // lobby members who had never been opened via the summoner page
  // (= never upserted into `users`) were invisible to the autocomplete
  // even though the rest of the app already knew about them.
  const [usersStartsRes, playersStartsRes, scoutStartsRes] = await Promise.all([
    supabaseMatchAdmin
      .from("users")
      .select("name, tag, icon_id, rank, region")
      .ilike("name", `${searchName}%`)
      .order("last_searched_at", { ascending: false })
      .limit(5),
    // `players` — the ladder-crawled index (every ranked apex player),
    // so search isn't limited to profiles someone happened to open.
    supabaseMatchAdmin
      .from("players")
      .select("game_name, tag_line, icon_id, tier, platform")
      .ilike("game_name", `${searchName}%`)
      .order("lp", { ascending: false, nullsFirst: false })
      .limit(8),
    supabaseMatchAdmin
      .from("scout_lobby_accounts")
      .select("riot_name, riot_tag, region")
      .ilike("riot_name", `${searchName}%`)
      .eq("region", regionUpper)
      .limit(5),
  ])

  if (usersStartsRes.error) {
    console.error("❌ Autocomplete users error:", usersStartsRes.error.message)
    return new Response("Errore autocomplete", { status: 500 })
  }

  const results: Suggestion[] = mergeUnique(
    usersStartsRes.data ?? [],
    (playersStartsRes.data ?? []).map(playerRowToSuggestion),
    (scoutStartsRes.data ?? []).map(scoutRowToSuggestion)
  )

  // Phase 2 — contains-match fallback. Only runs when prefix search
  // came back empty AND the query is long enough that a full-table
  // scan isn't catastrophic. Searches the same two tables in parallel.
  if (results.length === 0 && searchName.length >= 4) {
    const [usersContainsRes, playersContainsRes, scoutContainsRes] = await Promise.all([
      supabaseMatchAdmin
        .from("users")
        .select("name, tag, icon_id, rank, region")
        .ilike("name", `%${searchName}%`)
        .order("last_searched_at", { ascending: false })
        .limit(5),
      supabaseMatchAdmin
        .from("players")
        .select("game_name, tag_line, icon_id, tier, platform")
        .ilike("game_name", `%${searchName}%`)
        .order("lp", { ascending: false, nullsFirst: false })
        .limit(8),
      supabaseMatchAdmin
        .from("scout_lobby_accounts")
        .select("riot_name, riot_tag, region")
        .ilike("riot_name", `%${searchName}%`)
        .eq("region", regionUpper)
        .limit(5),
    ])
    const merged = mergeUnique(
      usersContainsRes.data ?? [],
      (playersContainsRes.data ?? []).map(playerRowToSuggestion),
      (scoutContainsRes.data ?? []).map(scoutRowToSuggestion)
    )
    for (const row of merged) results.push(row)
  }

  // For scout-only matches we ended up with null icon/rank. Try a
  // single batched lookup in `users` (by (name, tag)) to enrich them
  // — cheap join: at most 5-10 rows out, exact-match index hits.
  const needsEnrichment = results.filter(
    (r) => r.icon_id == null && r.rank == null
  )
  if (needsEnrichment.length > 0) {
    const orFilters = needsEnrichment
      .map((r) => `and(name.eq.${escapeOr(r.name)},tag.eq.${escapeOr(r.tag)})`)
      .join(",")
    const { data: enrichRows } = await supabaseMatchAdmin
      .from("users")
      .select("name, tag, icon_id, rank, region")
      .or(orFilters)
    if (enrichRows) {
      const enrichMap = new Map<string, any>()
      for (const r of enrichRows) {
        enrichMap.set(`${r.name}#${r.tag}`.toLowerCase(), r)
      }
      for (const r of results) {
        const key = `${r.name}#${r.tag}`.toLowerCase()
        const richer = enrichMap.get(key)
        if (richer) {
          r.icon_id = richer.icon_id ?? r.icon_id
          r.rank = richer.rank ?? r.rank
        }
      }
    }
  }

  // Prepend Riot API result if it's not already in DB results
  if (riotResult) {
    const riotKey = `${riotResult.name}#${riotResult.tag}`.toLowerCase()
    const alreadyInResults = results.some(
      (r) => `${r.name}#${r.tag}`.toLowerCase() === riotKey
    )
    if (!alreadyInResults) {
      results.unshift(riotResult)
    }
  }

  const finalResults = results.slice(0, 8)

  // Premium uploaded profile pics — show the player's own avatar instead of the
  // LoL icon. One batched lookup in `profile_players` by `nametag` ("Name#Tag"),
  // case-insensitive. Best-effort: on any error we just fall back to the icon.
  try {
    const nametags = finalResults.map((r) => `${r.name}#${r.tag}`)
    if (nametags.length) {
      const { data: profRows } = await supabaseAdmin
        .from("profile_players")
        .select("nametag, avatar_url, plan")
        .in("nametag", nametags)
      if (profRows?.length) {
        const byKey = new Map<string, { avatar_url: string | null; plan: string | null }>()
        for (const p of profRows) {
          if (p.nametag) byKey.set(String(p.nametag).toLowerCase(), { avatar_url: p.avatar_url ?? null, plan: p.plan ?? null })
        }
        for (const r of finalResults) {
          const prof = byKey.get(`${r.name}#${r.tag}`.toLowerCase())
          if (prof) {
            if (prof.avatar_url) r.avatar_url = prof.avatar_url
            if (prof.plan && prof.plan !== "free") r.plan = prof.plan // premium/elite only
          }
        }
      }
    }
  } catch (e) {
    console.warn("autocomplete avatar enrichment failed:", (e as any)?.message ?? e)
  }

  return Response.json({ results: finalResults })
}

// ─── helpers ────────────────────────────────────────────────────────

function scoutRowToSuggestion(row: any): Suggestion {
  return {
    name: row.riot_name,
    tag: row.riot_tag,
    icon_id: null,
    rank: null,
    region: row.region,
    avatar_url: null,
  }
}

function playerRowToSuggestion(row: any): Suggestion {
  return {
    name: row.game_name,
    tag: row.tag_line,
    icon_id: row.icon_id ?? null,
    rank: row.tier ?? null,
    region: platformToRegion(row.platform),
    avatar_url: null,
  }
}

// players.platform ("EUW1") → the display region the summoner page expects
// ("EUW"). Special-cases the few whose display name isn't host-minus-"1".
const PLATFORM_DISPLAY: Record<string, string> = {
  EUW1: "EUW", EUN1: "EUNE", NA1: "NA", BR1: "BR", LA1: "LAN", LA2: "LAS",
  OC1: "OCE", TR1: "TR", RU: "RU", KR: "KR", JP1: "JP",
}
function platformToRegion(platform: string | null): string {
  if (!platform) return "EUW"
  return PLATFORM_DISPLAY[platform] ?? platform.replace(/1$/, "")
}

/**
 * Concatenate two suggestion lists in order, dropping any duplicates by
 * lowercase `name#tag`. The first list wins (= `users` is preferred over
 * scout lobby rows because it carries the rich fields).
 */
function mergeUnique(...lists: Suggestion[][]): Suggestion[] {
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const list of lists) {
    for (const row of list) {
      const key = `${row.name}#${row.tag}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
  }
  return out
}

/**
 * PostgREST .or() parses commas/parens, so values inside need escaping.
 * Riot names allow spaces, dots, etc. but not the chars below.
 */
function escapeOr(v: string): string {
  return v.replace(/[(),]/g, "\\$&")
}
