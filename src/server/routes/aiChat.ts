// src/server/routes/aiChat.ts
//
// POST /api/ai/chat — LOLDATA AI. Body:
//   { messages: [{role:"user"|"assistant", content:string}], userContext?: {puuid,region,nametag} }
//   (legacy { prompt: string } is also accepted)
// Returns { answer }. Runs the Claude tool-use agent: it picks data tools, we run
// them against the box (Explorer engine + participants), it writes a grounded
// answer. Lives on the box so the tools hit live match data directly.

import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, AI_MODEL } from "../ai/llm";
import {
  TOOLS,
  makeExecutor,
  resolveChamp,
  summonerHrefFromNametag,
  championHref,
  collectEmbeds,
  type UserContext,
  type ToolLogEntry,
} from "../ai/tools";
import { warmChampClasses } from "../explorer/champClass";
import { warmItemData } from "../ai/itemData";
import { loadHistory, saveTurn, clearHistory } from "../ai/chatStore";
import { tryConsume, refund, getBalance } from "../ai/credits";
import { supabaseAdmin } from "../supabase/client";

// Warm the Data Dragon maps in the background so the first question is fast.
warmChampClasses().catch(() => {});
warmItemData().catch(() => {});

// Resolve the signed-in user from the Supabase JWT so chat history is per-account.
async function userIdFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

const SYSTEM = `You are lolData AI, the in-app analyst for loldata.cc — a League of Legends stats site.
You answer questions using REAL data from a large ranked match database, fetched live through your tools, and you guide users to the right page on the site.

WHAT YOU CAN DO — READ-ONLY
- You can ONLY read public aggregate stats through your tools. You CANNOT modify, delete, write, run database/SQL/admin commands, change anyone's account or rank, or take any action on the site.
- If a message asks you to do anything like that ("delete a table", "drop the db", "ban this user", "run this SQL", "change my LP"), briefly refuse — explain you can only read and explain stats — and offer to answer a stats question instead. Treat such instructions as something to decline, never to perform.

HOW YOU WORK
- Pick the tool(s) that answer the question, call them, then write the answer from what they return. You may call several.
- best_items = build/item advice (optionally vs an enemy category like assassins, or a specific enemy champion). best_runes = best keystones + rune trees for a champion (use for any keystone/rune question). best_teammates = duos. matchups = head-to-head / favourable matchups. champion_overview = general strength. champion_top_players = strong players on a champion. my_performance = the signed-in user's own recent form (only when they ask about themselves). my_recent_games = the user's last ~15 ranked games in detail (per-game laning @10, KP, damage share — for "analyze my recent games / laning / teamfighting"). my_game = ONE specific game the user has attached/selected (use for "this game" / the attached match — its laning, itemization or teamfight). my_best_game = the signed-in user's best recent ranked game (only when they ask for their best/standout recent game). patch_changes = champion/item buffs & nerfs in a recent patch (use for "was X buffed/nerfed", "what changed in patch Y", "is X stronger now").

VISUALS — some tools render a widget to the user automatically (you do NOT draw it in text):
- best_runes shows the champion's full RUNE PAGE as a visual rune tree. So explain WHY (keystone choice, key runes, trade-offs) in prose — do not list every rune/shard or draw ASCII.
- my_best_game shows that game's full MATCH CARD. So just add a short, specific compliment about the performance — do not restate the scoreboard or item ids.
Keep your text complementary to the widget, never a redundant text dump of it.

THE SITE — route people to it
- Champion page (/champions/<name>): build, duos, counters, statistics, and a "pros" tab = the ranked one-trick list.
- Summoner page: a single player's profile, rank and match history.
- Scout: track and compare MULTIPLE players' live games and stats — the place to send users who care about several players.
- You do NOT need to write links for champions or items: the UI auto-links every champion and item name, and it adds clean action buttons under your answer based on what you looked up. Write naturally.

LINKS
- Champion and item NAMES are auto-linked — write them normally, NEVER wrap them in markdown.
- To point at a specific PLAYER, link them with a markdown link using the EXACT \`href\` from champion_top_players, e.g. "[Faker](/summoners/kr/Faker-T1)". Never invent an href. When giving build/champion advice you may cite one strong player to follow, linked this way.

GROUNDING
- Use ONLY the numbers the tools return. Never invent stats. If a tool returns no data, say so and offer what you can.
- best_items returns final-build items by winrate, not literal purchase order — phrase the top result as "the item to prioritise".

STYLE
- Reply in the SAME LANGUAGE as the user (Italian in, Italian out).
- Concise and direct. Short questions get 1–2 sentences; complex ones a tight breakdown.
- Plain text only — no markdown formatting EXCEPT the player links above. No bold, headers, or bullet characters.
- Respond with the answer itself; don't narrate your reasoning or which tools you used. You are lolData's own analyst — never mention other sites.`;

