import { serve } from "bun"
import { join } from "path"
import { readFile } from "fs/promises"
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Buffer } from "buffer";
import { logger } from "./logger";
import { checkProHandler } from "./routes/checkPro"
import { getMatchesHandler } from "./routes/getMatches"
import { getMatchAnalysisHandler } from "./routes/getMatchAnalysis"
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
import { getSplitStatsHandler } from "./routes/split_stats";
import { createScoutLobbyHandler, readScoutLobbyHandler, readScoutFeedHandler, readScoutLeaderboardHandler, readScoutStatsHandler, readScoutChampionsHandler, readScoutHabitsHandler, refreshScoutLobbyHandler, updateScoutLobbyHandler, resolvePuuidHandler, readScoutTrendingHandler, readMyScoutLobbiesHandler, deleteScoutLobbyHandler, readScoutLpTimelineHandler, readScoutLiveHandler, debugScoutSnapshotsHandler } from "./routes/scout";
import { readScoutBountyTodayHandler, readScoutBountyLeaderboardHandler, previewScoutBountyHandler } from "./routes/scoutBountyRoutes";
import {
  createOrReadClaimInviteHandler,
  deleteClaimInviteHandler,
  readClaimInviteHandler,
  claimInviteHandler,
  patchVerifyBadgeHandler,
  readLobbyAdminsHandler,
  promoteAdminHandler,
  demoteAdminHandler,
} from "./routes/scoutVerify";
import {
  startVerifyAccountHandler,
  checkVerifyAccountHandler,
} from "./routes/scoutVerifyAccount";
import {
  readScoutChatHandler,
  postScoutChatHandler,
} from "./routes/scoutChat";
import {
  setRealtimeServer,
  chatTopic,
  type ScoutWsData,
} from "./realtime/scoutRealtime";
import {
  readMatchSocialBatchHandler,
  toggleLikeHandler,
  readCommentsHandler,
  postCommentHandler,
} from "./routes/scoutMatchSocial";
import { getLiveStreamersHandler } from "./twitch";
import { getLeaderboardHandler } from "./routes/leaderboard";
import { getChampionItemsHandler } from "./routes/getChampionItems";
import { getChampionRunesHandler } from "./routes/getChampionRunes";
import { getChampionSoulsHandler } from "./routes/getChampionSouls";
import { getTotalMasteryHandler } from "./routes/getTotalMastery";
import { getMasteryListHandler } from "./routes/getMasteryList";
import { getChampionStatsHandler, getAvailablePatchesHandler, preloadSnapshots } from "./routes/getChampionStats";
import { analyzePlayerHandler, analyzeStatusHandler } from "./routes/analyzePlayer";
import { generateSnapshotHandler, getTierlistHandler } from "./routes/getTierlist";
import { learnOverviewHandler } from "./routes/learn/overview";
import { getChampionOtpRankingHandler } from "./routes/getChampionOtpRanking";
import { getPlayerRanksHandler } from "./routes/getPlayerRanks";
import { riotAuthUrlHandler, riotAuthCallbackHandler } from "./routes/riotAuth";
import { getLivegameStatsHandler } from "./routes/livegameStats";



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
  headers.set("Access-Control-Allow-Methods", "POST, GET, PATCH, DELETE, OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}

const PORT = Number(process.env.PORT) || 3001;
logger.info("SERVER_START", `Server Bun in ascolto sulla porta ${PORT}`);

// Preload champion snapshots into memory for instant responses
preloadSnapshots();

// Start the periodic scout rank-snapshot sweep so LP gets tracked even
// when nobody is looking at any lobby.
import { startScoutPeriodicSweep } from "./services/scoutPeriodic";
startScoutPeriodicSweep();

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

    // Validate that the cached customer still exists in the current
    // Stripe environment. After a Test → Live switch the DB still
    // holds test-mode customer IDs that Live mode doesn't know about
    // ("No such customer: cus_..."). When that happens we drop the
    // stale id and recreate so the user can pay without us having to
    // hand-clean the database.
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if ((existing as any).deleted) customerId = null;
      } catch (err: any) {
        if (err?.code === "resource_missing" || err?.statusCode === 404) {
          console.warn(
            `[stripe] stale customer ${customerId} (likely test-mode id under live keys) — recreating`
          );
          customerId = null;
          // Also wipe the dependent subscription columns — they're
          // also tied to the test-mode account and would otherwise
          // confuse the webhook handler.
          await supabaseAdmin
            .from("profile_players")
            .update({
              stripe_customer_id: null,
              stripe_subscription_id: null,
              subscription_status: null,
              current_period_end: null,
              // Don't auto-downgrade plan here — the webhook will set
              // it to the correct value after the new checkout
              // completes. Leaving it preserves visual continuity
              // during the redirect.
            })
            .eq("profile_id", user.id);
        } else {
          throw err;
        }
      }
    }

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

