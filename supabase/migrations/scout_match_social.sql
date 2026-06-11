-- supabase/migrations/scout_match_social.sql
--
-- Per-match social: likes + comments scoped to a scout lobby.
--
-- Match IDs are Riot-namespaced strings (e.g. EUW1_1234567890) and
-- are NOT FKs to a `matches` table because the lobby can reference
-- matches we haven't ingested yet. Scoping by lobby_slug keeps the
-- data partitioned and lets us index efficiently.

-- ─── likes ─────────────────────────────────────────────────────────
-- One row per (profile, match) — UNIQUE constraint enforces "one
-- like per user per match". Toggling = INSERT or DELETE.
CREATE TABLE IF NOT EXISTS scout_match_reactions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug   TEXT        NOT NULL
                 REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  match_id     TEXT        NOT NULL,
  profile_id   UUID        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lobby_slug, match_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_match_reactions_match
  ON scout_match_reactions (lobby_slug, match_id);

CREATE INDEX IF NOT EXISTS idx_scout_match_reactions_profile
  ON scout_match_reactions (lobby_slug, profile_id);

-- ─── comments ──────────────────────────────────────────────────────
-- Single bucket of comments per match. Cache display_name + color
-- at write time (same pattern as scout_lobby_messages) so renders
-- stay fast and survive a player rename.
CREATE TABLE IF NOT EXISTS scout_match_comments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug      TEXT        NOT NULL
                    REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  match_id        TEXT        NOT NULL,
  profile_id      UUID        NOT NULL,
  lobby_player_id UUID
                    REFERENCES scout_lobby_players(id) ON DELETE SET NULL,
  display_name    TEXT        NOT NULL,
  color           TEXT,
  content         TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 600),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scout_match_comments_match_time
  ON scout_match_comments (lobby_slug, match_id, created_at);
