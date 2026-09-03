import { supabaseAdmin } from "../supabase/client";

const CLIENT_ID = process.env.RIOT_RSO_CLIENT_ID!;
const CLIENT_SECRET = process.env.RIOT_RSO_CLIENT_SECRET!;
const REDIRECT_URI = process.env.RIOT_RSO_REDIRECT_URI!;

const PLATFORM_TO_REGION: Record<string, string> = {
  EUW1: "euw", EUW: "euw",
  NA1: "na", NA: "na",
  KR: "kr",
  BR1: "br", LA1: "lan", LA2: "las",
  OC1: "oce", TR1: "tr", RU: "ru",
  JP1: "jp", PH2: "ph", SG2: "sg",
  TH2: "th", TW2: "tw", VN2: "vn",
};

/**
 * POST /api/auth/riot/url
 * Returns the Riot OAuth authorization URL.
 */
export async function riotAuthUrlHandler(req: Request): Promise<Response> {
  const url = new URL("https://auth.riotgames.com/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid offline_access cpid");
  // prompt=consent re-shows the authorization screen without forcing password re-entry

  return Response.json({ url: url.toString() });
}

/**
 * Exchanges Riot auth code for access token and fetches account info.
 */
async function exchangeRiotCode(code: string) {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const tokenRes = await fetch("https://auth.riotgames.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("Riot token exchange failed:", tokenRes.status, errText);
    throw new Error("Failed to exchange auth code");
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error("No access token received");

  // Get account info
  const accountRes = await fetch(
    "https://europe.api.riotgames.com/riot/account/v1/accounts/me",
    { headers: { "Authorization": `Bearer ${accessToken}` } }
  );
  if (!accountRes.ok) throw new Error("Failed to fetch Riot account");

  const account = await accountRes.json();
  const { puuid, gameName, tagLine } = account;
  if (!puuid || !gameName) throw new Error("Invalid account data");

  // Get region via cpid
  let region = "euw";
  try {
    const userinfoRes = await fetch("https://auth.riotgames.com/userinfo", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    if (userinfoRes.ok) {
      const userinfo = await userinfoRes.json();
      const cpid = userinfo.cpid || userinfo.sub_cpid;
      if (cpid && PLATFORM_TO_REGION[cpid.toUpperCase()]) {
        region = PLATFORM_TO_REGION[cpid.toUpperCase()];
      }
    }
  } catch {}

  return { puuid, gameName, tagLine, region };
}

/**
 * POST /api/auth/riot/callback
 * Body: { code: string, userId?: string, mode?: "link" | "login" }
 *
 * mode="link": Links Riot to existing Supabase user (requires userId)
 * mode="login": Creates or finds Supabase user, returns session tokens
 */
/**
 * Who is actually calling, proved by their own session.
 *
 * ⚠️ NEVER trust a user id from the request body. Link mode used to take
 * `userId` straight out of the JSON and write a Riot account onto that profile
 * with the service-role key and no check at all — so anyone holding a fresh
 * Riot authorisation code could bind their puuid onto somebody else's profile,
 * unauthenticated. The id has to come from a token the caller can only have by
 * being that person.
 */
async function callerId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

export async function riotAuthCallbackHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { code, mode: rawMode } = body;
    // The BODY no longer decides who you are, only what you are asking for.
    const caller = await callerId(req);
    const mode = rawMode === "link" || (!rawMode && caller) ? "link" : "login";

    if (!code) return new Response("Missing code", { status: 400 });

    // Exchange code for Riot account info
    const { puuid, gameName, tagLine, region } = await exchangeRiotCode(code);
    const nametag = `${gameName}#${tagLine}`;
    const riotEmail = `riot_${puuid.slice(0, 16)}@riot.loldata.cc`;

    if (mode === "link") {
      // ── LINK MODE: attach Riot to the CALLER'S OWN account ──
      // No session, no link. This is a privileged write onto a profile row, so
      // it is only ever performed for the person who proved they own it.
      if (!caller) {
        return Response.json({ error: "not-signed-in" }, { status: 401 });
      }
      const userId = caller;
      const { data: existing } = await supabaseAdmin
        .from("profile_players")
        .select("profile_id")
        .eq("profile_id", userId)
        .maybeSingle();

      if (existing) {
        await supabaseAdmin
          .from("profile_players")
          .update({ puuid, nametag, region })
          .eq("profile_id", userId);
      } else {
        await supabaseAdmin
          .from("profile_players")
          .insert({ profile_id: userId, player_id: userId, puuid, nametag, region });
      }

      console.log(`Riot RSO linked: ${nametag} (${region}) → user ${userId}`);
      return Response.json({ success: true, nametag, region, puuid, gameName, tagLine });
    }

    // ── LOGIN MODE: create or find Supabase user ──

    // Check if a user with this puuid already exists in profile_players
    const { data: existingProfile } = await supabaseAdmin
      .from("profile_players")
      .select("profile_id")
      .eq("puuid", puuid)
      .maybeSingle();

    let supabaseUserId: string;

    if (existingProfile) {
      // User already exists — sign them in
      supabaseUserId = existingProfile.profile_id;
    } else {
      // Check if a Supabase user with the riot email exists
      /**
       * ⚠️ PAGINATED. `listUsers()` returns only the FIRST page — fifty by
       * default — so past that many accounts this lookup silently stops finding
       * the synthetic riot_*@riot.loldata.cc user and mints a duplicate account
       * for a returning RSO player on every sign-in.
       */
      let existingUser: { id: string; email?: string } | undefined;
      for (let page = 1; page <= 40 && !existingUser; page++) {
        const { data: userList } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        const users = userList?.users ?? [];
        existingUser = users.find((u) => u.email === riotEmail);
        if (users.length < 1000) break;
      }

      if (existingUser) {
        supabaseUserId = existingUser.id;
      } else {
        // Create new Supabase user
        const randomPassword = crypto.randomUUID() + crypto.randomUUID();
        const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email: riotEmail,
          password: randomPassword,
          email_confirm: true,
          user_metadata: {
            riot_puuid: puuid,
            riot_nametag: nametag,
            riot_region: region,
          },
        });

        if (createErr || !newUser?.user) {
          console.error("Failed to create Supabase user:", createErr);
          return new Response("Failed to create account", { status: 500 });
        }

        supabaseUserId = newUser.user.id;

        // Create profile_players row
        await supabaseAdmin.from("profile_players").insert({
          profile_id: supabaseUserId,
          player_id: supabaseUserId,
          puuid,
          nametag,
          region,
        });
      }
    }

    // Get the actual email for this Supabase user
    let userEmail = riotEmail;
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(supabaseUserId);
      if (userData?.user?.email) {
        userEmail = userData.user.email;
      }
    } catch {}

    // Generate a magic link for the user's actual email
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: userEmail,
    });

    if (linkErr || !linkData) {
      console.error("Failed to generate magic link:", linkErr);
      return new Response("Failed to create session", { status: 500 });
    }

    // Extract the token from the magic link URL
    const magicUrl = new URL(linkData.properties.action_link);
    const token = magicUrl.searchParams.get("token") || magicUrl.hash;

    console.log(`Riot RSO login: ${nametag} (${region}) → user ${supabaseUserId}`);

    return Response.json({
      success: true,
      mode: "login",
      nametag,
      region,
      puuid,
      gameName,
      tagLine,
      // Return the magic link for frontend to verify
      verifyUrl: linkData.properties.action_link,
      email: riotEmail,
      hashed_token: linkData.properties.hashed_token,
    });

  } catch (err: any) {
    console.error("Riot auth callback error:", err?.message ?? err);
    return new Response(err?.message ?? "Internal server error", { status: 500 });
  }
}
