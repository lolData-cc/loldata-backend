// src/server/ai/chatStore.ts
//
// Per-account persistence for LOLDATA AI. One row per message, keyed by the
// Supabase auth user id, stored on the box pg (same place the Explorer tables
// live — created on first use, no manual migration). Read on chat open, two rows
// appended per turn. Failures never break the chat (logged, swallowed).

import { explorerPool } from "../explorer/pool";

export type StoredMsg = { role: "user" | "assistant"; content: string; actions?: unknown; embeds?: unknown };

let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!_ensured) {
    _ensured = (async () => {
      const c = await explorerPool().connect();
      try {
        await c.query(`
          CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id          bigserial PRIMARY KEY,
            user_id     text NOT NULL,
            role        text NOT NULL,
            content     text NOT NULL,
            actions     jsonb,
            embeds      jsonb,
            created_at  timestamptz NOT NULL DEFAULT now()
          );
          ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS embeds jsonb;
          CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_messages (user_id, id);
        `);
      } finally {
        c.release();
      }
    })().catch((e) => {
      _ensured = null; // allow a retry on the next call
      throw e;
    });
  }
  return _ensured;
}

export async function loadHistory(userId: string, limit = 100): Promise<StoredMsg[]> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      const r = await c.query(
        `SELECT role, content, actions, embeds FROM ai_chat_messages
          WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
        [userId, limit]
      );
      return r.rows
        .reverse()
        .map((x: any) => ({ role: x.role, content: x.content, actions: x.actions ?? undefined, embeds: x.embeds ?? undefined }));
    } finally {
      c.release();
    }
  } catch (e) {
    console.error("[ai/store] load:", (e as Error)?.message ?? e);
    return [];
  }
}

export async function saveTurn(
  userId: string,
  userText: string,
  assistant: { content: string; actions?: unknown; embeds?: unknown }
): Promise<void> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      await c.query(
        `INSERT INTO ai_chat_messages (user_id, role, content, actions, embeds)
         VALUES ($1, 'user', $2, NULL, NULL), ($1, 'assistant', $3, $4, $5)`,
        [userId, userText, assistant.content,
         assistant.actions ? JSON.stringify(assistant.actions) : null,
         assistant.embeds ? JSON.stringify(assistant.embeds) : null]
      );
    } finally {
      c.release();
    }
  } catch (e) {
    console.error("[ai/store] save:", (e as Error)?.message ?? e);
  }
}

export async function clearHistory(userId: string): Promise<void> {
  try {
    await ensure();
    const c = await explorerPool().connect();
    try {
      await c.query(`DELETE FROM ai_chat_messages WHERE user_id = $1`, [userId]);
    } finally {
      c.release();
    }
  } catch (e) {
    console.error("[ai/store] clear:", (e as Error)?.message ?? e);
  }
}
