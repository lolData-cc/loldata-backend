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

-- Keep the planner honest about how selective jungle_path IS NOT NULL is.
-- Without it the estimate is bad, participants_jungle_path_idx is ignored
-- and this seq-scans 134M rows: 46s instead of 150ms.
ANALYZE participants (jungle_path);
-- Reconstructs the clear from 60s position samples.
--
-- A jungle half is a FOUR-link chain with a dead-end SPUR hanging off each buff:
--
--     [Blue|Gromp] - Wolves - Raptors - [Red|Krugs]
--
-- Gromp and Krugs are not links. Each sits in a corner reachable only through
-- its buff, so buff+spur are one stop the jungler takes in either order before
-- carrying on down the chain. Both were modelled as links at first - Gromp
-- before Blue, Krugs after Red - and both produced the same two failures:
--
--   * "Blue then Gromp then Wolves" and "Red then Krugs then Raptors" - the
--     standard topside and botside openings - read as the jungler doubling
--     back, so rule 2 cut the clear off and left a two-camp stub.
--   * Sitting at the ENDS of the chain, neither could ever be filled: fill only
--     works between two observed camps, and nothing is ever beyond an end. They
--     appeared only when a 60s sample happened to land on them.
--
-- Measured over 300k jungler games, moving both onto spurs and applying rule 4
-- costs nothing and recovers a great deal: not one game loses a camp, 104k gain
-- one, and complete six-camp clears go from 63k to 141k.
--
-- Four rules, all needed:
--
--  1. FILL. Consecutive samples in the same half get the camps between them on
--     the chain inserted - a jungler seen at Red then Wolves walked past
--     Raptors, the sampler just missed them there.
--
--  2. STOP AT THE FIRST REVERSAL. A clear runs one way along the chain. When
--     the direction flips (or the player crosses to the other half) the clear
--     is over and what follows is a gank, a recall or a counter-jungle. Without
--     this, filling AMPLIFIES noise: {Red,Wolves,Krugs,Gromp} expanded to
--     eleven camps of back-and-forth that no one ever played. Stepping between
--     a buff and its spur is NOT a reversal - same link - so it never ends it.
--
--  3. TOUCHING A SPUR IMPLIES ITS BUFF. Each spur has one entrance. Whether the
--     run arrives at Gromp/Krugs or leaves it, the buff is on the way, so it
--     belongs in the route even when no sample landed on it.
--
--  4. A BUFF IMPLIES ITS SPUR. Gromp and Krugs die on every clear that reaches
--     their end of the jungle, but each is a ~20 second camp against a 60
--     second sampler, so both are missed constantly. Two measurements say the
--     miss is OURS, not the player's. The chance of observing one climbs
--     monotonically with sampling coverage - Gromp 2.6% of games where a single
--     camp was seen, 42% at four, 74% at five, 100% at six; Krugs 4.0 / 61.9 /
--     84.4 / 100 - and a camp players genuinely skipped would plateau below
--     100% instead. And where both a buff and its spur were observed, the spur
--     lands immediately after the buff in 97.5% of routes for Gromp and 99.2%
--     for Krugs, and in NO route anywhere else. So a route holding a buff but
--     not its spur gets the spur inserted directly after it: that reproduces
--     the exact shape seen whenever the sampler gets lucky, rather than
--     inventing one. Routes of a single camp are left alone - a lone sample is
--     a start, not a path.
CREATE OR REPLACE FUNCTION jungle_fill_route(p int[]) RETURNS int[] AS $fn$
DECLARE
  pos      int[] := ARRAY[1,1,2,3,4,4];                     -- camp (within half) -> chain link
  camp_at  int[] := ARRAY[1,3,4,5];                         -- link -> camp; never a spur, which
                                                            -- is placed by rules 3/4, never filled
  buff_for int[] := ARRAY[NULL,1,NULL,NULL,NULL,5]::int[];  -- spur -> the buff it hangs off
  buffs    int[] := ARRAY[1,5];
  spurs    int[] := ARRAY[2,6];
  res int[];
  dir int := 0;                          -- 0 = not yet established
  i int; a int; b int; ha int; hb int; ca int; cb int; pa int; pb int;
  step int; k int; bf int; h int; bu int; sp int; at_buff int;
BEGIN
  IF p IS NULL OR array_length(p,1) IS NULL THEN RETURN NULL; END IF;
  res := ARRAY[p[1]];
  FOR i IN 2..array_length(p,1) LOOP
    a := p[i-1]; b := p[i];
    ha := CASE WHEN a <= 6 THEN 0 ELSE 6 END;
    hb := CASE WHEN b <= 6 THEN 0 ELSE 6 END;
    EXIT WHEN ha <> hb;                  -- crossed halves: the clear ended
    ca := a - ha; cb := b - hb;
    pa := pos[ca]; pb := pos[cb];
    IF pa = pb THEN                      -- buff <-> spur side step (rule 2)
      IF NOT (b = ANY(res)) THEN res := res || b; END IF;
      CONTINUE;                          -- dir untouched: a spur has no direction
    END IF;
    step := CASE WHEN pb > pa THEN 1 ELSE -1 END;
    EXIT WHEN dir <> 0 AND step <> dir;  -- doubled back: the clear ended
    dir := step;
    bf := buff_for[ca];                  -- rule 3, leaving a spur
    IF bf IS NOT NULL AND NOT ((bf + ha) = ANY(res)) THEN res := res || (bf + ha); END IF;
    k := pa + step;
    WHILE k <> pb LOOP                   -- rule 1
      res := res || (camp_at[k] + ha);
      k := k + step;
    END LOOP;
    bf := buff_for[cb];                  -- rule 3, arriving at one
    IF bf IS NOT NULL AND NOT ((bf + hb) = ANY(res)) THEN res := res || (bf + hb); END IF;
    res := res || b;
  END LOOP;

  IF array_length(res,1) >= 2 THEN       -- rule 4
    h := CASE WHEN res[1] <= 6 THEN 0 ELSE 6 END;
    FOR i IN 1..2 LOOP
      bu := buffs[i] + h; sp := spurs[i] + h;
      IF (bu = ANY(res)) AND NOT (sp = ANY(res)) THEN
        at_buff := array_position(res, bu);
        res := res[1:at_buff] || sp || res[at_buff+1:array_length(res,1)];
      END IF;
    END LOOP;
  END IF;
  RETURN res;
END;
$fn$ LANGUAGE plpgsql IMMUTABLE;

-- Diagnosis only - nothing in the pipeline reads this. Route arrays are opaque
-- ({1,3,4,5,6}), which makes eyeballing a regression in the reconstruction far
-- harder than it needs to be; this renders one as names, with '*' marking the
-- enemy half.
CREATE OR REPLACE FUNCTION jungle_route_label(r int[]) RETURNS text AS $lb$
  SELECT string_agg(CASE ((c - 1) % 6) + 1
           WHEN 1 THEN 'Blue' WHEN 2 THEN 'Gromp'   WHEN 3 THEN 'Wolves'
           WHEN 4 THEN 'Raptors' WHEN 5 THEN 'Red'  WHEN 6 THEN 'Krugs' END
         || CASE WHEN c > 6 THEN '*' ELSE '' END, ' > ' ORDER BY o)
  FROM unnest(r) WITH ORDINALITY AS t(c, o);
$lb$ LANGUAGE sql IMMUTABLE;

