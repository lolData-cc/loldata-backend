import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceRole = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE!

if (!supabaseUrl || !supabaseKey || !supabaseServiceRole) {
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in env or SUPABASE service role");
}

export const supabase = createClient(supabaseUrl, supabaseKey)

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRole);