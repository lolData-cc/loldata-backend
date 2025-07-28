
import { supabase } from "../supabase/client"

export async function checkProHandler(req: Request): Promise<Response> {
  const body = await req.json()
  const { nametag } = body

  if (!nametag) {
    return new Response("Missing nametag", { status: 400 })
  }

  const { data, error } = await supabase
    .from("profile_players")
    .select("pro, streamer")
    .eq("nametag", nametag.toLowerCase())
    .single()

  if (error) {
    if (error.code === "PGRST116") {
      return Response.json({ pro: false, streamer: false })
    }

    console.error("❌ Supabase error:", error.message)
    return new Response("Error checking PRO/STREAMER status", { status: 500 })
  }

  return Response.json({
    pro: data?.pro === true,
    streamer: data?.streamer === true,
  })
}