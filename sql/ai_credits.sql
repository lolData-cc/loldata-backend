-- AI credits ledger.
-- Run this in the Supabase SQL editor (Cloud) — that's where `profile_players` lives.
--
-- 1 credit = 1 POST /api/ai/chat request. Free refills daily, paid plans every
-- 30 days, via a lazy server-side refill (no cron). Logic: src/server/ai/credits.ts.

alter table public.profile_players
  add column if not exists ai_credits          int         not null default 3,
  add column if not exists ai_credits_reset_at timestamptz not null default now();

-- Existing rows get ai_credits_reset_at = now() from the DEFAULT above, so the
-- backend refills each user to their plan's allotment (free 3 / premium 150 /
-- elite 750) on their next request. Nothing else to backfill.
