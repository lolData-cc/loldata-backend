-- supabase/migrations/scout_lobby_verify.sql
--
-- Lobby identity verification.
--
-- Concept:
--   • An admin issues a "claim invite" link for one of their lobby
--     players (e.g. "Gabri"). The link is reusable — anyone who has
--     it can attempt to claim, but only the first logged-in user
--     wins. The admin can revoke the link at any time.
--   • When a user claims, scout_lobby_players.claimed_by_profile_id
--     is set, and the player gains "Verify Grade 1" (identity verified).
--   • Grade 2 is unlocked when EVERY Riot account on that player has
--     passed the icon-change challenge (Phase 2 columns below).
--   • Admins of a lobby are tracked in scout_lobby_admins. The lobby
--     creator is auto-inserted as admin; they can promote other
--     claimed users to co-admin.
--
-- Time policy: timestamptz everywhere. claimed_at fixed at first claim.

-- ─── claim_invites ─────────────────────────────────────────────────
-- One active invite per lobby_player. Revoking = deleting the row.
-- Regenerating = inserting a new one with a fresh token.

CREATE TABLE IF NOT EXISTS scout_player_claim_invites (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug             TEXT        NOT NULL
                           REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  lobby_player_id        UUID        NOT NULL UNIQUE
                           REFERENCES scout_lobby_players(id) ON DELETE CASCADE,
  -- The opaque URL token. Used as the URL slug in /scout/claim/:token.
  token                  TEXT        NOT NULL UNIQUE,
  created_by_profile_id  UUID        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scout_claim_invites_token
  ON scout_player_claim_invites (token);

-- ─── claim state on lobby_players ──────────────────────────────────
-- Idempotent ALTERs so this migration can be re-run safely.

ALTER TABLE scout_lobby_players
  ADD COLUMN IF NOT EXISTS claimed_by_profile_id UUID,
  ADD COLUMN IF NOT EXISTS claimed_at            TIMESTAMPTZ,
  -- Default OFF as the user spec asked — the admin must explicitly
  -- toggle the green Meta-style badge on per player.
  ADD COLUMN IF NOT EXISTS show_verify_badge     BOOLEAN NOT NULL DEFAULT FALSE;

-- Fast lookup: "is this user claimed in this lobby?" — used by both
-- admin checks and the rhombus FAB visibility.
CREATE INDEX IF NOT EXISTS idx_scout_lobby_players_claimed_by
  ON scout_lobby_players (claimed_by_profile_id)
  WHERE claimed_by_profile_id IS NOT NULL;

-- ─── lobby_admins (creator + promoted co-admins) ────────────────────
-- The lobby creator is always admin (auto-inserted below). Other
-- claimed users can be promoted by an existing admin.

CREATE TABLE IF NOT EXISTS scout_lobby_admins (
  lobby_slug   TEXT        NOT NULL
                 REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  profile_id   UUID        NOT NULL,           -- auth.users.id
  -- NULL for the creator (granted implicitly at lobby creation).
  granted_by   UUID,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lobby_slug, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_lobby_admins_profile
  ON scout_lobby_admins (profile_id);

-- Backfill creators for existing lobbies — every lobby that already
-- has an owner_user_id gets an admin row. Idempotent via ON CONFLICT.
INSERT INTO scout_lobby_admins (lobby_slug, profile_id, granted_at)
SELECT slug, owner_user_id, created_at
FROM scout_lobbies
WHERE owner_user_id IS NOT NULL
ON CONFLICT (lobby_slug, profile_id) DO NOTHING;

-- ─── Phase 2: per-account icon-challenge verification ───────────────
-- Added here so we don't need a follow-up migration. NULL until the
-- user starts the challenge for a given account.
--   verification_target_icon_id  — the profile-icon id the user must
--                                  set in League client to prove
--                                  ownership of the Riot account.
--   verification_started_at      — issued-at, so we can rate-limit
--                                  retries / expire stale challenges.
--   verified_at                  — set when the icon-change check
--                                  passes.

ALTER TABLE scout_lobby_accounts
  ADD COLUMN IF NOT EXISTS verification_target_icon_id INT,
  ADD COLUMN IF NOT EXISTS verification_started_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_at                 TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scout_lobby_accounts_verified
  ON scout_lobby_accounts (lobby_player_id)
  WHERE verified_at IS NOT NULL;
