// routes/checkPro.ts
import { supabase } from "../supabase/client"

function normalizeNametag(s: string) {
  // trim, collassa spazi multipli, lowercase
  return s.trim().replace(/\s+/g, " ").toLowerCase()
}

export async function checkProHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { nametag } = body as { nametag?: string }

    if (!nametag) return new Response("Missing nametag", { status: 400 })

    const nametagNorm = normalizeNametag(nametag)

    // 1) tenta match case-insensitive esatto
    let { data, error } = await supabase
      .from("profile_players")
      .select("plan, nametag, region")
      .ilike("nametag", nametagNorm) // ILIKE = case-insensitive
      .maybeSingle()

    // 2) (opzionale) fallback: se non trovato, prova ad eguagliare togliendo spazi extra dell'input
    if (!data && !error) {
      const compact = nametagNorm.replace(/\s+/g, " ")
      const res2 = await supabase
        .from("profile_players")
        .select("plan, nametag, region")
        .ilike("nametag", compact)
        .maybeSingle()
      data = res2.data
      error = res2.error
    }

    if (error) {
      console.error("❌ checkPro error:", error.message)
      return new Response("Errore checkPro", { status: 500 })
    }

    // Normalizza output: solo "premium" | "elite" oppure null
    const planRaw = (data?.plan ?? null)
    const plan =
      typeof planRaw === "string" && ["premium", "elite"].includes(planRaw.toLowerCase())
        ? (planRaw.toLowerCase() as "premium" | "elite")
        : null

    return Response.json({ plan }) // <-- niente "free" qui
  } catch (e) {
    console.error("❌ checkPro exception:", e)
    return new Response("Errore checkPro", { status: 500 })
  }
}
