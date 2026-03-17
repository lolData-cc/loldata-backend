import { supabaseAdmin } from "../supabase/client"
import { getAccountByRiotId } from "../riot"

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
  let riotResult: any = null

  if (hasTag) {
    const [namePart, tagPart] = query.split("#")
    if (namePart.trim() && tagPart.trim()) {
      try {
        const account = await getAccountByRiotId(namePart.trim(), tagPart.trim(), region)
        if (account) {
          // Check if we have this player in DB for extra info
          const { data: dbRow } = await supabaseAdmin
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

  // Phase 1: starts-with query (fast — uses btree index)
  const { data: startsWithData, error: err1 } = await supabaseAdmin
    .from("users")
    .select("name, tag, icon_id, rank, region")
    .ilike("name", `${searchName}%`)
    .order("last_searched_at", { ascending: false })
    .limit(5)

  if (err1) {
    console.error("❌ Autocomplete error:", err1.message)
    return new Response("Errore autocomplete", { status: 500 })
  }

  const results = startsWithData ?? []

  // Phase 2: if we have fewer than 5, fill with contains matches
  if (results.length < 5) {
    const startNames = new Set(results.map((r: any) => `${r.name}#${r.tag}`))

    const { data: containsData } = await supabaseAdmin
      .from("users")
      .select("name, tag, icon_id, rank, region")
      .ilike("name", `%${searchName}%`)
      .order("last_searched_at", { ascending: false })
      .limit(10)

    if (containsData) {
      for (const row of containsData) {
        if (results.length >= 5) break
        const key = `${row.name}#${row.tag}`
        if (!startNames.has(key)) {
          results.push(row)
          startNames.add(key)
        }
      }
    }
  }

  // Prepend Riot API result if it's not already in DB results
  if (riotResult) {
    const riotKey = `${riotResult.name}#${riotResult.tag}`
    const alreadyInResults = results.some((r: any) => `${r.name}#${r.tag}` === riotKey)
    if (!alreadyInResults) {
      results.unshift(riotResult)
    }
  }

  return Response.json({ results })
}