// 3.c) CUSTOMER PORTAL SESSION
// Creates a Stripe-hosted billing portal session for a signed-in
// subscriber. The portal lets the user update their payment method,
// download invoices, switch plans and cancel — Stripe handles all
// the UI + compliance, we just return a one-shot URL.
async function createPortalSessionHandler(req: Request) {
  try {
    const user = await getUserFromSupabaseAuth(req);
    if (!user) return withCors(new Response("Unauthorized", { status: 401 }));

    // Look up the customer id we stored on the profile.
    const { data: row } = await supabaseAdmin
      .from("profile_players")
      .select("stripe_customer_id")
      .eq("profile_id", user.id)
      .single();

    const customerId = row?.stripe_customer_id as string | null;
    if (!customerId) {
      // User has never subscribed → no Stripe customer record exists.
      // Surface a 404 so the frontend can hint "subscribe first".
      return withCors(
        new Response(
          JSON.stringify({ error: "No Stripe customer for this account" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // Always return the user to /dashboard/billing — the page that
      // initiated the request — so the back-button on the portal
      // brings them home naturally.
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
    });

    return withCors(
      new Response(JSON.stringify({ url: session.url }), {
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch (e) {
    console.error("create-portal-session error", e);
    return withCors(new Response("Internal Error", { status: 500 }));
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

const server = serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const pathname = url.pathname;

    logger.request(req, pathname);

    // ── WebSocket upgrade — live scout lobby chat ───────────────────
    // Path: /api/scout/lobby/:slug/ws. Must run before the OPTIONS and
    // API route table: when the upgrade succeeds Bun owns the response
    // (we return undefined) and routes the socket to the `websocket`
    // handler below. The slug is stashed on the socket so `open` can
    // subscribe it to this lobby's broadcast topic.
    {
      const wsMatch = pathname.match(
        /^\/api\/scout\/lobby\/([^/]+)\/ws$/
      );
      if (wsMatch) {
        const upgraded = server.upgrade(req, {
          data: { slug: wsMatch[1] } satisfies ScoutWsData,
        });
        if (upgraded) return undefined;
        return new Response("websocket upgrade failed", { status: 426 });
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, stripe-signature",
        },
      });
    }

    // === ROUTE API ===
    // === ROUTE API ===
if (pathname === "/api/matches" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMatchesHandler);
}

if (pathname === "/api/match/analysis" && req.method === "POST") {
  return withLogAndCors(req, pathname, getMatchAnalysisHandler);
}

if (pathname === "/api/player/analyze/status" && req.method === "GET") {
  return withLogAndCors(req, pathname, analyzeStatusHandler);
}

if (pathname === "/api/player/analyze" && req.method === "POST") {
  const started = Date.now();
  const res = await analyzePlayerHandler(req);
  logger.response(req, pathname, res.status, Date.now() - started);
  return withCors(res);
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

if (pathname === "/api/livegame/stats" && req.method === "POST") {
  return withLogAndCors(req, pathname, getLivegameStatsHandler);
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

if (pathname === "/api/split_stats" && req.method === "POST") {
  return withLogAndCors(req, pathname, getSplitStatsHandler);
}

if (pathname === "/api/scout/lobby" && req.method === "POST") {
  return withLogAndCors(req, pathname, createScoutLobbyHandler);
}

if (pathname === "/api/scout/my-lobbies" && req.method === "GET") {
  return withLogAndCors(req, pathname, readMyScoutLobbiesHandler);
}

// GET /api/scout/lobby/<slug>  — bare lobby read.
// Strict: matches ONLY the bare slug path, not any nested sub-resource
// (admins, chat, match-social, match/.../comments, etc.) which have
// their own handlers further down.
if (
  /^\/api\/scout\/lobby\/[^/]+$/.test(pathname) &&
  req.method === "GET"
) {
  return withLogAndCors(req, pathname, (r) => readScoutLobbyHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/snapshots-debug/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => debugScoutSnapshotsHandler(r, pathname));
}

// PATCH /api/scout/lobby/<slug>   — bare lobby update.
// Excluded: per-player sub-paths (verify-badge etc.) which are
// matched by more specific handlers further down.
if (
  pathname.startsWith("/api/scout/lobby/") &&
  req.method === "PATCH" &&
  !pathname.includes("/player/")
) {
  return withLogAndCors(req, pathname, (r) => updateScoutLobbyHandler(r, pathname));
}

// DELETE /api/scout/lobby/<slug>  — bare lobby delete.
// Excluded: per-player claim-invite revoke + per-admin demote.
if (
  pathname.startsWith("/api/scout/lobby/") &&
  req.method === "DELETE" &&
  !pathname.includes("/player/") &&
  !pathname.includes("/admins/")
) {
  return withLogAndCors(req, pathname, (r) => deleteScoutLobbyHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/feed/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutFeedHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/leaderboard/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutLeaderboardHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/bounty/today/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutBountyTodayHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/bounty/preview/") && req.method === "POST") {
  return withLogAndCors(req, pathname, (r) => previewScoutBountyHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/bounty/leaderboard/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutBountyLeaderboardHandler(r, pathname));
}

// ─── Lobby identity verification (Phase 1) ──────────────────────────
// claim-invite: per-player invite link
if (
  pathname.startsWith("/api/scout/lobby/") &&
  pathname.endsWith("/claim-invite") &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => createOrReadClaimInviteHandler(r, pathname));
}
if (
  pathname.startsWith("/api/scout/lobby/") &&
  pathname.endsWith("/claim-invite") &&
  req.method === "DELETE"
) {
  return withLogAndCors(req, pathname, (r) => deleteClaimInviteHandler(r, pathname));
}
// claim-invite/<token>: public read + authed claim
if (
  pathname.startsWith("/api/scout/claim-invite/") &&
  pathname.endsWith("/claim") &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => claimInviteHandler(r, pathname));
}
if (pathname.startsWith("/api/scout/claim-invite/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readClaimInviteHandler(r, pathname));
}
// Per-player verify badge toggle (admin)
if (
  pathname.startsWith("/api/scout/lobby/") &&
  pathname.endsWith("/verify-badge") &&
  req.method === "PATCH"
) {
  return withLogAndCors(req, pathname, (r) => patchVerifyBadgeHandler(r, pathname));
}
// Lobby admins
if (
  pathname.startsWith("/api/scout/lobby/") &&
  pathname.endsWith("/admins") &&
  req.method === "GET"
) {
  return withLogAndCors(req, pathname, (r) => readLobbyAdminsHandler(r, pathname));
}
if (
  pathname.startsWith("/api/scout/lobby/") &&
  pathname.endsWith("/admins") &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => promoteAdminHandler(r, pathname));
}
if (
  /^\/api\/scout\/lobby\/[^/]+\/admins\/[^/]+$/.test(pathname) &&
  req.method === "DELETE"
) {
  return withLogAndCors(req, pathname, (r) => demoteAdminHandler(r, pathname));
}

// Phase 2 — per-account icon-challenge verification.
if (pathname === "/api/scout/verify/start" && req.method === "POST") {
  return withLogAndCors(req, pathname, startVerifyAccountHandler);
}
if (pathname === "/api/scout/verify/check" && req.method === "POST") {
  return withLogAndCors(req, pathname, checkVerifyAccountHandler);
}

// v3 — per-lobby group chat.
if (
  /^\/api\/scout\/lobby\/[^/]+\/chat$/.test(pathname) &&
  req.method === "GET"
) {
  return withLogAndCors(req, pathname, (r) => readScoutChatHandler(r, pathname));
}
if (
  /^\/api\/scout\/lobby\/[^/]+\/chat$/.test(pathname) &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => postScoutChatHandler(r, pathname));
}

// v4 — per-match likes + comments.
if (
  /^\/api\/scout\/lobby\/[^/]+\/match-social$/.test(pathname) &&
  req.method === "GET"
) {
  return withLogAndCors(req, pathname, (r) => readMatchSocialBatchHandler(r, pathname));
}
if (
  /^\/api\/scout\/lobby\/[^/]+\/match\/[^/]+\/like$/.test(pathname) &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => toggleLikeHandler(r, pathname));
}
if (
  /^\/api\/scout\/lobby\/[^/]+\/match\/[^/]+\/comments$/.test(pathname) &&
  req.method === "GET"
) {
  return withLogAndCors(req, pathname, (r) => readCommentsHandler(r, pathname));
}
if (
  /^\/api\/scout\/lobby\/[^/]+\/match\/[^/]+\/comments$/.test(pathname) &&
  req.method === "POST"
) {
  return withLogAndCors(req, pathname, (r) => postCommentHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/lp-timeline/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutLpTimelineHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/live/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutLiveHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/stats/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutStatsHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/champions/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutChampionsHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/habits/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutHabitsHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/trending/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => readScoutTrendingHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/refresh/") && req.method === "POST") {
  return withLogAndCors(req, pathname, (r) => refreshScoutLobbyHandler(r, pathname));
}

if (pathname.startsWith("/api/scout/resolve-puuid/") && req.method === "GET") {
  return withLogAndCors(req, pathname, (r) => resolvePuuidHandler(r, pathname));
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

if (pathname === "/api/billing/portal-session" && req.method === "POST") {
  return withLogAndCors(req, pathname, createPortalSessionHandler);
}

if (pathname === "/api/champion/items" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionItemsHandler);
}

if (pathname === "/api/champion/runes" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionRunesHandler);
}

if (pathname === "/api/champion/souls" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionSoulsHandler);
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

if (pathname === "/api/champion/patches" && req.method === "GET") {
  return withLogAndCors(req, pathname, getAvailablePatchesHandler);
}

if (pathname === "/api/champion/otp-ranking" && req.method === "POST") {
  return withLogAndCors(req, pathname, getChampionOtpRankingHandler);
}

if (pathname === "/api/player-ranks" && req.method === "POST") {
  return withLogAndCors(req, pathname, getPlayerRanksHandler);
}

if (pathname === "/api/auth/riot/url" && req.method === "POST") {
  return withLogAndCors(req, pathname, riotAuthUrlHandler);
}

if (pathname === "/api/auth/riot/callback" && req.method === "POST") {
  return withLogAndCors(req, pathname, riotAuthCallbackHandler);
}

if (pathname === "/api/tierlist/snapshot" && req.method === "POST") {
  return withLogAndCors(req, pathname, generateSnapshotHandler);
}

if (pathname === "/api/tierlist" && req.method === "GET") {
  return withLogAndCors(req, pathname, getTierlistHandler);
}

// ── Learn endpoints ──
if (pathname === "/api/learn/overview" && req.method === "POST") {
  return withLogAndCors(req, pathname, learnOverviewHandler);
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

  // ── WebSocket handler — live scout lobby chat ─────────────────────
  // Sockets are upgraded in `fetch` above with { data: { slug } }. On
  // open we subscribe the socket to this lobby's topic; the HTTP chat
  // POST handler then `server.publish()`-es new messages to it. Clients
  // are receive-only (they POST via REST), so inbound frames are
  // ignored beyond a lightweight ping/pong keepalive.
  websocket: {
    open(ws) {
      const { slug } = ws.data as ScoutWsData;
      ws.subscribe(chatTopic(slug));
    },
    message(ws, raw) {
      // Keepalive only. The client may send "ping"; reply "pong".
      if (typeof raw === "string" && raw === "ping") ws.send("pong");
    },
    close(ws) {
      const { slug } = ws.data as ScoutWsData;
      try {
        ws.unsubscribe(chatTopic(slug));
      } catch {
        /* already gone */
      }
    },
  },
})

// Hand the live server to the realtime hub so the chat POST handler can
// broadcast inserted messages to subscribed sockets.
setRealtimeServer(server);
