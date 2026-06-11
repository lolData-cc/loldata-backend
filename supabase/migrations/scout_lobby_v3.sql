-- supabase/migrations/scout_lobby_v3.sql
--
-- Lobby v3 additions:
--   • enabled_tabs  — per-lobby toggle for which tabs render in the
--                     UI. Existing lobbies migrate to the 7 classic
--                     tabs; chat + compare default OFF.
--   • verify_mode   — admin can disable verification entirely, allow
--                     only Phase 1 (claim invites + Grade 1 badge)
--                     or run the full Phase 2 challenge.
--   • scout_lobby_messages — group chat per lobby. Only claimed
--                            members can post; anyone with access
--                            to the lobby can read.

-- ─── lobby config columns ──────────────────────────────────────────
ALTER TABLE scout_lobbies
  ADD COLUMN IF NOT EXISTS enabled_tabs TEXT[] NOT NULL
    DEFAULT ARRAY[
      'matches','stats','champions','habits',
      'live','leaderboard','trending'
    ],
  ADD COLUMN IF NOT EXISTS verify_mode  TEXT   NOT NULL DEFAULT 'full';

ALTER TABLE scout_lobbies
  DROP CONSTRAINT IF EXISTS scout_lobbies_verify_mode_check;
ALTER TABLE scout_lobbies
  ADD  CONSTRAINT scout_lobbies_verify_mode_check
       CHECK (verify_mode IN ('disabled','claim_only','full'));

-- ─── chat messages ─────────────────────────────────────────────────
-- Single bucket of messages per lobby. Cache display_name + color at
-- write time so the chat can render fast even if the underlying
-- lobby_player gets renamed / re-coloured later.
CREATE TABLE IF NOT EXISTS scout_lobby_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug      TEXT        NOT NULL
                    REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  -- Author's auth.users.id (must be a claimer in this lobby).
  profile_id      UUID        NOT NULL,
  -- Their claimed lobby_player_id (denormalised so we can join to
  -- icon + colour without re-resolving). NULL if the row was created
  -- before claiming (shouldn't happen, but defensive).
  lobby_player_id UUID
                    REFERENCES scout_lobby_players(id) ON DELETE SET NULL,
  display_name    TEXT        NOT NULL,
  color           TEXT,
  content         TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 800),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scout_lobby_messages_lobby_time
  ON scout_lobby_messages (lobby_slug, created_at DESC);