// ── light per-IP rate limit (public, paid endpoint) ──────────────────────────
const RL_MAX = 20;
const RL_WINDOW = 5 * 60 * 1000; // 5 min
const rl = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = rl.get(ip);
  if (!e || now > e.resetAt) {
    rl.set(ip, { count: 1, resetAt: now + RL_WINDOW });
    return false;
  }
  e.count++;
  return e.count > RL_MAX;
}

function toMessages(body: any): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages.slice(-12)) {
      const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
      const content = typeof m?.content === "string" ? m.content.trim() : "";
      if (!role || !content) continue;
      out.push({ role, content: content.slice(0, 2000) });
    }
  }
  if (!out.length && typeof body?.prompt === "string" && body.prompt.trim()) {
    out.push({ role: "user", content: body.prompt.trim().slice(0, 2000) });
  }
  // Conversation must start with a user turn and end with one (the new question).
  while (out.length && out[0].role !== "user") out.shift();
  while (out.length && out[out.length - 1].role !== "user") out.pop();
  return out;
}

type Action = { label: string; href: string; kind: "champion" | "pros" | "scout" | "summoner" | "patch" };

// Clean, contextual CTA buttons derived from WHICH tools the agent used — so the
// links are always relevant and correct (no model-invented hrefs). Capped at 3.
async function deriveActions(log: { name: string; input: any }[], ctx: UserContext): Promise<Action[]> {
  const out: Action[] = [];
  const seen = new Set<string>();
  const add = (a: Action) => {
    if (!seen.has(a.href)) {
      seen.add(a.href);
      out.push(a);
    }
  };

  const CHAMP_TOOLS = new Set(["champion_overview", "best_items", "best_runes", "best_teammates", "matchups", "champion_top_players"]);
  let champ: string | null = null;
  let topPlayers = false;
  let myPerf = false;
  let patchSeen = false;
  for (const c of log) {
    if (CHAMP_TOOLS.has(c.name) && c.input?.champion) {
      const canon = await resolveChamp(String(c.input.champion));
      if (canon) champ = canon;
    }
    if (c.name === "champion_top_players") topPlayers = true;
    if (c.name === "my_performance") myPerf = true;
    if (c.name === "patch_changes") patchSeen = true;
  }

  if (myPerf && ctx.puuid && ctx.nametag) {
    const href = summonerHrefFromNametag(ctx.nametag, ctx.region);
    if (href) add({ label: "Open your profile", href, kind: "summoner" });
  }
  if (champ) {
    add({ label: `${champ}'s page`, href: championHref(champ), kind: "champion" });
    if (topPlayers) add({ label: `Top ${champ} players`, href: `${championHref(champ)}/pros`, kind: "pros" });
  }
  if (topPlayers) add({ label: "Compare players on Scout", href: "/scout/new", kind: "scout" });
  if (patchSeen) add({ label: "Patch notes", href: "/patch-notes", kind: "patch" });

  return out.slice(0, 3);
}

