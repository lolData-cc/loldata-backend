import { getMatchDetails, getMatchTimeline } from "../riot";
import { getMatchJunglePlaystyle } from "../junglePlaystyle";

export async function getMatchAnalysisHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { matchId, region } = body;

    if (!matchId || !region) {
      return new Response("Missing matchId or region", { status: 400 });
    }

    const [match, timeline] = await Promise.all([
      getMatchDetails(matchId, region),
      getMatchTimeline(matchId, region),
    ]);

    const junglePlaystyle = getMatchJunglePlaystyle(match, timeline);

    return Response.json({ junglePlaystyle });
  } catch (err) {
    console.error("❌ Error in match analysis:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
