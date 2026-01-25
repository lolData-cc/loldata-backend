import { serve } from "bun"
import { join } from "path"
import { readFile } from "fs/promises"
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "buffer";
import { logger } from "./logger";
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
import { getLeaderboardHandler } from "./routes/leaderboard";
import { getChampionItemsHandler } from "./routes/getChampionItems";
import { getTotalMasteryHandler } from "./routes/getTotalMastery";
import { getMasteryListHandler } from "./routes/getMasteryList";
import { getChampionStatsHandler } from "./routes/getChampionStats";



const stripeSecretKey =
  process.env.STRIPE_SECRET_KEY ?? process.env?.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  console.error("❌ Missing STRIPE_SECRET_KEY env var (Railway config)");
  // puoi anche fare throw se preferisci
  throw new Error("Missing STRIPE_SECRET_KEY env var (Railway config)");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// mappa price -> plan
const PRICE_IDS = {
  premium: process.env.PREMIUM_PRICE_ID!, // es. price_...
  elite: process.env.ELITE_PRICE_ID!,     // es. price_...
} as const;

async function getUserFromSupabaseAuth(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user; // { id, email, ... }
}

const distPath = join(import.meta.dir, "../dist")

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, stripe-signature");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}

const PORT = Number(process.env.PORT) || 3001;
logger.info("SERVER_START", `Server Bun in ascolto sulla porta ${PORT}`);

// 3.a) CREATE CHECKOUT SESSION
async function createCheckoutSessionHandler(req: Request) {
  try {
    const user = await getUserFromSupabaseAuth(req);
    if (!user) return withCors(new Response("Unauthorized", { status: 401 }));

    const { plan } = await req.json() as { plan: "premium" | "elite" };
    if (!plan || !(plan in PRICE_IDS)) return withCors(new Response("Bad Request", { status: 400 }));

    // prendi/crea customer
    const { data: row } = await supabaseAdmin
      .from("profile_players")
      .select("stripe_customer_id")
      .eq("profile_id", user.id)
      .single();

    let customerId = row?.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { profile_id: user.id },
      });
      customerId = customer.id;
      await supabaseAdmin
        .from("profile_players")
        .update({ stripe_customer_id: customerId })
        .eq("profile_id", user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId!,
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      allow_promotion_codes: true,
      customer_update: { address: "auto" },
      success_url: `${process.env.FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { profile_id: user.id, selected_plan: plan },
    });

    return withCors(new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    }));
  } catch (e) {
    console.error("create-checkout-session error", e);
    return withCors(new Response("Internal Error", { status: 500 }));
  }
}

// 3.b) WEBHOOK (raw body: niente .json())
async function stripeWebhookHandler(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature")!;
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error("Webhook signature failed", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const subId = s.subscription as string | undefined;
      const profileId = s.metadata?.profile_id as string | undefined;
      if (subId && profileId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        const priceId = sub.items.data[0]?.price?.id;
        const plan =
          priceId === PRICE_IDS.premium ? "premium" :
            priceId === PRICE_IDS.elite ? "elite" : "premium";

        await supabaseAdmin
          .from("profile_players")
          .update({
            plan,
            stripe_subscription_id: sub.id,
            subscription_status: sub.status,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("profile_id", profileId);
      }
    }

    if (event.type.startsWith("customer.subscription.")) {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      const priceId = sub.items.data[0]?.price?.id;
      const plan =
        priceId === PRICE_IDS.premium ? "premium" :
          priceId === PRICE_IDS.elite ? "elite" : "premium";

      const { data: rows } = await supabaseAdmin
        .from("profile_players")
        .select("profile_id")
        .eq("stripe_customer_id", customerId)
        .limit(1);

      const profileId = rows?.[0]?.profile_id;
      if (profileId) {
        await supabaseAdmin
          .from("profile_players")
          .update({
            plan: sub.status === "canceled" ? "free" : plan,
            stripe_subscription_id: sub.id,
            subscription_status: sub.status,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          })
          .eq("profile_id", profileId);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Webhook processing error", e);
    return new Response("Internal Error", { status: 500 });
  }
}

async function withLogAndCors(
  req: Request,
  pathname: string,
  handler: (req: Request) => Promise<Response>
) {
  const started = Date.now();
  const res = await handler(req);
  const elapsed = Date.now() - started;
  logger.response(req, pathname, res.status, elapsed);
  return withCors(res);
}

serve({
  port: PORT,
  async fetch(req) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const pathname = url.pathname;

    logger.request(req, pathname);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, stripe-signature",
        },
      });
    }

    // === ROUTE API ===
    // === ROUTE API ===
if (pathname === "/api/matches" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMatchesHandler);
}

if (pathname === "/api/summoner" && req.method === "POST") {
  return withLogAndCors(req, pathname, getSummonerHandler);
}

if (pathname === "/api/profile/views" && req.method === "POST") {
  return withLogAndCors(req, pathname, getProfileViewsHandler);
}

if (pathname === "/api/livegame" && req.method === "POST") {
  return withLogAndCors(req, pathname, getLiveGameHandler);
}

if (pathname === "/api/aihelp/howtowin" && req.method === "POST") {
  return withLogAndCors(req, pathname, howToWinHandler);
}

if (pathname === "/api/multirank" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMultiRankHandler);
}

if (pathname === "/api/assignroles" && req.method === "POST") {
  return withLogAndCors(req, pathname, getAssignedRolesHandler);
}

if (pathname === "/api/aihelp/matchups" && req.method === "POST") {
  return withLogAndCors(req, pathname, matchupsHandler);
}

if (pathname === "/api/autocomplete" && req.method === "POST") {
  return withLogAndCors(req, pathname, autocompleteHandler);
}

if (pathname === "/api/pro/check" && req.method === "POST") {
  return withLogAndCors(req, pathname, checkProHandler);
}

if (pathname === "/api/matchinfo" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMatchInfoHandler);
}

if (pathname === "/api/matchtimeline" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMatchTimelineHandler);
}

if (pathname === "/api/itemstats" && req.method === "POST") {
  return withLogAndCors(req, pathname, getItemStatsHandler);
}

if (pathname === "/api/itembestutilizers" && req.method === "POST") {
  return withLogAndCors(req, pathname, getItemBestUtilizersHandler);
}

if (pathname === "/api/champion/matchups" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionMatchupsHandler);
}

if (pathname === "/api/season_stats" && req.method === "POST") {
  return withLogAndCors(req, pathname, getSeasonStatsHandler);
}

if (pathname === "/api/streamers/live" && req.method === "GET") {
  return withLogAndCors(req, pathname, getLiveStreamersHandler);
}

if (pathname === "/api/leaderboard" && req.method === "POST") {
  return withLogAndCors(req, pathname, getLeaderboardHandler);
}

if (pathname === "/api/billing/create-checkout-session" && req.method === "POST") {
  return withLogAndCors(req, pathname, createCheckoutSessionHandler);
}

if (pathname === "/api/champion/items" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionItemsHandler);
}

if (pathname === "/api/mastery/total" && req.method === "POST") {
  return withLogAndCors(req, pathname, getTotalMasteryHandler);
}

if (pathname === "/api/mastery/list" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMasteryListHandler);
}

if (pathname === "/api/champion/stats" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionStatsHandler);
}

// webhook Stripe: niente CORS, ma puoi comunque loggare
if (pathname === "/api/webhooks/stripe" && req.method === "POST") {
  const started = Date.now();
  const res = await stripeWebhookHandler(req);
  const elapsed = Date.now() - started;
  logger.response(req, pathname, res.status, elapsed);
  return res;
}

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
