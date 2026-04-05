// routes/getChampionRunes.ts — Rune winrates per champion/role
import { supabaseAdmin } from "../supabase/client";

export async function getChampionRunesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { championId, role, tier, limit = 10 } = body as {
      championId?: number;
      role?: string;
      tier?: string;
      limit?: number;
    };

    if (!championId) {
      return new Response("Missing championId", { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc("champion_rune_stats", {
      p_champion_id: championId,
      p_role: role ?? null,
      p_tier: tier ?? null,
      p_limit: limit,
    });

    if (error) {
      console.error("champion_rune_stats error:", error.message);
      return new Response("DB error", { status: 500 });
    }

    return Response.json({ championId, role, tier, runes: data ?? [] });
  } catch (e) {
    console.error("getChampionRunesHandler error:", e);
    return new Response("Internal error", { status: 500 });
  }
}
