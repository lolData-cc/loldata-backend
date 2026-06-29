// src/server/routes/contact.ts
//
// POST /api/contact — public contact form sink. Two outputs:
//   1) an EMAIL to the loldata inbox via Resend (so messages land in Gmail), and
//   2) a ping to the admin Telegram feed.
// Both are best-effort and degrade independently (if RESEND_API_KEY is unset the
// email is skipped but Telegram still fires; if neither is set the endpoint still
// returns ok). Light per-IP rate limit since it's unauthenticated.

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

// Where contact mail lands, and who it's "from". With Resend's onboarding sender
// you can mail your OWN account address with no domain setup; once loldata.cc is
// verified in Resend, set CONTACT_FROM=contact@loldata.cc.
const CONTACT_TO = process.env.CONTACT_TO || "loldata.cc1@gmail.com";
const CONTACT_FROM = process.env.CONTACT_FROM || "loldata contact <onboarding@resend.dev>";

async function sendContactEmail(opts: {
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // email not configured → skip (Telegram still fires)
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CONTACT_FROM,
        to: [CONTACT_TO],
        subject: opts.subject,
        text: opts.text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[contact] resend ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.error("[contact] email failed:", e instanceof Error ? e.message : e);
  }
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

  const subj = subject || "Contact from loldata.cc";
  const text = `${message}\n\n— from: ${email || "(no email provided)"}`;

  // 1) email to the inbox (if Resend is configured)
  void sendContactEmail({ subject: subj, text, replyTo: email || undefined });

  // 2) admin Telegram feed
  void notifyAdmin(
    `✉️ <b>New contact message</b>\n<b>${esc(subj)}</b>\n${esc(message)}\n\n— ${esc(email || "(no email provided)")}`,
  );

  return Response.json({ ok: true });
}
