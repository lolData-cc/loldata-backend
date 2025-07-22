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
    .select("name, tag, icon_id, rank")
    .ilike("name", `%${query}%`)
    .eq("region", region.toUpperCase()) 
    .order("last_searched_at", { ascending: false })
    .limit(5)

  if (error) {
    console.error("❌ Autocomplete error:", error.message)
    return new Response("Errore autocomplete", { status: 500 })
  }

  return Response.json({ results: data })
}
