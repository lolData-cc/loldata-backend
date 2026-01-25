// src/routes/getChampionStats.ts
import { supabase } from "../supabase/client";

export async function getChampionStatsHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => null);
    const { championId, patch = null, queueId = 420, role = null } = body ?? {};

    if (!championId) {
      return new Response("Missing championId", { status: 400 });
    }

    const { data, error } = await supabase.rpc("get_champion_stats", {
      p_champion_id: Number(championId),
      p_patch: patch,
      p_queue_id: queueId ?? 420,
      p_role: role, // <— NEW
    });

    if (error) {
      console.error("❌ get_champion_stats rpc error:", error.message);
      return new Response("Failed to load champion stats", { status: 500 });
    }

    return Response.json(data);
  } catch (err) {
    console.error("Errore in getChampionStatsHandler:", err);
    return new Response("Errore interno", { status: 500 });
  }
}
