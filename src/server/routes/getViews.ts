import { supabase } from "../supabase/client"

export async function getProfileViewsHandler(req: Request): Promise<Response> {
  try {
    const { name, tag } = await req.json()

    if (!name || !tag) {
      return new Response("Missing name or tag", { status: 400 })
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("views")
      .eq("name", name)
      .eq("tag", tag)
      .single()

    if (error) {
      console.error("Errore Supabase:", error)
      return new Response("Errore DB", { status: 500 })
    }

    return Response.json({ views: data?.views ?? 0 })
  } catch (err) {
    console.error("Errore handler:", err)
    return new Response("Errore interno", { status: 500 })
  }
}
