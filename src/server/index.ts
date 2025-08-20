import { serve } from "bun"
import { join } from "path"
import { readFile } from "fs/promises"
import { checkProHandler } from "./routes/checkPro"
import { getMatchesHandler } from "./routes/getMatches"
import { getSummonerHandler } from "./routes/getSummoner"
import { matchupsHandler } from "./routes/aihelp/matchups"
import { getProfileViewsHandler } from "./routes/getViews"
import { getLiveGameHandler } from "./routes/livegame"
import { howToWinHandler } from "./routes/aihelp/howtowin"
import { getMultiRankHandler } from "./routes/multirank"
import { getAssignedRolesHandler } from "./routes/getAssignedRoles"
import { autocompleteHandler } from "./routes/autocomplete"
import { getMatchInfoHandler } from "./routes/getMatchInfo"
import { getMatchTimelineHandler } from "./routes/getMatchTimeline"
import { getItemStatsHandler } from "./routes/getItemStats"
import { getItemBestUtilizersHandler } from "./routes/getItemBestUtilizers"
import { getChampionMatchupsHandler } from "./routes/getChampionMatchups"
import { getSeasonStatsHandler } from "./routes/season_stats";
import { getLiveStreamersHandler } from "./twitch";

const distPath = join(import.meta.dir, "../dist")

function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Access-Control-Allow-Origin", "*")
  return new Response(res.body, { status: res.status, headers })
}

console.log("🚀 Avvio server Bun...");

serve({
  port: Number(process.env.PORT) || 3001,
  async fetch(req) {
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const pathname = url.pathname

    console.log("✅ Server avviato sulla porta", process.env.PORT || 3001);
    console.log("📩 Ricevuta richiesta:", req.method, req.url);

    console.log("📎 PATHNAME:", pathname)

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      })
    }

    // === ROUTE API ===
    if (pathname === "/api/matches" && req.method === "POST") return withCors(await getMatchesHandler(req))
    if (pathname === "/api/summoner" && req.method === "POST") return withCors(await getSummonerHandler(req))
    if (pathname === "/api/profile/views" && req.method === "POST") return withCors(await getProfileViewsHandler(req))
    if (pathname === "/api/livegame" && req.method === "POST") return withCors(await getLiveGameHandler(req))
    if (pathname === "/api/aihelp/howtowin" && req.method === "POST") return withCors(await howToWinHandler(req))
    if (pathname === "/api/multirank" && req.method === "POST") return withCors(await getMultiRankHandler(req))
    if (pathname === "/api/assignroles" && req.method === "POST") return withCors(await getAssignedRolesHandler(req))
    if (pathname === "/api/aihelp/matchups" && req.method === "POST") return withCors(await matchupsHandler(req))
    if (pathname === "/api/autocomplete" && req.method === "POST") return withCors(await autocompleteHandler(req))
    if (pathname === "/api/pro/check" && req.method === "POST") return withCors(await checkProHandler(req))
    if (pathname === "/api/matchinfo" && req.method === "POST") return withCors(await getMatchInfoHandler(req))
    if (pathname === "/api/matchtimeline" && req.method === "POST") return withCors(await getMatchTimelineHandler(req))
    if (pathname === "/api/itemstats" && req.method === "POST") { return withCors(await getItemStatsHandler(req)) }
    if (pathname === "/api/itembestutilizers" && req.method === "POST") { return withCors(await getItemBestUtilizersHandler(req))}
    if (pathname === "/api/champion/matchups" && req.method === "POST") { return withCors(await getChampionMatchupsHandler(req))}
    if (pathname === "/api/season_stats" && req.method === "POST") return withCors(await getSeasonStatsHandler(req));
    if (pathname === "/api/streamers/live" && req.method === "GET") { return withCors(await getLiveStreamersHandler(req));}
    // === FILE STATICI ===
    try {
      const filePath = join(distPath, pathname === "/" ? "index.html" : pathname)
      const file = await readFile(filePath)
      const ext = filePath.split(".").pop()
      const mime = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        png: "image/png",
        svg: "image/svg+xml",
      }[ext!] || "text/plain"

      return new Response(file, {
        headers: { "Content-Type": mime },
      })
    } catch (e) {
      if (pathname.startsWith("/api")) {
        return new Response("API route not found", { status: 404 })
      }

      try {
        const html = await readFile(join(distPath, "index.html"))
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        })
      } catch (e) {
        return new Response("index.html not found", { status: 500 })
      }
    }
  },
})
