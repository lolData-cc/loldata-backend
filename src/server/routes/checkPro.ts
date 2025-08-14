import { supabase } from "../supabase/client"

export async function checkProHandler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return new Response("Invalid JSON body", { status: 400 })
  }

  // Supporta sia { nametag } che { name, tag }
  let nametag: string | undefined = body?.nametag
  const name: string | undefined = body?.name
  const tag: string | undefined  = body?.tag

  if (!nametag) {
    if (typeof name === "string" && typeof tag === "string" && name && tag) {
      nametag = `${name}#${tag}`
    }
  }
  if (!nametag || typeof nametag !== "string") {
    return new Response("Missing nametag (or name+tag)", { status: 400 })
  }

  const normalized = nametag.toLowerCase().trim()

  // pro_players.username contiene "GameName#TAG" (case-insensitive)
  const { data, error } = await supabase
    .from("pro_players")
    .select("username")
    .ilike("username", normalized)      // case-insensitive
    .maybeSingle()

  if (error && error.code !== "PGRST116") {
    console.error("❌ Supabase error:", error)
    return new Response("DB error", { status: 500 })
  }

  const isPro = !!data
  // streamer lo lasci a false (o fai altra tabella/colonna)
  return Response.json({ pro: isPro, streamer: false })
}