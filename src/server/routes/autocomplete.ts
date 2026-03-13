import { supabase } from "../supabase/client"

export async function autocompleteHandler(req: Request): Promise<Response> {
  const body = await req.json()
  const { query, region } = body

  if (!query || !region) {
    return new Response("Missing query or region", { status: 400 })
  }

  if (query.length < 2) {
    return Response.json({ results: [] })
  }

  const { data, error } = await supabase
    .from("users")
    .select("name, tag, icon_id, rank, region")
    .ilike("name", `%${query}%`)
    .order("last_searched_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("❌ Autocomplete error:", error.message)
    return new Response("Errore autocomplete", { status: 500 })
  }

  // Prioritize names that START with the query, then contains
  const queryLower = query.toLowerCase()
  const sorted = (data ?? []).sort((a: any, b: any) => {
    const aStarts = a.name.toLowerCase().startsWith(queryLower) ? 0 : 1
    const bStarts = b.name.toLowerCase().startsWith(queryLower) ? 0 : 1
    return aStarts - bStarts
  })

  return Response.json({ results: sorted.slice(0, 5) })
}
