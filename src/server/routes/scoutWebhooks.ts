// src/server/routes/scoutWebhooks.ts
//
// CRUD for a scout lobby's Discord webhook integrations.
//
//   GET    /api/scout/webhooks/<slug>            list (URLs masked)
//   POST   /api/scout/webhooks/<slug>            create   { url, label?, queueFilter?, minDurationS? }
//   PATCH  /api/scout/webhooks/<slug>/<id>       update   { enabled?, label?, queueFilter?, minDurationS? }
//   DELETE /api/scout/webhooks/<slug>/<id>       remove
//   POST   /api/scout/webhooks/<slug>/<id>/test  send a sample embed now
//
// Authorization mirrors the lobby edit dialog: the owner (by session user or
// by ?key=<ownerKey>). A webhook URL is a bearer credential for a Discord
// channel, so it is NEVER echoed back in full — list/read return a mask.

import { supabaseAdmin } from "../supabase/client";
import {
  buildMatchEmbeds,
  isValidAvatarUrl,
  isValidDiscordWebhook,
  maskWebhookUrl,
  postToWebhook,
  resolveWebhookChannel,
  DEFAULT_WEBHOOK_AVATAR,
  DEFAULT_WEBHOOK_USERNAME,
} from "../services/scoutWebhook";

const MAX_WEBHOOKS_PER_LOBBY = 3;

// Same local helper the other scout route files use (there is no shared one).
async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

type OwnerCheck =
  | { ok: true; slug: string; lobbyName: string; userId: string | null }
  | { ok: false; res: Response };

async function requireLobbyOwner(req: Request, slug: string): Promise<OwnerCheck> {
  const { data: lobby, error } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug, name, owner_key, owner_user_id")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !lobby) {
    return { ok: false, res: Response.json({ error: "Lobby not found" }, { status: 404 }) };
  }

  const providedKey = new URL(req.url).searchParams.get("key");
  const userId = await getAuthUserId(req);
  const isOwnerByUser = !!userId && userId === (lobby as any).owner_user_id;
  const isOwnerByKey = !!providedKey && providedKey === (lobby as any).owner_key;

  if (!isOwnerByUser && !isOwnerByKey) {
    return { ok: false, res: Response.json({ error: "Not authorized" }, { status: 403 }) };
  }
  return { ok: true, slug, lobbyName: (lobby as any).name ?? "Scout lobby", userId };
}

function publicRow(r: any) {
  return {
    id: r.id,
    label: r.label ?? null,
    target: maskWebhookUrl(r.url),          // masked — never the raw URL
    enabled: !!r.enabled,
    queueFilter: r.queue_filter ?? null,
    minDurationS: r.min_duration_s ?? 300,
    // Bot identity. null on either = that field is not overridden, so Discord
    // falls back to what the webhook itself is configured with.
    username: r.username ?? null,
    avatarUrl: r.avatar_url ?? null,
    createdAt: r.created_at,
    lastPostedAt: r.last_posted_at ?? null,
    lastError: r.last_error ?? null,
    lastErrorAt: r.last_error_at ?? null,
  };
}

// ── GET /api/scout/webhooks/<slug> ──────────────────────────────────────
export async function listScoutWebhooksHandler(req: Request, pathname: string): Promise<Response> {
  const slug = pathname.split("/")[4];
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const auth = await requireLobbyOwner(req, slug);
  if (!auth.ok) return auth.res;

  const { data, error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .select("*")
    .eq("lobby_slug", slug)
    .order("created_at", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ webhooks: (data ?? []).map(publicRow) });
}

