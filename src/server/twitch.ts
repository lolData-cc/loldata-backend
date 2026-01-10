import { supabaseAdmin } from "../server/supabase/client";

let appToken: { token: string; exp: number } | null = null;

async function getAppToken() {
    const now = Math.floor(Date.now() / 1000);
    if (appToken && appToken.exp - 60 > now) return appToken.token;

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID!,
        client_secret: process.env.TWITCH_CLIENT_SECRET!,
        grant_type: "client_credentials",
    });

    const res = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        body: params,
    });
    if (!res.ok) throw new Error(`Twitch token error ${res.status}`);
    const data = await res.json();
    appToken = { token: data.access_token, exp: now + data.expires_in };
    return appToken.token;
}

type HelixStream = {
    user_login: string;
    title: string;
    game_name: string;
    viewer_count: number;
    thumbnail_url: string; // {width}x{height}
    started_at: string;
};

type HelixUser = {
    id: string;
    login: string;
    display_name: string;
    profile_image_url: string;
};

function replaceThumbSize(t: string, w = 640, h = 360) {
    return t.replace("{width}", String(w)).replace("{height}", String(h));
}

async function fetchStreamsByLogins(logins: string[]): Promise<HelixStream[]> {
    if (logins.length === 0) return [];
    const token = await getAppToken();
    const url = new URL("https://api.twitch.tv/helix/streams");
    for (const l of logins) url.searchParams.append("user_login", l);

    const res = await fetch(url.toString(), {
        headers: {
            "Client-ID": process.env.TWITCH_CLIENT_ID!,
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.status === 401) {
        appToken = null;
        return fetchStreamsByLogins(logins);
    }
    if (!res.ok) throw new Error(`Helix error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return (data?.data ?? []) as HelixStream[];
}

async function fetchUsersByLogins(logins: string[]): Promise<HelixUser[]> {
    if (logins.length === 0) return [];
    const token = await getAppToken();
    const url = new URL("https://api.twitch.tv/helix/users");
    for (const l of logins) url.searchParams.append("login", l);

    const res = await fetch(url.toString(), {
        headers: {
            "Client-ID": process.env.TWITCH_CLIENT_ID!,
            Authorization: `Bearer ${token}`,
        },
    });

    if (res.status === 401) {
        appToken = null;
        return fetchUsersByLogins(logins);
    }
    if (!res.ok)
        throw new Error(`Helix users error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return (data?.data ?? []) as HelixUser[];
}

export async function refreshStreamersLive() {
    const { data: streamers, error } = await supabaseAdmin
        .from("streamers")
        .select("id, twitch_login, lol_nametag, region, profile_image_url");
    if (error) throw error;

    const records = (streamers ?? []).map((s) => ({
        id: s.id,
        twitch_login: s.twitch_login?.trim().toLowerCase() ?? "",
        lol_nametag: s.lol_nametag ?? null,
        region: s.region?.trim().toUpperCase() ?? null,
        profile_image_url: s.profile_image_url ?? null,
    }));

    const logins = records.map((r) => r.twitch_login).filter(Boolean);

    // streams
    const liveMap = new Map<string, HelixStream>();
    const batchSize = 100;
    for (let i = 0; i < logins.length; i += batchSize) {
        const batch = logins.slice(i, i + batchSize);
        const streams = await fetchStreamsByLogins(batch);
        for (const s of streams) liveMap.set(s.user_login.toLowerCase(), s);
    }

    // users (avatars)
    const users = await fetchUsersByLogins(logins);
    const userMap = new Map(users.map((u) => [u.login.toLowerCase(), u]));

    // updates
    const updates = records
        .filter((r) => !!r.twitch_login)
        .map((r) => {
            const live = liveMap.get(r.twitch_login);
            const user = userMap.get(r.twitch_login);

            if (live) {
                return {
                    id: r.id,
                    twitch_login: r.twitch_login,
                    lol_nametag: r.lol_nametag,
                    region: r.region,                          // 👈 pass-through
                    is_live: true,
                    title: live.title,
                    game_name: live.game_name,
                    viewer_count: live.viewer_count,
                    thumbnail_url: replaceThumbSize(live.thumbnail_url),
                    profile_image_url: user?.profile_image_url ?? r.profile_image_url ?? null,
                    last_live_at: live.started_at,
                    updated_at: new Date().toISOString(),
                };
            }
            return {
                id: r.id,
                twitch_login: r.twitch_login,
                lol_nametag: r.lol_nametag,
                region: r.region,                            // 👈 pass-through
                is_live: false,
                viewer_count: null,
                thumbnail_url: null,
                profile_image_url: r.profile_image_url,      // mantieni l’ultimo noto
                updated_at: new Date().toISOString(),
            };
        });

    const { error: upErr } = await supabaseAdmin
        .from("streamers")
        .upsert(updates, { onConflict: "id" });
    if (upErr) throw upErr;

    return updates.filter((u) => u.is_live);
}

export async function getLiveStreamersHandler(_req: Request): Promise<Response> {
    try {
        for (const k of [
            "NEXT_PUBLIC_SUPABASE_URL",
            "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE",
            "TWITCH_CLIENT_ID",
            "TWITCH_CLIENT_SECRET",
        ]) {
            if (!process.env[k]) throw new Error(`Missing env ${k}`);
        }

        const liveAll = await refreshStreamersLive();

        // 🔥 tieni solo League of Legends
        const live = liveAll.filter(
            (s) => s.game_name === "League of Legends"
        );

        live.sort((a, b) => (b.viewer_count ?? 0) - (a.viewer_count ?? 0));

        return new Response(JSON.stringify({ live }), {
            headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
            },
        });
    } catch (e: any) {
        console.error("getLiveStreamersHandler error:", e);
        const body =
            process.env.NODE_ENV === "production"
                ? "Errore live"
                : `Errore live: ${e?.message}\n${e?.stack ?? ""}`;
        return new Response(body, { status: 500 });
    }
}
