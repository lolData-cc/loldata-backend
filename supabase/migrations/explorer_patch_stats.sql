-- explorer_patch_stats — precomputed per (champion, role, patch, tier) aggregate
-- powering the Explorer's PATCH VARIATION panel (subject-level, instant).
--
-- We store SUMS (not averages) so a read can aggregate across ANY subset of
-- roles/tiers and still compute correct winrate + per-game averages:
--   winrate   = 100 * sum(wins) / sum(games)
--   avg_kills = sum(sum_kills) / sum(games)   (etc.)
--
-- Live per-combo variation (which honours ally/item/rune constraints) does NOT
-- use this table — it runs the slow per-patch query on demand. This table only
-- backs the fast champion+role(+rank) trend.
--
-- Refresh: rebuildPatchStats() / POST /api/admin/rebuild-patch-stats does a
-- TRUNCATE + re-INSERT (one full GROUP-BY scan of participants ⋈ matches).

CREATE TABLE IF NOT EXISTS explorer_patch_stats (
  champion_name text   NOT NULL,
  role          text   NOT NULL,
  patch         text   NOT NULL,
  tier          text   NOT NULL,
  games         integer NOT NULL,
  wins          integer NOT NULL,
  sum_kills     bigint  NOT NULL,
  sum_deaths    bigint  NOT NULL,
  sum_assists   bigint  NOT NULL,
  sum_cs        bigint  NOT NULL,
  sum_gold      bigint  NOT NULL,
  PRIMARY KEY (champion_name, role, patch, tier)
);

-- the panel always filters by champion first, then groups by patch
CREATE INDEX IF NOT EXISTS idx_eps_champion ON explorer_patch_stats (champion_name);
