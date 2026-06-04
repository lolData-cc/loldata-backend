-- ─────────────────────────────────────────────────────────────────────────
-- Scout / Feed system: shareable lobbies of up to 20 players (each with
-- up to 3 Riot accounts) with a unified match feed + stat leaderboards.
-- ─────────────────────────────────────────────────────────────────────────

-- Top-level lobby record. `slug` is the public shareable id (7-char nanoid).
-- `owner_key` is a separate secret that grants edit rights (so the read-only
-- link stays short and safe to share publicly).
CREATE TABLE IF NOT EXISTS scout_lobbies (
  slug             TEXT        PRIMARY KEY,
  name             TEXT        NOT NULL,
  owner_key        TEXT        NOT NULL,
  owner_user_id    UUID        NULL,           -- supabase auth.users.id of creator
  is_public        BOOLEAN     NOT NULL DEFAULT TRUE,
  password_hash    TEXT        NULL,           -- optional, for private lobbies
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scout_lobbies_owner
  ON scout_lobbies (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_scout_lobbies_last_active
  ON scout_lobbies (last_active_at DESC);

-- A "player" inside a lobby — the user-given display name (e.g. "Marco").
-- A single player can map to 1..3 Riot accounts (see scout_lobby_accounts).
-- order_index keeps display order stable across reads.
CREATE TABLE IF NOT EXISTS scout_lobby_players (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug   TEXT        NOT NULL REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  display_name TEXT        NOT NULL,
  color        TEXT        NULL,              -- optional accent (#hex)
  order_index  INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scout_lobby_players_lobby
  ON scout_lobby_players (lobby_slug, order_index);

-- A single Riot account attached to a lobby player. We store puuid + region
-- as the source of truth and cache riot_name/tag for display so we don't
-- need to re-resolve on every read.
CREATE TABLE IF NOT EXISTS scout_lobby_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_player_id UUID        NOT NULL REFERENCES scout_lobby_players(id) ON DELETE CASCADE,
  puuid           TEXT        NOT NULL,
  region          TEXT        NOT NULL,
  riot_name       TEXT        NOT NULL,
  riot_tag        TEXT        NOT NULL,
  is_primary      BOOLEAN     NOT NULL DEFAULT FALSE,
  order_index     INT         NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lobby_player_id, puuid, region)
);

CREATE INDEX IF NOT EXISTS idx_scout_lobby_accounts_player
  ON scout_lobby_accounts (lobby_player_id, order_index);

CREATE INDEX IF NOT EXISTS idx_scout_lobby_accounts_puuid
  ON scout_lobby_accounts (puuid);

-- Rank snapshots: one row per (puuid, taken_at) — written after each ingested
-- match so we can compute LP gain over arbitrary time windows for a lobby.
-- Bounded to puuids that appear in at least one lobby (enforced by the
-- ingestion hook, not a constraint, since accounts can be removed later).
CREATE TABLE IF NOT EXISTS scout_rank_snapshots (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  puuid         TEXT        NOT NULL,
  region        TEXT        NOT NULL,
  queue_type    TEXT        NOT NULL,         -- RANKED_SOLO_5x5 / RANKED_FLEX_SR
  tier          TEXT        NOT NULL,         -- IRON..CHALLENGER
  rank_division TEXT        NULL,             -- I..IV (null for apex)
  lp            INT         NOT NULL,
  wins          INT         NOT NULL,
  losses        INT         NOT NULL,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_id      TEXT        NULL              -- the match that triggered this snapshot
);

CREATE INDEX IF NOT EXISTS idx_scout_rank_snapshots_puuid_time
  ON scout_rank_snapshots (puuid, queue_type, taken_at DESC);
