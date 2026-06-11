-- supabase/migrations/scout_bounties.sql
--
-- Daily Bounty feature for scout lobbies.
--   • scout_bounty_templates: the pool of challenge templates the
--     rotation picks from (kills 16, damage 60k, KP 70%, etc).
--   • scout_bounty_daily: one row per lobby per UTC calendar day.
--     The first player whose match satisfies the day's challenge
--     claims it via an atomic UPDATE … WHERE claimed_at IS NULL.
--
-- Time policy: UTC calendar day. Future iteration can layer
-- per-lobby timezones on top by storing a `timezone` column on
-- scout_lobbies and computing the local day in JS.

-- ─── Template pool ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scout_bounty_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT UNIQUE NOT NULL,
  -- Display strings.
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  -- The per-match metric the claim checker reads, in `participants`
  -- table column names. The handler maps `metric` to a real column
  -- and compares against `threshold`.
  --   "kills"          | participants.kills
  --   "damage"         | participants.total_damage_to_champions
  --   "kp_pct"         | computed: (kills+assists)/teamKills
  --   "vision"         | participants.vision_score
  --   "gold"           | participants.gold_earned
  --   "kda"            | computed: (kills+assists)/max(1,deaths)
  --   "zero_deaths_win"| participants.deaths == 0 AND win == true
  --   "assists"        | participants.assists
  --   "quick_win"      | participants.win AND matches.game_duration <= threshold
  --   "cs"             | participants.total_minions_killed + neutral_minions
  metric       TEXT NOT NULL,
  threshold    NUMERIC NOT NULL,
  -- common (60%), rare (30%), legendary (10%) — used to weight the
  -- daily rotation pick.
  rarity       TEXT NOT NULL CHECK (rarity IN ('common','rare','legendary')),
  icon         TEXT NOT NULL DEFAULT 'target',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Per-lobby per-day instance ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS scout_bounty_daily (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_slug   TEXT NOT NULL
                 REFERENCES scout_lobbies(slug) ON DELETE CASCADE,
  template_id  UUID NOT NULL
                 REFERENCES scout_bounty_templates(id) ON DELETE RESTRICT,
  -- UTC calendar day this bounty is valid for. UNIQUE with slug so
  -- each lobby gets exactly one bounty per day.
  day_utc      DATE NOT NULL,
  -- Claim fields — populated atomically when first satisfying match
  -- is ingested. Until then everything below is NULL.
  claimed_at                  TIMESTAMPTZ,
  claimed_by_lobby_player_id  UUID
                                REFERENCES scout_lobby_players(id) ON DELETE SET NULL,
  claimed_by_account_puuid    TEXT,
  claimed_match_id            TEXT,
  -- Actual achievement that triggered the claim (e.g. 17 kills, 65000
  -- damage, 0.74 KP) — surfaced on the UI so we can boast accuracy.
  claimed_value               NUMERIC,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lobby_slug, day_utc)
);

CREATE INDEX IF NOT EXISTS scout_bounty_daily_lookup
  ON scout_bounty_daily (lobby_slug, day_utc DESC);

CREATE INDEX IF NOT EXISTS scout_bounty_daily_claimed
  ON scout_bounty_daily (lobby_slug, claimed_by_lobby_player_id)
  WHERE claimed_at IS NOT NULL;

-- ─── Seed templates (10 initial challenges) ─────────────────────────
INSERT INTO scout_bounty_templates (code, title, description, metric, threshold, rarity, icon)
VALUES
  ('kills_16',     'Champion of the Brawl', 'Get 16+ kills in a single match',          'kills',           16,    'rare',      'swords'),
  ('damage_60k',   'Damage Dealer',         'Deal 60,000+ damage to champions',         'damage',          60000, 'common',    'flame'),
  ('kp_70',        'True MVP',              'Achieve 70%+ kill participation',          'kp_pct',          0.70,  'rare',      'crown'),
  ('vision_50',    'Eye of the Rift',       'Reach 50+ vision score',                   'vision',          50,    'common',    'eye'),
  ('gold_25k',     'Banker',                'Earn 25,000+ gold in a match',             'gold',            25000, 'common',    'coins'),
  ('kda_10',       'Untouchable',           'Finish with KDA of 10.0 or higher',        'kda',             10.0,  'rare',      'shield'),
  ('zero_deaths',  'No Tax',                'Win a match without dying',                'zero_deaths_win', 0,     'rare',      'sparkles'),
  ('assists_15',   'Best Sidekick',         'Rack up 15+ assists',                      'assists',         15,    'common',    'users'),
  ('quick_win',    'Speedrun',              'Win a match in under 20 minutes',          'quick_win',       1200,  'legendary', 'zap'),
  ('cs_300',       'Farmer Supreme',        'Reach 300+ CS in a single match',          'cs',              300,   'common',    'wheat')
ON CONFLICT (code) DO NOTHING;
