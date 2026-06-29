// src/server/routes/contact.ts
//
// POST /api/contact — public contact form sink. Forwards the message straight to
// the admin Telegram feed (the message itself is the record, so no inbox infra
// is required). Light per-IP rate limit since it's unauthenticated.

import { notifyAdmin, esc } from "../services/telegram";

const RL = new Map<string, { count: number; resetAt: number }>();
const RL_MAX = 5;
const RL_WINDOW = 10 * 60 * 1000; // 5 messages / 10 min / IP

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = RL.get(ip);
  if (!e || now > e.resetAt) {
    RL.set(ip, { count: 1, resetAt: now + RL_WINDOW });
    return false;
  }
  e.count++;
  return e.count > RL_MAX;
}

export async function contactHandler(req: Request): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many messages — try again later." }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const email = str(body?.email, 200);
  const subject = str(body?.subject, 200);
  const message = str(body?.message, 4000);

  if (!message) return Response.json({ error: "Message is required" }, { status: 400 });

  void notifyAdmin(
    `✉️ <b>New contact message</b>\n${subject ? `<b>${esc(subject)}</b>\n` : ""}${esc(message)}\n\n— ${esc(email || "(no email provided)")}`,
  );
  return Response.json({ ok: true });
}
