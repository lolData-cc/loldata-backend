-- sql/scout_webhooks.sql
--
-- Scout lobby → Discord webhook integration.
--
-- A lobby can register one or more Discord webhook URLs; the periodic sweep
-- posts a rich embed to them whenever a lobby member finishes a game, turning
-- a Discord channel into a mirror of the lobby feed.
--
-- Lives on Supabase CLOUD (all scout_* tables do — the box only holds match
-- data). Apply with:  bun run scripts/apply-scout-webhooks.ts
--
-- Both tables are service-role only: the backend is the sole writer/reader and
-- the webhook URL is a secret (anyone holding it can post to the channel), so
-- RLS stays ON with no policies → the anon key can't touch them.

CREATE TABLE IF NOT EXISTS scout_lobby_webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug      text NOT NULL,
  -- Full Discord webhook URL. Never returned to the client in full (the API
  -- masks it) — it is a bearer credential for that channel.
  url             text NOT NULL,
  label           text,
  enabled         boolean NOT NULL DEFAULT true,
  -- NULL = every queue. Otherwise the queueIds to post (e.g. '{420}' = solo).
  queue_filter    integer[],
  -- Games shorter than this are skipped (remakes). 300s = Riot's remake line.
  min_duration_s  integer NOT NULL DEFAULT 300,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_posted_at  timestamptz,
  -- Last delivery failure, surfaced in the lobby UI so a dead webhook is
  -- visible instead of silently doing nothing.
  last_error      text,
  last_error_at   timestamptz,
  -- Consecutive failures; the sweep auto-disables after too many (a deleted
  -- Discord channel would otherwise be retried forever).
  fail_count      integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS scout_lobby_webhooks_slug_idx
  ON scout_lobby_webhooks (lobby_slug);
CREATE INDEX IF NOT EXISTS scout_lobby_webhooks_enabled_idx
  ON scout_lobby_webhooks (enabled) WHERE enabled;

-- Dedupe ledger. Keyed by (webhook_id, match_id) — NOT per player — so a game
-- shared by several lobby members produces ONE squad embed, and a sweep that
-- runs twice never double-posts.
CREATE TABLE IF NOT EXISTS scout_webhook_posted (
  webhook_id  uuid NOT NULL REFERENCES scout_lobby_webhooks(id) ON DELETE CASCADE,
  match_id    text NOT NULL,
  posted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (webhook_id, match_id)
);

CREATE INDEX IF NOT EXISTS scout_webhook_posted_at_idx
  ON scout_webhook_posted (posted_at);

-- Per-webhook bot identity. Discord lets a webhook message override the name
-- and picture the channel configured for it; these two columns are that
-- override.
--
--   set   → the message shows this name / picture
--   NULL  → we send nothing, so Discord falls back to the identity configured
--           on the webhook itself (Channel → Integrations → Webhooks), where a
--           file can be uploaded directly instead of hosting an image
--
-- New rows are seeded with the loldata defaults so a channel looks branded
-- without any setup.
ALTER TABLE scout_lobby_webhooks ADD COLUMN IF NOT EXISTS username   text;
ALTER TABLE scout_lobby_webhooks ADD COLUMN IF NOT EXISTS avatar_url text;

-- Where this webhook actually posts. Resolved once at creation by GETting the
-- webhook URL itself (the token in the URL is the credential — no bot needed).
-- It is what lets the Discord bot answer "/live" with the right lobby: the
-- command knows only the channel it was typed in, and this is the join.
ALTER TABLE scout_lobby_webhooks ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE scout_lobby_webhooks ADD COLUMN IF NOT EXISTS guild_id   text;

CREATE INDEX IF NOT EXISTS scout_lobby_webhooks_channel_idx
  ON scout_lobby_webhooks (channel_id) WHERE channel_id IS NOT NULL;

ALTER TABLE scout_lobby_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scout_webhook_posted ENABLE ROW LEVEL SECURITY;
