import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRole = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE!

if (!supabaseUrl || !supabaseKey || !supabaseServiceRole) {
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in env or SUPABASE service role");
}

export const supabase = createClient(supabaseUrl, supabaseKey)

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRole);

// ── MATCH-DATA client → the self-hosted box ──────────────────────────────────
// In the hybrid setup, the heavy match tables (participants/matches/
// participant_item_events/season_*/tierlist_*/players + their RPCs) live on the
// self-hosted Postgres box; everything auth-coupled (auth, storage, profiles,
// scout, guides, streamers, pro_players, teams) stays on Supabase Cloud above.
//
// `MATCH_SUPABASE_URL` points at the box's PostgREST (e.g. http://localhost:8000
// when this server runs ON the box). If it's UNSET, these fall back to the Cloud
// URL — so the exact same build behaves identically on Railway/local (all Cloud)
// and only splits where we set the env var. Keys are reused, so they're the same.
const matchUrl = process.env.MATCH_SUPABASE_URL || supabaseUrl;

export const supabaseMatch = createClient(matchUrl, supabaseKey);

export const supabaseMatchAdmin = createClient(matchUrl, supabaseServiceRole);