// src/server/routes/playerAdmin.ts
// Admin-only writes for the pro/streamer "talent" linking (accounts + socials).
// These run with the service role, gated by a server-side is_admin check, so the
// pro_players / pro_player_accounts / streamers / streamer_accounts writes go
// through ONE admin-checked path instead of the browser writing Supabase directly
// (a first step toward locking those tables — see the deferred RLS work).

import { supabaseAdmin } from "../supabase/client";

// Resolve the caller and confirm they're an admin (profile_players.is_admin).
async function adminUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: prof } = await supabaseAdmin
      .from("profile_players").select("is_admin").eq("profile_id", data.user.id).maybeSingle();
    return (prof as any)?.is_admin ? data.user.id : null;
  } catch {
    return null;
  }
}
const forbidden = () => Response.json({ error: "admin only" }, { status: 403 });
const bad = (m: string) => Response.json({ error: m }, { status: 400 });

const ACC_TABLE = { pro: "pro_player_accounts", streamer: "streamer_accounts" } as const;
const OWNER_COL = { pro: "pro_player_id", streamer: "streamer_id" } as const;
const TALENT_TABLE = { pro: "pro_players", streamer: "streamers" } as const;
type Type = "pro" | "streamer";
const okType = (t: any): t is Type => t === "pro" || t === "streamer";

// GET /api/admin/talent?type=pro&ownerId=...  → { accounts:[{id,username,region}], socials:{...} }
// Admin read for the linking UI (streamer_accounts isn't browser-readable).
export async function talentGetHandler(req: Request): Promise<Response> {
  if (!(await adminUserId(req))) return forbidden();
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const ownerId = url.searchParams.get("ownerId");
  if (!okType(type) || !ownerId) return bad("type, ownerId required");
  const { data: accounts } = await supabaseAdmin
    .from(ACC_TABLE[type]).select("id, username, region").eq(OWNER_COL[type], ownerId).order("created_at");
  const cols = type === "pro" ? "region, twitter_url, youtube_url, twitch_url" : "region, twitter_url, youtube_url";
  const { data: talent } = await supabaseAdmin.from(TALENT_TABLE[type]).select(cols).eq("id", ownerId).maybeSingle();
  return Response.json({ accounts: accounts ?? [], socials: talent ?? {} });
}

// POST /api/admin/talent/account/add  { type, ownerId, username, region }
export async function talentAccountAddHandler(req: Request): Promise<Response> {
  if (!(await adminUserId(req))) return forbidden();
  let b: any; try { b = await req.json(); } catch { return bad("invalid json"); }
  const { type, ownerId, username, region } = b ?? {};
  if (!okType(type) || !ownerId || !username) return bad("type, ownerId, username required");
  const { data, error } = await supabaseAdmin
    .from(ACC_TABLE[type])
    .insert({ [OWNER_COL[type]]: ownerId, username: String(username).trim(), region: region || null })
    .select("id, username, region")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ account: data });
}

// POST /api/admin/talent/account/remove  { type, accountId }
export async function talentAccountRemoveHandler(req: Request): Promise<Response> {
  if (!(await adminUserId(req))) return forbidden();
  let b: any; try { b = await req.json(); } catch { return bad("invalid json"); }
  const { type, accountId } = b ?? {};
  if (!okType(type) || !accountId) return bad("type, accountId required");
  const { error } = await supabaseAdmin.from(ACC_TABLE[type]).delete().eq("id", accountId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}

// POST /api/admin/talent/save  { type, ownerId, region?, twitter_url?, youtube_url?, twitch_url? }
// Updates the talent's primary region + social links. (Streamers have no
// twitch_url column — Twitch is derived from twitch_login — so it's ignored.)
export async function talentSaveHandler(req: Request): Promise<Response> {
  if (!(await adminUserId(req))) return forbidden();
  let b: any; try { b = await req.json(); } catch { return bad("invalid json"); }
  const { type, ownerId, region, twitter_url, youtube_url, twitch_url } = b ?? {};
  if (!okType(type) || !ownerId) return bad("type, ownerId required");
  const clean = (v: any) => { const s = typeof v === "string" ? v.trim() : ""; return s ? s : null; };
  const fields: Record<string, unknown> = {
    region: clean(region),
    twitter_url: clean(twitter_url),
    youtube_url: clean(youtube_url),
  };
  if (type === "pro") fields.twitch_url = clean(twitch_url);
  const { error } = await supabaseAdmin.from(TALENT_TABLE[type]).update(fields).eq("id", ownerId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