-- ── jungle pathing ─────────────────────────────────────────────────────────
-- Groups participants.jungle_path into the routes actually played, per champion.
--
-- Three normalisations, each fixing something that made the grouping lie:
--
--  1. Sides folded to OWN/ENEMY via team_id. Stored codes are absolute (1-6
--     blue half, 7-12 red half) but a champion plays half its games per team,
--     so raw grouping puts "clearing my own jungle" and "invading theirs" in
--     one bucket. Folding also merges mirrored games, doubling the sample.
--  2. Zeros dropped: a zero is "in transit at the minute mark", not a camp.
--  3. CONSECUTIVE repeats collapsed. Still on raptors at minute 1 and 2 is ONE
--     visit; without this a route read "Raptors -> Raptors" and burned two of
--     its six slots on one camp.
--
-- gid must be assigned BEFORE unnest, or every camp becomes its own "game".
DROP TABLE IF EXISTS cbs_jungle_path_new;
CREATE TABLE cbs_jungle_path_new AS
WITH src AS (
  SELECT row_number() OVER () AS gid,
         champion_name, team_id, win,
         array_remove(jungle_path, 0) AS raw,
         first_back_s, first_back_items
  FROM participants
  WHERE jungle_path IS NOT NULL
    AND array_length(jungle_path, 1) >= 3
    AND jungle_path[1] <> 0
),
folded AS (
  SELECT s.gid, s.champion_name, s.win, u.ord,
         CASE WHEN s.team_id = 100 THEN u.c
              WHEN u.c <= 6        THEN u.c + 6
              ELSE u.c - 6 END AS camp
  FROM src s, unnest(s.raw) WITH ORDINALITY AS u(c, ord)
),
dedup AS (
  SELECT gid, champion_name, win, ord, camp
  FROM (SELECT f.*, lag(camp) OVER (PARTITION BY gid ORDER BY ord) AS prev FROM folded f) t
  WHERE prev IS NULL OR prev <> camp
),
norm AS (
  -- jungle_fill_route() walks the chain between observed camps and stops at the
  -- first reversal, turning sparse 60s samples into the clear that was actually
  -- played. See its definition for why all four of its rules are required.
  SELECT gid, champion_name, win,
         (jungle_fill_route(array_agg(camp ORDER BY ord)))[1:6] AS route
  FROM dedup GROUP BY gid, champion_name, win
),
-- ── the reset that ends the opening ────────────────────────────────────────
-- Some junglers deliberately stop the clear short, reset, and buy a component.
-- That decision is invisible in the final build - the component is sold or
-- built away long before the game ends - so it comes from participants
-- .first_back_* , captured in the ingest off the same timeline.
--
-- Bounded to 60-420s: before that nobody is at the shop, after it this is an
-- ordinary mid-game recall rather than a planned opening.
backs AS (
  SELECT n.gid, n.champion_name, n.route, s.first_back_s, s.first_back_items
  FROM norm n JOIN src s USING (gid)
  WHERE array_length(n.route, 1) >= 2
    AND s.first_back_s IS NOT NULL
    AND s.first_back_items IS NOT NULL
),
back_agg AS (
  -- No "what share of players reset" column: every jungler resets, so measured
  -- honestly it is ~100% on every route and says nothing. What carries the
  -- information is WHEN the reset lands (a short clear resets early) and WHAT
  -- was bought — the route above already states how many camps were taken.
  --
  -- back_sample is the number of games behind the annotation. first_back_* only
  -- exists from 2026-08-22 onward (no backfill: timelines are not stored), so it
  -- lags `games` by orders of magnitude and a reader must gate on it rather than
  -- on the route's game count.
  SELECT champion_name, route,
         count(*) FILTER (WHERE first_back_s BETWEEN 60 AND 420)::int AS back_sample,
         count(*) FILTER (WHERE first_back_s BETWEEN 60 AND 420)::int AS back_games,
         (percentile_disc(0.5) WITHIN GROUP (ORDER BY first_back_s)
            FILTER (WHERE first_back_s BETWEEN 60 AND 420))::smallint AS back_s
  FROM backs GROUP BY champion_name, route
),
back_items AS (
  SELECT b.champion_name, b.route, it AS item,
         count(DISTINCT b.gid)::int AS c,
         row_number() OVER (PARTITION BY b.champion_name, b.route
                            ORDER BY count(DISTINCT b.gid) DESC, it) AS irn
  FROM backs b, unnest(b.first_back_items) AS it
  -- DISTINCT gid, not occurrences: two Long Swords in one visit is one player
  -- making one choice, and counting the clicks pushed shares past 100%.
  WHERE b.first_back_s BETWEEN 60 AND 420
    AND it NOT IN (2003,2010,2031,2033,2052,2055,2138,2139,2140,
                   3340,3363,3364,1101,1102,1103)
  GROUP BY b.champion_name, b.route, it
),
back_top AS (
  SELECT bi.champion_name, bi.route,
         array_agg(bi.item ORDER BY bi.irn)                                      AS back_items,
         array_agg(round(bi.c * 100.0 / ba.back_games, 1)::real ORDER BY bi.irn) AS back_item_pct
  FROM back_items bi JOIN back_agg ba USING (champion_name, route)
  WHERE bi.irn <= 3 AND ba.back_games > 0
  GROUP BY bi.champion_name, bi.route
),
agg AS (
  SELECT champion_name, route, count(*)::int AS games, sum((win)::int)::int AS wins
  FROM norm
  WHERE array_length(route, 1) >= 2   -- a single camp is a start, not a path
  GROUP BY champion_name, route
),
ranked AS (
  SELECT champion_name, route, games, wins,
         round(wins::numeric * 100 / games, 2)::float8 AS winrate,
         row_number() OVER (PARTITION BY champion_name ORDER BY games DESC, wins DESC) AS rn,
         sum(games) OVER (PARTITION BY champion_name)::int AS champ_games
  FROM agg
  WHERE games >= 3
)
SELECT r.champion_name, r.route, r.games, r.wins, r.winrate, r.rn::int AS rn, r.champ_games,
       COALESCE(ba.back_sample, 0)::int AS back_sample,
       ba.back_s,
       bt.back_items,
       bt.back_item_pct
FROM ranked r
LEFT JOIN back_agg ba USING (champion_name, route)
LEFT JOIN back_top bt USING (champion_name, route)
WHERE r.rn <= 6;
ALTER TABLE cbs_jungle_path_new ADD PRIMARY KEY (champion_name, rn);

DROP TABLE IF EXISTS cbs_jungle_path_old;
ALTER TABLE IF EXISTS cbs_jungle_path RENAME TO cbs_jungle_path_old;
ALTER TABLE cbs_jungle_path_new RENAME TO cbs_jungle_path;
DROP TABLE IF EXISTS cbs_jungle_path_old;
