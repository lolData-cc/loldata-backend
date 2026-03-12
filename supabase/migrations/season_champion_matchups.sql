-- Season champion matchups: tracks per-player, per-champion opponent stats
CREATE TABLE IF NOT EXISTS season_champion_matchups (
  puuid         TEXT    NOT NULL,
  season_start  BIGINT  NOT NULL,
  queue_group   TEXT    NOT NULL,
  region        TEXT    NOT NULL,
  champion      TEXT    NOT NULL,
  opponent      TEXT    NOT NULL,
  games         INT     NOT NULL DEFAULT 0,
  wins          INT     NOT NULL DEFAULT 0,
  total_kills   INT     NOT NULL DEFAULT 0,
  total_deaths  INT     NOT NULL DEFAULT 0,
  total_assists INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (puuid, season_start, queue_group, champion, opponent)
);

CREATE INDEX IF NOT EXISTS idx_scm_lookup
  ON season_champion_matchups (puuid, season_start, queue_group);

-- Atomic upsert RPC (mirrors season_apply_champion_delta pattern)
CREATE OR REPLACE FUNCTION season_apply_matchup_delta(
  p_puuid         TEXT,
  p_season_start  BIGINT,
  p_queue_group   TEXT,
  p_region        TEXT,
  p_champion      TEXT,
  p_opponent      TEXT,
  p_games         INT,
  p_wins          INT,
  p_kills         INT,
  p_deaths        INT,
  p_assists       INT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO season_champion_matchups
    (puuid, season_start, queue_group, region, champion, opponent, games, wins, total_kills, total_deaths, total_assists)
  VALUES
    (p_puuid, p_season_start, p_queue_group, p_region, p_champion, p_opponent, p_games, p_wins, p_kills, p_deaths, p_assists)
  ON CONFLICT (puuid, season_start, queue_group, champion, opponent)
  DO UPDATE SET
    games         = season_champion_matchups.games         + EXCLUDED.games,
    wins          = season_champion_matchups.wins          + EXCLUDED.wins,
    total_kills   = season_champion_matchups.total_kills   + EXCLUDED.total_kills,
    total_deaths  = season_champion_matchups.total_deaths  + EXCLUDED.total_deaths,
    total_assists = season_champion_matchups.total_assists + EXCLUDED.total_assists;
END;
$$ LANGUAGE plpgsql;