// ── POST /api/scout/webhooks/<slug> ─────────────────────────────────────
export async function createScoutWebhookHandler(req: Request, pathname: string): Promise<Response> {
  const slug = pathname.split("/")[4];
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const auth = await requireLobbyOwner(req, slug);
  if (!auth.ok) return auth.res;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = String(body?.url ?? "").trim();
  if (!isValidDiscordWebhook(url)) {
    return Response.json(
      { error: "Not a valid Discord webhook URL (https://discord.com/api/webhooks/…)" },
      { status: 400 }
    );
  }

  const { count } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .select("id", { count: "exact", head: true })
    .eq("lobby_slug", slug);
  if ((count ?? 0) >= MAX_WEBHOOKS_PER_LOBBY) {
    return Response.json(
      { error: `Limit reached (${MAX_WEBHOOKS_PER_LOBBY} webhooks per lobby)` },
      { status: 409 }
    );
  }

  // Bind the channel now so the bot's /live can find this lobby later. Best
  // effort — a webhook that Discord will not describe still works for posting.
  const channel = await resolveWebhookChannel(url);

  const queueFilter = Array.isArray(body?.queueFilter)
    ? body.queueFilter.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : null;

  const { data, error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .insert({
      lobby_slug: slug,
      url,
      label: body?.label ? String(body.label).slice(0, 60) : null,
      queue_filter: queueFilter && queueFilter.length ? queueFilter : null,
      min_duration_s: Number.isFinite(Number(body?.minDurationS)) ? Number(body.minDurationS) : 300,
      // Seeded with the loldata identity so a fresh channel looks branded with
      // no setup; the owner can change or clear both afterwards.
      username: DEFAULT_WEBHOOK_USERNAME,
      avatar_url: DEFAULT_WEBHOOK_AVATAR,
      channel_id: channel?.channelId ?? null,
      guild_id: channel?.guildId ?? null,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ webhook: publicRow(data) }, { status: 201 });
}

// ── PATCH /api/scout/webhooks/<slug>/<id> ───────────────────────────────
export async function updateScoutWebhookHandler(req: Request, pathname: string): Promise<Response> {
  const parts = pathname.split("/");
  const slug = parts[4];
  const id = parts[5];
  if (!slug || !id) return Response.json({ error: "Missing slug or id" }, { status: 400 });

  const auth = await requireLobbyOwner(req, slug);
  if (!auth.ok) return auth.res;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body?.enabled === "boolean") {
    patch.enabled = body.enabled;
    // Re-enabling clears the failure state so the sweep gives it a fresh run.
    if (body.enabled) { patch.fail_count = 0; patch.last_error = null; }
  }
  if (body?.label !== undefined) patch.label = body.label ? String(body.label).slice(0, 60) : null;
  if (body?.queueFilter !== undefined) {
    const qf = Array.isArray(body.queueFilter)
      ? body.queueFilter.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : null;
    patch.queue_filter = qf && qf.length ? qf : null;
  }
  if (body?.minDurationS !== undefined && Number.isFinite(Number(body.minDurationS))) {
    patch.min_duration_s = Number(body.minDurationS);
  }
  // Identity — an empty string clears the override (→ Discord's own identity).
  if (body?.username !== undefined) {
    const u = String(body.username ?? "").trim();
    patch.username = u ? u.slice(0, 80) : null;
  }
  if (body?.avatarUrl !== undefined) {
    const a = String(body.avatarUrl ?? "").trim();
    if (a && !isValidAvatarUrl(a)) {
      return Response.json({ error: "Avatar must be an http(s) image URL" }, { status: 400 });
    }
    patch.avatar_url = a || null;
  }
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .update(patch)
    .eq("id", id)
    .eq("lobby_slug", slug)   // scope to the lobby we authorized
    .select("*")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Webhook not found" }, { status: 404 });
  return Response.json({ webhook: publicRow(data) });
}

// ── DELETE /api/scout/webhooks/<slug>/<id> ──────────────────────────────
export async function deleteScoutWebhookHandler(req: Request, pathname: string): Promise<Response> {
  const parts = pathname.split("/");
  const slug = parts[4];
  const id = parts[5];
  if (!slug || !id) return Response.json({ error: "Missing slug or id" }, { status: 400 });

  const auth = await requireLobbyOwner(req, slug);
  if (!auth.ok) return auth.res;

  const { error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .delete()
    .eq("id", id)
    .eq("lobby_slug", slug);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

// ── POST /api/scout/webhooks/<slug>/<id>/test ───────────────────────────
// Sends a representative embed so the user can confirm the channel wiring
// without waiting for a real game.
export async function testScoutWebhookHandler(req: Request, pathname: string): Promise<Response> {
  const parts = pathname.split("/");
  const slug = parts[4];
  const id = parts[5];
  if (!slug || !id) return Response.json({ error: "Missing slug or id" }, { status: 400 });

  const auth = await requireLobbyOwner(req, slug);
  if (!auth.ok) return auth.res;

  const { data: row, error } = await supabaseAdmin
    .from("scout_lobby_webhooks")
    .select("*")
    .eq("id", id)
    .eq("lobby_slug", slug)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!row) return Response.json({ error: "Webhook not found" }, { status: 404 });

  const embeds = await buildMatchEmbeds({
    lobbyName: auth.lobbyName,
    lobbySlug: slug,
    matchId: "EUW1_0000000000",
    queueId: 420,
    durationSec: 1802,
    gameEndMs: Date.now(),
    avgLadderScore: 2450, // ≈ Emerald — just for the preview
    // Shown so the preview demonstrates the "pros in this game" line.
    notables: [
      { name: "Caps", slug: "caps", championName: "Nidalee", kind: "pro" },
    ],
    players: [
      {
        displayName: "Test player",
        riotId: null,
        region: "euw1",
        championName: "Lillia",
        win: true,
        kills: 12,
        deaths: 3,
        assists: 14,
        cs: 214,
        damage: 28400,
        kp: 72,
        lpDelta: 22,
        tier: "EMERALD",
        division: "II",
        lp: 64,
        rankChange: null,
        visionScore: 41,
      },
    ],
  });

  const res = await postToWebhook((row as any).url, embeds, {
    username: (row as any).username,
    avatarUrl: (row as any).avatar_url,
  });
  if (!res.ok) {
    await supabaseAdmin
      .from("scout_lobby_webhooks")
      .update({ last_error: res.error, last_error_at: new Date().toISOString() })
      .eq("id", id);
    return Response.json({ error: `Delivery failed: ${res.error}` }, { status: 502 });
  }

  await supabaseAdmin
    .from("scout_lobby_webhooks")
    .update({ last_error: null, fail_count: 0, last_posted_at: new Date().toISOString() })
    .eq("id", id);
  return Response.json({ ok: true });
}
