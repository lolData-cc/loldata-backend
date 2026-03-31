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

  return Response.json({ url: url.toString() });
}

/**
 * POST /api/auth/riot/callback
 * Body: { code: string, userId: string }
 * Exchanges the auth code for tokens, fetches account info, updates profile.
 */
export async function riotAuthCallbackHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { code, userId } = body;

    if (!code || !userId) {
      return new Response("Missing code or userId", { status: 400 });
    }

    // Step 1: Exchange auth code for access token
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
      return new Response("Failed to exchange auth code", { status: 502 });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error("No access_token in response:", tokenData);
      return new Response("No access token received", { status: 502 });
    }

    // Step 2: Get account info (puuid, gameName, tagLine)
    const accountRes = await fetch(
      "https://europe.api.riotgames.com/riot/account/v1/accounts/me",
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (!accountRes.ok) {
      const errText = await accountRes.text();
      console.error("Riot account fetch failed:", accountRes.status, errText);
      return new Response("Failed to fetch Riot account", { status: 502 });
    }

    const account = await accountRes.json();
    const { puuid, gameName, tagLine } = account;

    if (!puuid || !gameName) {
      return new Response("Invalid account data from Riot", { status: 502 });
    }

    // Step 3: Get platform/region via userinfo (cpid scope)
    let region = "euw"; // default fallback
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
    } catch (e) {
      console.warn("Failed to get cpid, defaulting to EUW:", e);
    }

    const nametag = `${gameName}#${tagLine}`;

    // Step 4: Update profile_players table
    const { data: existing } = await supabaseAdmin
      .from("profile_players")
      .select("profile_id")
      .eq("profile_id", userId)
      .maybeSingle();

    if (existing) {
      const { error } = await supabaseAdmin
        .from("profile_players")
        .update({ puuid, nametag, region })
        .eq("profile_id", userId);

      if (error) {
        console.error("Failed to update profile_players:", error);
        return new Response("Failed to update profile", { status: 500 });
      }
    } else {
      const { error } = await supabaseAdmin
        .from("profile_players")
        .insert({ profile_id: userId, player_id: userId, puuid, nametag, region });

      if (error) {
        console.error("Failed to insert profile_players:", error);
        return new Response("Failed to create profile", { status: 500 });
      }
    }

    console.log(`Riot RSO linked: ${nametag} (${region}) → user ${userId}`);

    return Response.json({
      success: true,
      nametag,
      region,
      puuid,
      gameName,
      tagLine,
    });

  } catch (err) {
    console.error("Riot auth callback error:", err);
    return new Response("Internal server error", { status: 500 });
  }
}
