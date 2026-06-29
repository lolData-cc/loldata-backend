// src/server/routes/adminHooks.ts
//
// Sink for Supabase Database Webhooks → Telegram admin feed. Supabase can't
// reach into our process, so for DB-level events (a new signup row, a contact
// message, …) we expose ONE secured endpoint and point a Supabase webhook at it.
//
//   POST /api/admin/hooks/supabase   — Supabase DB webhook target
//   GET  /api/admin/hooks/test       — send a test message to verify wiring
//
// Both require the shared secret in the `x-webhook-secret` header (env
// ADMIN_WEBHOOK_SECRET). Supabase lets you add that header when you create the
// webhook (Database → Webhooks → HTTP Headers).

import { notifyAdmin, esc, telegramConfigured } from "../services/telegram";

function authed(req: Request): boolean {
  const secret = process.env.ADMIN_WEBHOOK_SECRET;
  if (!secret) return false;
  return req.headers.get("x-webhook-secret") === secret;
}

// Supabase webhook payload shape:
//   { type: "INSERT"|"UPDATE"|"DELETE", table, schema, record, old_record }
type SupabaseHook = {
  type?: string;
  table?: string;
  record?: Record<string, any> | null;
  old_record?: Record<string, any> | null;
};

export async function supabaseHookHandler(req: Request): Promise<Response> {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });

  let body: SupabaseHook;
  try {
    body = (await req.json()) as SupabaseHook;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, table, record } = body;
  const rec = record ?? {};

  // New signup — a fresh profile_players row.
  if (type === "INSERT" && table === "profile_players") {
    const who = rec.nametag || rec.email || rec.profile_id || "unknown";
    const region = rec.region ? ` · <code>${esc(rec.region)}</code>` : "";
    void notifyAdmin(`🆕 <b>New signup</b>\n${esc(who)}${region}`);
  }

  // Streamer application — users apply on /streamers (streamer_applications).
  else if (type === "INSERT" && table === "streamer_applications") {
    const bits = [
      rec.twitch_username,
      rec.region,
      rec.avg_viewers ? `${rec.avg_viewers} viewers` : null,
    ]
      .filter(Boolean)
      .map((x) => esc(x))
      .join(" · ");
    void notifyAdmin(`📨 <b>New streamer application</b>\n${bits || "—"}`);
  }

  // Pro application — submitted through the Discord pipeline (proApplications).
  else if (type === "INSERT" && table === "proApplications") {
    const bits = [rec.name, rec.riot_id, rec.team, rec.nationality]
      .filter(Boolean)
      .map((x) => esc(x))
      .join(" · ");
    void notifyAdmin(`📨 <b>New pro application</b>\n${bits || "—"}`);
  }

  return Response.json({ ok: true });
}

export async function adminHookTestHandler(req: Request): Promise<Response> {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });
  if (!telegramConfigured) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID not set" },
      { status: 503 },
    );
  }
  await notifyAdmin("✅ <b>loldata admin feed online</b>\nTelegram notifications are wired up.");
  return Response.json({ ok: true });
}
