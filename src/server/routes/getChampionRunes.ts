// routes/getChampionRunes.ts — Rune winrates per champion/role/opponent
import { supabaseAdmin } from "../supabase/client";
import { getSnap } from "./getChampionStats";

export async function getChampionRunesHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({}));
    const { championId, role, tier, limit = 10, opponentId } = body as {
      championId?: number;
      role?: string;
      tier?: string;
      limit?: number;
      opponentId?: number;
    };

    if (!championId) {
      return new Response("Missing championId", { status: 400 });
    }

    // Fast path: serve from preloaded snapshot
    if (!opponentId && role) {
      const snapData = getSnap(championId, role.toUpperCase(), tier ?? null);
      if (snapData?.runes) {
        return Response.json({
          championId, role, tier, opponentId: null,
          runes: snapData.runes.slice(0, limit),
        });
      }
    }

    // Fallback: live RPC
    const { data, error } = await supabaseAdmin.rpc("champion_rune_stats", {
      p_champion_id: championId,
      p_role: role ?? null,
      p_tier: tier ?? null,
      p_limit: limit,
      p_opponent_id: opponentId ?? null,
    });

    if (error) {
      console.error("champion_rune_stats error:", error.message);
      return new Response("DB error", { status: 500 });
    }

    return Response.json({ championId, role, tier, opponentId, runes: data ?? [] });
  } catch (e) {
    console.error("getChampionRunesHandler error:", e);
    return new Response("Internal error", { status: 500 });
  }
}