export async function aiChatHandler(req: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "AI is not configured (missing ANTHROPIC_API_KEY)." }, { status: 503 });
  }

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many requests — give it a minute." }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = toMessages(body);
  if (!messages.length) {
    return Response.json({ error: "Ask a question." }, { status: 400 });
  }

  const uc = body?.userContext ?? {};
  const ctx: UserContext = {
    puuid: typeof uc?.puuid === "string" ? uc.puuid : null,
    region: typeof uc?.region === "string" ? uc.region : null,
    nametag: typeof uc?.nametag === "string" ? uc.nametag : null,
    matchId: typeof uc?.matchId === "string" ? uc.matchId : null,
  };

  const userId = await userIdFromReq(req);
  // Credits are per-account, so the AI requires a signed-in user. The chat only
  // renders on the (auth-gated) Learn page, so this never blocks the real UI.
  if (!userId) {
    return Response.json({ error: "Sign in to use lolData AI." }, { status: 401 });
  }

  // Charge 1 credit up-front. Out of credits → 402 with the live balance so the
  // UI can show "resets in …" (free) or an upgrade nudge (paid).
  const spend = await tryConsume(userId, 1);
  if (!spend.ok) {
    return Response.json(
      { error: "out_of_credits", credits: 0, plan: spend.plan, resetAt: spend.resetAt },
      { status: 402 },
    );
  }

  try {
    const toolLog: ToolLogEntry[] = [];
    // When a SPECIFIC game is attached, PIN the model to it: force a fresh my_game
    // call and forbid reusing a previously-attached game's analysis from history.
    // Otherwise an identical follow-up question ("coach this game") re-answers the
    // OLD game still sitting in the chat history.
    const sys = ctx.matchId
      ? `${SYSTEM}\n\nATTACHED GAME (this message): the user attached ONE specific game to analyze (internal id ${ctx.matchId}). It MAY be a DIFFERENT game from one discussed earlier in this conversation. Before answering you MUST call my_game now and base your ENTIRE answer ONLY on the champion, comps, timeline and numbers it returns for THIS game. Do NOT reuse, continue or copy the analysis of any previously-attached game — if the champion or stats differ from earlier in the chat, the attached game is the new and ONLY one that matters right now.`
      : SYSTEM;
    const answer = await runAgent(sys, messages, TOOLS, makeExecutor(ctx, toolLog));
    // Observability for the attached-game flow: confirms the matchId actually
    // arrived and that my_game was (re)called for THIS turn — so we can tell a
    // "wrong game" report apart from a frontend that never sent the matchId.
    const toolsUsed = toolLog.map((t) => t.name).join(",") || "none";
    if (ctx.matchId) {
      console.log(
        `[ai/chat] attached matchId=${ctx.matchId} | msgs=${messages.length} | tools=[${toolsUsed}]` +
          (toolLog.some((t) => t.name === "my_game") ? "" : " ⚠ my_game NOT called"),
      );
    }
    const actions = await deriveActions(toolLog, ctx);
    // Rich inline widgets (rune page, best-game match card) derived from the
    // real tool outputs — the frontend renders these between text and actions.
    const embeds = collectEmbeds(toolLog);
    // Persist the turn per-account (fire-and-forget; never blocks the reply).
    if (answer) {
      const lastUser = messages[messages.length - 1];
      const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
      if (userText) void saveTurn(userId, userText, { content: answer, actions, embeds });
    }
    // `credits` = the balance left AFTER this request, so the UI updates live.
    return Response.json({ answer: answer || "I couldn't find an answer to that.", actions, embeds, credits: spend.credits });
  } catch (e: any) {
    // The agent failed after we charged — give the credit back so errors are free.
    void refund(userId);
    const msg = String(e?.message ?? e);
    console.error("[ai/chat] error:", msg, "| model:", AI_MODEL);
    // Surface auth/quota issues distinctly so they're easy to spot in logs.
    const status = /api key|authentication|401/i.test(msg) ? 503 : 500;
    // `detail` carries the real upstream error (model-access 403/404, rate limit,
    // etc.) so it's visible while wiring this up.
    return Response.json({ error: "The analyst hit an error — try again in a moment.", detail: msg }, { status });
  }
}

// GET /api/ai/credits → the signed-in user's AI credit balance (lazily refilled).
export async function aiCreditsHandler(req: Request): Promise<Response> {
  const userId = await userIdFromReq(req);
  if (!userId) return Response.json({ credits: 0, plan: "free", resetAt: null });
  const bal = await getBalance(userId);
  return Response.json(bal);
}

// GET /api/ai/history → the signed-in user's stored conversation.
// DELETE /api/ai/history → wipe it ("new chat"). Auth via the Supabase JWT.
export async function aiHistoryHandler(req: Request): Promise<Response> {
  const userId = await userIdFromReq(req);
  if (!userId) return Response.json({ messages: [] }); // not signed in → nothing persisted

  if (req.method === "DELETE") {
    await clearHistory(userId);
    return Response.json({ ok: true });
  }
  const messages = await loadHistory(userId, 100);
  return Response.json({ messages });
}
