-- refresh-cbs.sql — rebuild the champion build-stats summary tables from the
-- live participants table, then atomically swap them in (readers never see a
-- missing table). Run nightly by scripts/refresh-cbs.sh, followed by warmBuild.ts
-- (which repopulates cbs_build_live). All aggregations are single-table so the
-- parallel workers stay within the supabase-db container's 64MB /dev/shm.
SET max_parallel_workers_per_gather = 2;
SET work_mem = '96MB';
SET statement_timeout = 0;

-- ── champion stats + laning @10 ──
DROP TABLE IF EXISTS cbs_champion_stats_new;
CREATE TABLE cbs_champion_stats_new AS
SELECT champion_name, role,
  count(*)::int AS games,
  round(avg((win)::int)*100,2)::float8 AS winrate,
  avg(kills)::float8 AS kills, avg(deaths)::float8 AS deaths, avg(assists)::float8 AS assists,
  avg(kill_participation)::float8 AS kp, avg(damage_share)::float8 AS dmg_share,
  avg(total_damage_to_champions)::float8 AS dmg, avg(gold_earned)::float8 AS gold,
  avg(total_cs)::float8 AS cs, avg(total_cs::float8/nullif(time_played,0)*60)::float8 AS cspm,
  avg(vision_score)::float8 AS vision, avg(solo_kills)::float8 AS solo_kills, avg(champ_level)::float8 AS champ_level,
  count(gold_at_10)::int AS ln_n,
  avg(gold_at_10)::float8 AS ln_gold, avg(cs_at_10)::float8 AS ln_cs, avg(xp_at_10)::float8 AS ln_xp,
  avg(kills_at_10)::float8 AS ln_k, avg(deaths_at_10)::float8 AS ln_d, avg(assists_at_10)::float8 AS ln_a, avg(damage_at_10)::float8 AS ln_dmg
FROM participants
WHERE champion_name IS NOT NULL AND role IS NOT NULL
GROUP BY champion_name, role;
ALTER TABLE cbs_champion_stats_new ADD PRIMARY KEY (champion_name, role);

-- ── role baseline: games-weighted means from the champion summary ──
DROP TABLE IF EXISTS cbs_baseline_new;
CREATE TABLE cbs_baseline_new AS
SELECT role, sum(games)::int AS games,
  sum(winrate*games)/nullif(sum(games),0) AS winrate,
  sum(kills*games)/nullif(sum(games),0) AS kills, sum(deaths*games)/nullif(sum(games),0) AS deaths,
  sum(assists*games)/nullif(sum(games),0) AS assists, sum(kp*games)/nullif(sum(games),0) AS kp,
  sum(dmg_share*games)/nullif(sum(games),0) AS dmg_share, sum(dmg*games)/nullif(sum(games),0) AS dmg,
  sum(gold*games)/nullif(sum(games),0) AS gold, sum(cs*games)/nullif(sum(games),0) AS cs,
  sum(cspm*games)/nullif(sum(games),0) AS cspm, sum(vision*games)/nullif(sum(games),0) AS vision,
  sum(solo_kills*games)/nullif(sum(games),0) AS solo_kills, sum(champ_level*games)/nullif(sum(games),0) AS champ_level
FROM cbs_champion_stats_new GROUP BY role;
ALTER TABLE cbs_baseline_new ADD PRIMARY KEY (role);

-- ── win rate by game length (5-min buckets from time_played) ──
DROP TABLE IF EXISTS cbs_gamelength_new;
CREATE TABLE cbs_gamelength_new AS
SELECT champion_name, role,
  width_bucket(time_played, ARRAY[900,1200,1500,1800,2100,2400]) AS bucket,
  count(*)::int AS games, round(avg((win)::int)*100,2)::float8 AS winrate
FROM participants
WHERE champion_name IS NOT NULL AND role IS NOT NULL AND time_played >= 900
GROUP BY champion_name, role, bucket;
ALTER TABLE cbs_gamelength_new ADD PRIMARY KEY (champion_name, role, bucket);

-- ── most-common ability at each level (skill order) ──
DROP TABLE IF EXISTS cbs_skillorder_new;
CREATE TABLE cbs_skillorder_new AS
SELECT p.champion_name, p.role, u.idx,
  mode() WITHIN GROUP (ORDER BY u.slot)::int AS slot, count(*)::int AS n
FROM participants p, unnest(p.skill_order) WITH ORDINALITY AS u(slot, idx)
WHERE p.champion_name IS NOT NULL AND p.role IS NOT NULL AND p.skill_order IS NOT NULL
GROUP BY p.champion_name, p.role, u.idx;
ALTER TABLE cbs_skillorder_new ADD PRIMARY KEY (champion_name, role, idx);

-- ── atomic swap (fast catalog rename; readers block for ms, not the rebuild) ──
BEGIN;
DROP TABLE IF EXISTS cbs_champion_stats; ALTER TABLE cbs_champion_stats_new RENAME TO cbs_champion_stats;
DROP TABLE IF EXISTS cbs_baseline;       ALTER TABLE cbs_baseline_new       RENAME TO cbs_baseline;
DROP TABLE IF EXISTS cbs_gamelength;     ALTER TABLE cbs_gamelength_new     RENAME TO cbs_gamelength;
DROP TABLE IF EXISTS cbs_skillorder;     ALTER TABLE cbs_skillorder_new     RENAME TO cbs_skillorder;
COMMIT;
