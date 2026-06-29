// src/server/services/telegram.ts
//
// Fire-and-forget admin notifications to a Telegram chat via the Bot API — an
// "admin feed" of the events worth knowing about (signups, subscriptions, new
// scout lobbies, …). No bot process to run: we only send messages with a bot
// token from @BotFather.
//
// Configure (env):
//   TELEGRAM_BOT_TOKEN     — the token @BotFather gives you
//   TELEGRAM_ADMIN_CHAT_ID — the chat to post to (your own user id, or a group)
// If either is unset, notifyAdmin() is a silent no-op, so this never affects
// prod behaviour until you wire it up.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

export const telegramConfigured = Boolean(TOKEN && CHAT_ID);

// Escape the three characters Telegram's HTML parse mode cares about, so user
// content (names, lobby titles) can never break the markup.
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send an admin notification. HTML parse mode (use <b>…</b>, <code>…</code>).
 * Always resolves — failures are logged, never thrown, so a notification
 * problem can never break the request that triggered it.
 */
export async function notifyAdmin(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return; // not configured → no-op
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.error("[telegram] notify failed:", e instanceof Error ? e.message : e);
  }
}
