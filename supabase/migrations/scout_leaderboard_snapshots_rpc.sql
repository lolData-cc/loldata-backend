-- supabase/migrations/scout_leaderboard_snapshots_rpc.sql
--
-- One-shot replacement for the leaderboard's per-account snapshot fan-out.
-- The handler used to issue TWO queries PER account (newest overall +
-- oldest-in-window) — 2N round-trips that hammered the connection pool for
-- big lobbies. This function returns both, for ALL accounts, in a single
-- call using DISTINCT ON, so the leaderboard read drops to one round-trip.
--
-- Returns ≤ 2 rows per puuid: kind = 'newest' (current rank / window end)
-- and kind = 'oldest' (the in-window baseline). p_since NULL = all-time.

create or replace function public.scout_leaderboard_snapshots(
  p_puuids text[],
  p_since  timestamptz default null
)
returns table (
  puuid         text,
  kind          text,
  tier          text,
  rank_division text,
  lp            integer,
  wins          integer,
  losses        integer,
  taken_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Newest solo-queue snapshot per account (current rank + window end).
  (
    select distinct on (s.puuid)
      s.puuid, 'newest'::text, s.tier, s.rank_division,
      s.lp, s.wins, s.losses, s.taken_at
    from scout_rank_snapshots s
    where s.puuid = any(p_puuids)
      and s.queue_type = 'RANKED_SOLO_5x5'
    order by s.puuid, s.taken_at desc
  )
  union all
  -- Oldest solo-queue snapshot in the window per account (the baseline).
  (
    select distinct on (s.puuid)
      s.puuid, 'oldest'::text, s.tier, s.rank_division,
      s.lp, s.wins, s.losses, s.taken_at
    from scout_rank_snapshots s
    where s.puuid = any(p_puuids)
      and s.queue_type = 'RANKED_SOLO_5x5'
      and (p_since is null or s.taken_at >= p_since)
    order by s.puuid, s.taken_at asc
  );
$$;

-- The backend calls this with the service-role key (bypasses RLS), but
-- grant execute defensively in case the anon/auth roles ever need it.
grant execute on function public.scout_leaderboard_snapshots(text[], timestamptz)
  to anon, authenticated, service_role;
