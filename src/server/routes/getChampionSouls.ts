// routes/getChampionSouls.ts — Dragon soul winrates per champion/role
import { supabaseAdmin } from "../supabase/client";

export async function getChampionSoulsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { championId, role, tier } = body as {
      championId?: number;
      role?: string;
      tier?: string;
    };

    if (!championId) {
      return new Response("Missing championId", { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc("champion_soul_stats", {
      p_champion_id: championId,
      p_role: role ?? null,
      p_tier: tier ?? null,
    });

    if (error) {
      console.error("champion_soul_stats error:", error.message);
      return new Response("DB error", { status: 500 });
    }

    return Response.json({ championId, role, tier, souls: data ?? [] });
  } catch (e) {
    console.error("getChampionSoulsHandler error:", e);
    return new Response("Internal error", { status: 500 });
  }
}
