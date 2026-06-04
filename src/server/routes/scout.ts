// src/server/routes/scout.ts
// Scout / Feed lobbies — shareable groups of up to 20 players (each with
// up to 3 Riot accounts). Public read by slug, owner-key gated writes.

import { supabaseAdmin } from "../supabase/client";
import { ingestQuickThenBackground } from "../services/matchIngest";
import { writeRankSnapshot, ladderScore } from "../services/rankSnapshot";
import {
  getAccountByPuuid,
  getMatchDetails,
  getMatchIdsByPuuidOpts,
} from "../riot";
import { getCurrentSeasonWindow } from "../season";

// ─── constants ─────────────────────────────────────────────────────────
const MAX_PLAYERS_PER_LOBBY = 20;
const MAX_ACCOUNTS_PER_PLAYER = 3;
const SLUG_LENGTH = 7;
const OWNER_KEY_LENGTH = 32;
const SLUG_ALPHABET =
  "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I/l for legibility
const OWNER_KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ─── helpers ────────────────────────────────────────────────────────────
function randomId(alphabet: string, length: number): string {
  // crypto.getRandomValues is available globally in Bun
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function generateUniqueSlug(): Promise<string> {
  // Probability of 7-char collision in our alphabet is negligible, but loop
  // up to a few times just in case.
  for (let attempt = 0; attempt < 8; attempt++) {
    const slug = randomId(SLUG_ALPHABET, SLUG_LENGTH);
    const { data, error } = await supabaseAdmin
      .from("scout_lobbies")
      .select("slug")
      .eq("slug", slug)
      .maybeSingle();

    // Real DB error (e.g. table missing) — surface it instead of looping.
    if (error) {
      const msg = (error as any).message ?? String(error);
      const code = (error as any).code;
      if (code === "42P01" || /relation .* does not exist/i.test(msg)) {
        throw new Error(
          "scout_lobbies table is missing — run the migration at " +
            "supabase/migrations/scout_lobbies.sql"
        );
      }
      throw new Error(`Slug uniqueness check failed: ${msg}`);
    }

    if (!data) return slug; // free slug — take it
  }
  throw new Error("Could not generate unique slug after 8 attempts");
}

async function getAuthUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

// ─── shapes ─────────────────────────────────────────────────────────────
type AccountInput = {
  puuid: string;
  region: string;
  riotName: string;
  riotTag: string;
};

type PlayerInput = {
  displayName: string;
  color?: string | null;
  accounts: AccountInput[];
};

type CreateLobbyBody = {
  name: string;
  isPublic?: boolean;
  password?: string | null;
  players: PlayerInput[];
};

// ─── POST /api/scout/lobby ──────────────────────────────────────────────
// Auth: requires logged-in supabase user (sent as Bearer token).
export async function createScoutLobbyHandler(req: Request): Promise<Response> {
  const userId = await getAuthUserId(req);
  if (!userId) {
    return Response.json(
      { error: "Login required to create a lobby" },
      { status: 401 }
    );
  }

  let body: CreateLobbyBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validation
  const name = (body.name ?? "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (name.length > 80) return Response.json({ error: "name too long" }, { status: 400 });

  const players = Array.isArray(body.players) ? body.players : [];
  if (players.length === 0) {
    return Response.json({ error: "At least one player is required" }, { status: 400 });
  }
  if (players.length > MAX_PLAYERS_PER_LOBBY) {
    return Response.json(
      { error: `Max ${MAX_PLAYERS_PER_LOBBY} players per lobby` },
      { status: 400 }
    );
  }

  for (const p of players) {
    const dn = (p.displayName ?? "").trim();
    if (!dn) return Response.json({ error: "Player displayName required" }, { status: 400 });
    if (dn.length > 40) return Response.json({ error: "Player displayName too long" }, { status: 400 });

    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    if (accounts.length === 0) {
      return Response.json({ error: `Player "${dn}" has no accounts` }, { status: 400 });
    }
    if (accounts.length > MAX_ACCOUNTS_PER_PLAYER) {
      return Response.json(
        { error: `Max ${MAX_ACCOUNTS_PER_PLAYER} accounts per player` },
        { status: 400 }
      );
    }
    for (const a of accounts) {
      if (!a.puuid || !a.region || !a.riotName || !a.riotTag) {
        return Response.json(
          { error: `Account is missing required fields` },
          { status: 400 }
        );
      }
    }
  }

  let slug: string;
  try {
    slug = await generateUniqueSlug();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("generateUniqueSlug:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
  const ownerKey = randomId(OWNER_KEY_ALPHABET, OWNER_KEY_LENGTH);

  // Insert lobby row
  const { error: lobbyErr } = await supabaseAdmin.from("scout_lobbies").insert({
    slug,
    name,
    owner_key: ownerKey,
    owner_user_id: userId,
    is_public: body.isPublic !== false,
    password_hash: null, // TODO: add bcrypt if body.password set (phase 5)
  });

  if (lobbyErr) {
    console.error("scout_lobbies insert error:", lobbyErr);
    return Response.json({ error: "Failed to create lobby" }, { status: 500 });
  }

  // Insert players + accounts
  for (let pIdx = 0; pIdx < players.length; pIdx++) {
    const p = players[pIdx];
    const { data: playerRow, error: playerErr } = await supabaseAdmin
      .from("scout_lobby_players")
      .insert({
        lobby_slug: slug,
        display_name: p.displayName.trim(),
        color: p.color ?? null,
        order_index: pIdx,
      })
      .select("id")
      .single();

    if (playerErr || !playerRow) {
      console.error("scout_lobby_players insert error:", playerErr);
      // Rollback by deleting the lobby (CASCADE removes children).
      await supabaseAdmin.from("scout_lobbies").delete().eq("slug", slug);
      return Response.json({ error: "Failed to create player" }, { status: 500 });
    }

    const accountRows = p.accounts.map((a, aIdx) => ({
      lobby_player_id: playerRow.id,
      puuid: a.puuid,
      region: a.region.toUpperCase(),
      riot_name: a.riotName,
      riot_tag: a.riotTag,
      is_primary: aIdx === 0,
      order_index: aIdx,
    }));

    const { error: accErr } = await supabaseAdmin
      .from("scout_lobby_accounts")
      .insert(accountRows);

    if (accErr) {
      console.error("scout_lobby_accounts insert error:", accErr);
      await supabaseAdmin.from("scout_lobbies").delete().eq("slug", slug);
      return Response.json({ error: "Failed to create accounts" }, { status: 500 });
    }
  }

  // Fire ingestion + initial rank snapshot for every account in the lobby
  // (fire-and-forget). Ingestion ensures recent matches show up; snapshot
  // establishes the LP-gain baseline for the leaderboards.
  for (const p of players) {
    for (const a of p.accounts) {
      ingestQuickThenBackground(a.puuid, a.region).catch((e) =>
        console.error(`scout lobby ingest error for ${a.puuid}:`, e)
      );
      writeRankSnapshot(a.puuid, a.region).catch((e) =>
        console.error(`scout lobby snapshot error for ${a.puuid}:`, e)
      );
    }
  }

  return Response.json({ slug, ownerKey }, { status: 201 });
}

// ─── GET /api/scout/resolve-puuid/:puuid?region=euw ─────────────────────
// Resolve a puuid → {name, tag, region} for building summoner-page links
// of arbitrary scoreboard participants. Checks DB caches in order:
//   1. participants table (any row with riot_id_tagline for this puuid)
//   2. users table (populated whenever someone is searched)
//   3. Riot API (last resort) — writes back to participants
const PUUID_RESOLVE_CACHE = new Map<
  string,
  { name: string; tag: string; region: string; ts: number }
>();
const PUUID_RESOLVE_TTL = 24 * 60 * 60 * 1000;          // 24h

const PLATFORM_TO_REGION_SCOUT: Record<string, string> = {
  EUW1: "EUW",
  EUN1: "EUNE",
  NA1: "NA",
  KR: "KR",
  BR1: "BR",
  LA1: "LAN",
  LA2: "LAS",
  OC1: "OCE",
  TR1: "TR",
  RU: "RU",
  JP1: "JP",
};

export async function resolvePuuidHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const puuid = pathname.split("/").pop();
  if (!puuid || puuid.length < 30) {
    return Response.json({ error: "Invalid puuid" }, { status: 400 });
  }

  // In-memory cache
  const cached = PUUID_RESOLVE_CACHE.get(puuid);
  if (cached && Date.now() - cached.ts < PUUID_RESOLVE_TTL) {
    return Response.json(cached);
  }

  // 1. participants table — any row with riot_id_tagline for this puuid
  const { data: partRow } = await supabaseAdmin
    .from("participants")
    .select(
      "summoner_name, riot_id_tagline, matches!inner(platform)"
    )
    .eq("puuid", puuid)
    .not("riot_id_tagline", "is", null)
    .limit(1)
    .maybeSingle();

  if (partRow?.riot_id_tagline && partRow.summoner_name) {
    const platform = (partRow as any).matches?.platform ?? null;
    const region = platform
      ? PLATFORM_TO_REGION_SCOUT[platform.toUpperCase()] ?? null
      : null;
    if (region) {
      const result = {
        name: partRow.summoner_name as string,
        tag: partRow.riot_id_tagline as string,
        region,
        ts: Date.now(),
      };
      PUUID_RESOLVE_CACHE.set(puuid, result);
      return Response.json(result);
    }
  }

  // 2. users table fallback
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("name, tag, region")
    .eq("puuid", puuid)
    .limit(1)
    .maybeSingle();
  if (userRow?.name && userRow.tag && userRow.region) {
    const result = {
      name: userRow.name as string,
      tag: userRow.tag as string,
      region: (userRow.region as string).toUpperCase(),
      ts: Date.now(),
    };
    PUUID_RESOLVE_CACHE.set(puuid, result);
    return Response.json(result);
  }

  // 3. Riot API (rate-limited). Region must be supplied as ?region= since
  //    Riot's account-v1 routes are cluster-based and we'd otherwise have to
  //    probe all clusters.
  const url = new URL(req.url);
  const regionHint = (url.searchParams.get("region") ?? "EUW").toUpperCase();
  try {
    const acc = await getAccountByPuuid(puuid, regionHint);
    if (acc?.gameName && acc?.tagLine) {
      const result = {
        name: acc.gameName as string,
        tag: acc.tagLine as string,
        region: regionHint,
        ts: Date.now(),
      };
      PUUID_RESOLVE_CACHE.set(puuid, result);
      return Response.json(result);
    }
  } catch (err) {
    console.error("scout resolve-puuid: Riot API error:", err);
  }

  return Response.json({ error: "Could not resolve puuid" }, { status: 404 });
}

// ─── shared: resolve lobby player→accounts map ──────────────────────────
async function resolveLobbyPuuids(slug: string): Promise<{
  ok: boolean;
  error?: string;
  playerByPuuid: Map<
    string,
    { id: string; displayName: string; color: string | null }
  >;
  allPlayers: Array<{ id: string; displayName: string; color: string | null }>;
}> {
  const { data: players, error } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, scout_lobby_accounts(puuid, is_primary)"
    )
    .eq("lobby_slug", slug);

  if (error) {
    return {
      ok: false,
      error: error.message,
      playerByPuuid: new Map(),
      allPlayers: [],
    };
  }

  const playerByPuuid = new Map<
    string,
    { id: string; displayName: string; color: string | null }
  >();
  const allPlayers: Array<{ id: string; displayName: string; color: string | null }> = [];
  for (const p of (players ?? []) as any[]) {
    allPlayers.push({ id: p.id, displayName: p.display_name, color: p.color });
    for (const a of p.scout_lobby_accounts ?? []) {
      playerByPuuid.set(a.puuid, {
        id: p.id,
        displayName: p.display_name,
        color: p.color,
      });
    }
  }
  return { ok: true, playerByPuuid, allPlayers };
}

// ─── GET /api/scout/stats/:slug?period=day|week|month ───────────────────
// Returns time-bucketed aggregates across the whole lobby.
// period=day  → last 14 daily buckets
// period=week → last 12 weekly buckets
// period=month → last 12 monthly buckets
type StatsBucket = {
  bucketStart: string;     // ISO of bucket start
  bucketLabel: string;     // pretty label like "Mon 03" / "W23" / "Jun"
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  avgKda: number;
};

function bucketSpec(period: string): {
  count: number;
  ms: number;
  format: (d: Date) => string;
} {
  if (period === "month") {
    return {
      count: 12,
      ms: 30 * 86_400_000, // approximate; we bucket by calendar month below
      format: (d) =>
        d.toLocaleDateString("en-US", { month: "short" }).toUpperCase(),
    };
  }
  if (period === "week") {
    return {
      count: 12,
      ms: 7 * 86_400_000,
      format: (d) => {
        // ISO-ish "W##" label
        const wk = isoWeek(d);
        return `W${String(wk).padStart(2, "0")}`;
      },
    };
  }
  return {
    count: 14,
    ms: 86_400_000,
    format: (d) =>
      d
        .toLocaleDateString("en-US", { weekday: "short", day: "2-digit" })
        .toUpperCase(),
  };
}

function isoWeek(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function startOfBucket(ts: number, period: string): number {
  const d = new Date(ts);
  if (period === "month") {
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
  if (period === "week") {
    // Monday as week start (ISO)
    const day = d.getDay() || 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day - 1));
    monday.setHours(0, 0, 0, 0);
    return monday.getTime();
  }
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export async function readScoutStatsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? "day";
  const spec = bucketSpec(period);

  const { ok, error, playerByPuuid } = await resolveLobbyPuuids(slug);
  if (!ok) {
    console.error("scout stats: lobby resolve error:", error);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (playerByPuuid.size === 0) {
    return Response.json({ buckets: [], period });
  }

  const allPuuids = Array.from(playerByPuuid.keys());

  // Window — go back enough to cover `count` buckets
  const startTs =
    period === "month"
      ? startOfBucket(Date.now() - spec.count * 31 * 86_400_000, period)
      : startOfBucket(Date.now() - (spec.count - 1) * spec.ms, period);
  const startIso = new Date(startTs).toISOString();

  // Fetch participants in window
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, win, kills, deaths, assists, matches!inner(game_creation)"
    )
    .in("puuid", allPuuids)
    .gte("matches.game_creation", startIso);

  if (rowsErr) {
    console.error("scout stats: rows query error:", rowsErr);
    return Response.json({ error: "Failed to read stats" }, { status: 500 });
  }

  // Aggregate per bucket, deduping (playerId, matchId) so squad games count
  // once across the lobby.
  type BucketAgg = {
    start: number;
    games: number;
    wins: number;
    kills: number;
    deaths: number;
    assists: number;
  };
  const buckets = new Map<number, BucketAgg>();
  const seen = new Set<string>();

  for (const r of (rows ?? []) as any[]) {
    const owner = playerByPuuid.get(r.puuid);
    if (!owner) continue;
    const ts = new Date(r.matches.game_creation).getTime();
    const bStart = startOfBucket(ts, period);
    const seenKey = `${owner.id}:${r.match_id}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    if (!buckets.has(bStart)) {
      buckets.set(bStart, {
        start: bStart,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
      });
    }
    const b = buckets.get(bStart)!;
    b.games += 1;
    if (r.win) b.wins += 1;
    b.kills += r.kills ?? 0;
    b.deaths += r.deaths ?? 0;
    b.assists += r.assists ?? 0;
  }

  // Pad missing buckets with zeros so the frontend can chart consistently.
  const out: StatsBucket[] = [];
  let cursor = startTs;
  const nowBucket = startOfBucket(Date.now(), period);
  while (cursor <= nowBucket) {
    const b = buckets.get(cursor);
    const games = b?.games ?? 0;
    const wins = b?.wins ?? 0;
    const kills = b?.kills ?? 0;
    const deaths = b?.deaths ?? 0;
    const assists = b?.assists ?? 0;
    const winrate = games > 0 ? Math.round((wins / games) * 100) : 0;
    const avgKda =
      games === 0
        ? 0
        : deaths === 0
        ? Math.min(99, (kills + assists) / Math.max(1, games))
        : (kills + assists) / deaths;
    out.push({
      bucketStart: new Date(cursor).toISOString(),
      bucketLabel: spec.format(new Date(cursor)),
      games,
      wins,
      losses: games - wins,
      winrate,
      avgKda: Math.round(avgKda * 100) / 100,
    });

    // Advance cursor to next bucket start
    const d = new Date(cursor);
    if (period === "month") {
      d.setMonth(d.getMonth() + 1);
      cursor = d.getTime();
    } else {
      cursor += spec.ms;
    }
  }

  return Response.json({ buckets: out, period });
}

// ─── GET /api/scout/champions/:slug?window=today|week|all ──────────────
// Per-player top 5 champions in the window (sorted by games desc).
type ChampionLine = {
  champion: string;
  games: number;
  wins: number;
  winrate: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKda: number;
};
type ChampionsPlayer = {
  playerId: string;
  displayName: string;
  color: string | null;
  champions: ChampionLine[];
};

export async function readScoutChampionsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const window = url.searchParams.get("window") ?? "all";
  const startIso = windowStartIso(window);

  const { ok, playerByPuuid, allPlayers } = await resolveLobbyPuuids(slug);
  if (!ok) return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  if (playerByPuuid.size === 0) {
    return Response.json({ players: [], window });
  }
  const allPuuids = Array.from(playerByPuuid.keys());

  let q = supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, champion_name, win, kills, deaths, assists, matches!inner(game_creation)"
    )
    .in("puuid", allPuuids);
  if (startIso) q = q.gte("matches.game_creation", startIso);

  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    console.error("scout champions: query error:", rowsErr);
    return Response.json({ error: "Failed to read champions" }, { status: 500 });
  }

  // (playerId, champion) → agg
  const seen = new Set<string>();
  const agg = new Map<
    string,
    {
      playerId: string;
      champion: string;
      games: number;
      wins: number;
      kills: number;
      deaths: number;
      assists: number;
    }
  >();

  for (const r of (rows ?? []) as any[]) {
    const owner = playerByPuuid.get(r.puuid);
    if (!owner) continue;
    const champ = r.champion_name ?? "Unknown";
    const seenKey = `${owner.id}:${r.match_id}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const key = `${owner.id}::${champ}`;
    if (!agg.has(key)) {
      agg.set(key, {
        playerId: owner.id,
        champion: champ,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
      });
    }
    const a = agg.get(key)!;
    a.games += 1;
    if (r.win) a.wins += 1;
    a.kills += r.kills ?? 0;
    a.deaths += r.deaths ?? 0;
    a.assists += r.assists ?? 0;
  }

  const byPlayer = new Map<string, ChampionLine[]>();
  for (const a of agg.values()) {
    const avgKda =
      a.deaths === 0
        ? Math.min(99, a.kills + a.assists)
        : (a.kills + a.assists) / a.deaths;
    const line: ChampionLine = {
      champion: a.champion,
      games: a.games,
      wins: a.wins,
      winrate: Math.round((a.wins / a.games) * 100),
      kills: a.kills,
      deaths: a.deaths,
      assists: a.assists,
      avgKda: Math.round(avgKda * 100) / 100,
    };
    if (!byPlayer.has(a.playerId)) byPlayer.set(a.playerId, []);
    byPlayer.get(a.playerId)!.push(line);
  }

  const out: ChampionsPlayer[] = allPlayers.map((p) => ({
    playerId: p.id,
    displayName: p.displayName,
    color: p.color,
    champions: (byPlayer.get(p.id) ?? [])
      .sort((x, y) => y.games - x.games || y.winrate - x.winrate)
      .slice(0, 5),
  }));

  return Response.json({ players: out, window });
}

// ─── GET /api/scout/habits/:slug?window=today|week|all ─────────────────
// Per-player "personality" metrics:
//   - winrate after a loss (do they tilt-queue?)
//   - winrate after a win
//   - longest win streak, longest loss streak
//   - time-of-day distribution (binned into 4 quarters of the day)
type HabitsPlayer = {
  playerId: string;
  displayName: string;
  color: string | null;
  games: number;
  afterLoss: { games: number; wins: number; winrate: number };
  afterWin: { games: number; wins: number; winrate: number };
  longestWinStreak: number;
  longestLossStreak: number;
  timeOfDay: { morning: number; afternoon: number; evening: number; night: number };
};

function tagTimeOfDay(d: Date): keyof HabitsPlayer["timeOfDay"] {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18 && h < 23) return "evening";
  return "night";
}

export async function readScoutHabitsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const window = url.searchParams.get("window") ?? "all";
  const startIso = windowStartIso(window);

  const { ok, playerByPuuid, allPlayers } = await resolveLobbyPuuids(slug);
  if (!ok) return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  if (playerByPuuid.size === 0) {
    return Response.json({ players: [], window });
  }
  const allPuuids = Array.from(playerByPuuid.keys());

  let q = supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, win, matches!inner(game_creation)"
    )
    .in("puuid", allPuuids);
  if (startIso) q = q.gte("matches.game_creation", startIso);

  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    console.error("scout habits: query error:", rowsErr);
    return Response.json({ error: "Failed to read habits" }, { status: 500 });
  }

  // Per-player ordered list of (ts, win)
  const seriesByPlayer = new Map<
    string,
    Array<{ ts: number; win: boolean; matchId: string }>
  >();
  const seen = new Set<string>();
  for (const r of (rows ?? []) as any[]) {
    const owner = playerByPuuid.get(r.puuid);
    if (!owner) continue;
    const key = `${owner.id}:${r.match_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!seriesByPlayer.has(owner.id)) seriesByPlayer.set(owner.id, []);
    seriesByPlayer.get(owner.id)!.push({
      ts: new Date(r.matches.game_creation).getTime(),
      win: !!r.win,
      matchId: r.match_id,
    });
  }

  const out: HabitsPlayer[] = [];
  for (const p of allPlayers) {
    const series = (seriesByPlayer.get(p.id) ?? []).sort(
      (a, b) => a.ts - b.ts
    );

    let afterLossGames = 0,
      afterLossWins = 0;
    let afterWinGames = 0,
      afterWinWins = 0;
    let curWinStreak = 0,
      curLossStreak = 0;
    let bestWinStreak = 0,
      bestLossStreak = 0;
    const tod = { morning: 0, afternoon: 0, evening: 0, night: 0 };

    for (let i = 0; i < series.length; i++) {
      const g = series[i];
      tod[tagTimeOfDay(new Date(g.ts))] += 1;
      if (g.win) {
        curWinStreak += 1;
        curLossStreak = 0;
        if (curWinStreak > bestWinStreak) bestWinStreak = curWinStreak;
      } else {
        curLossStreak += 1;
        curWinStreak = 0;
        if (curLossStreak > bestLossStreak) bestLossStreak = curLossStreak;
      }
      if (i > 0) {
        const prev = series[i - 1];
        if (prev.win) {
          afterWinGames += 1;
          if (g.win) afterWinWins += 1;
        } else {
          afterLossGames += 1;
          if (g.win) afterLossWins += 1;
        }
      }
    }

    out.push({
      playerId: p.id,
      displayName: p.displayName,
      color: p.color,
      games: series.length,
      afterLoss: {
        games: afterLossGames,
        wins: afterLossWins,
        winrate:
          afterLossGames > 0
            ? Math.round((afterLossWins / afterLossGames) * 100)
            : 0,
      },
      afterWin: {
        games: afterWinGames,
        wins: afterWinWins,
        winrate:
          afterWinGames > 0
            ? Math.round((afterWinWins / afterWinGames) * 100)
            : 0,
      },
      longestWinStreak: bestWinStreak,
      longestLossStreak: bestLossStreak,
      timeOfDay: tod,
    });
  }

  return Response.json({ players: out, window });
}

// ─── GET /api/scout/trending/:slug ──────────────────────────────────────
// Comprehensive aggregations for the Trending tab. All stats are scoped to
// the period since lobby creation. Returns one big payload so the frontend
// can render the entire dashboard with a single fetch.

const TREND_DURATION_BUCKETS = [
  { label: "<20m", min: 0, max: 20 * 60 },
  { label: "20-25m", min: 20 * 60, max: 25 * 60 },
  { label: "25-30m", min: 25 * 60, max: 30 * 60 },
  { label: "30-35m", min: 30 * 60, max: 35 * 60 },
  { label: "35-40m", min: 35 * 60, max: 40 * 60 },
  { label: "40m+", min: 40 * 60, max: Infinity },
];
const TREND_KDA_BUCKETS = [
  { label: "<1", min: 0, max: 1 },
  { label: "1-2", min: 1, max: 2 },
  { label: "2-3", min: 2, max: 3 },
  { label: "3-4", min: 3, max: 4 },
  { label: "4-5", min: 4, max: 5 },
  { label: "5+", min: 5, max: Infinity },
];

function normalizeRole(r: string | null): string {
  if (!r) return "UNKNOWN";
  const u = r.toUpperCase();
  if (u === "MIDDLE") return "MID";
  if (u === "BOTTOM") return "ADC";
  if (u === "UTILITY") return "SUP";
  if (u === "JUNGLE") return "JNG";
  return u;
}

export async function readScoutTrendingHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // Lobby creation cutoff.
  const { data: lobby } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  if (!lobby) {
    return Response.json({ error: "Lobby not found" }, { status: 404 });
  }
  const sinceIso = new Date(lobby.created_at).toISOString();
  const sinceTs = new Date(lobby.created_at).getTime();

  // Lobby players + their accounts.
  const { data: playerRows } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, scout_lobby_accounts(puuid, is_primary)"
    )
    .eq("lobby_slug", slug);

  if (!playerRows || playerRows.length === 0) {
    return Response.json({ error: "No players in lobby" }, { status: 404 });
  }

  const playerByPuuid = new Map<
    string,
    { id: string; displayName: string; color: string | null }
  >();
  for (const p of playerRows as any[]) {
    for (const a of p.scout_lobby_accounts ?? []) {
      playerByPuuid.set(a.puuid, {
        id: p.id,
        displayName: p.display_name,
        color: p.color,
      });
    }
  }
  const allPuuids = Array.from(playerByPuuid.keys());

  if (allPuuids.length === 0) {
    return Response.json({ error: "No accounts in lobby" }, { status: 404 });
  }

  // One fat query — all participant rows for the lobby since creation.
  const { data: rows, error } = await supabaseAdmin
    .from("participants")
    .select(
      `puuid, match_id, champion_name, role, win,
       kills, deaths, assists, gold_earned, total_damage_to_champions, vision_score,
       matches!inner(game_creation, game_duration_seconds, queue_id)`
    )
    .in("puuid", allPuuids)
    .gte("matches.game_creation", sinceIso);
  if (error) {
    console.error("scout trending: query error:", error);
    return Response.json({ error: "Failed to query stats" }, { status: 500 });
  }

  // ── Initialize accumulators ──────────────────────────────────────────
  type PerPlayer = {
    playerId: string;
    displayName: string;
    color: string | null;
    games: number;
    wins: number;
    kills: number;
    deaths: number;
    assists: number;
    damage: number;
    gold: number;
    vision: number;
    duration: number;        // seconds
    championSet: Set<string>;
  };

  const perPlayer = new Map<string, PerPlayer>();
  for (const p of playerRows as any[]) {
    perPlayer.set(p.id, {
      playerId: p.id,
      displayName: p.display_name,
      color: p.color,
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      gold: 0,
      vision: 0,
      duration: 0,
      championSet: new Set(),
    });
  }

  // dayKey → {games, wins, kills, deaths, assists}
  const dailyByKey = new Map<
    string,
    { games: number; wins: number; kills: number; deaths: number; assists: number }
  >();
  // hour x weekday — 7 rows × 24 cols (weekday 0 = Monday)
  const hourlyHeatmap: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );
  // duration buckets
  const durationCounts = TREND_DURATION_BUCKETS.map(() => 0);
  // kda buckets
  const kdaCounts = TREND_KDA_BUCKETS.map(() => 0);
  // role/champion/queue
  const roleAgg = new Map<string, { games: number; wins: number }>();
  const championAgg = new Map<
    string,
    { games: number; wins: number; kills: number; deaths: number; assists: number }
  >();
  const queueAgg = { solo: 0, soloWins: 0, flex: 0, flexWins: 0, other: 0 };

  // Lobby totals
  const totals = {
    games: 0,
    wins: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    gold: 0,
    vision: 0,
    durationSec: 0,
  };

  // Track unique matches for accurate "lobby games" count (dedupe squads)
  const seenMatches = new Set<string>();

  // Match-level player win sequences for streak detection (per-player ordered)
  const matchSeriesPerPlayer = new Map<
    string,
    Array<{ ts: number; win: boolean; matchId: string }>
  >();

  for (const r of (rows ?? []) as any[]) {
    const owner = playerByPuuid.get(r.puuid);
    if (!owner) continue;
    const m = r.matches;
    const ts = new Date(m.game_creation).getTime();
    if (ts < sinceTs) continue;

    // ── Per-player aggregation
    const pp = perPlayer.get(owner.id)!;
    pp.games += 1;
    if (r.win) pp.wins += 1;
    pp.kills += r.kills ?? 0;
    pp.deaths += r.deaths ?? 0;
    pp.assists += r.assists ?? 0;
    pp.damage += r.total_damage_to_champions ?? 0;
    pp.gold += r.gold_earned ?? 0;
    pp.vision += r.vision_score ?? 0;
    pp.duration += m.game_duration_seconds ?? 0;
    if (r.champion_name) pp.championSet.add(r.champion_name);

    // ── Player series for streaks
    if (!matchSeriesPerPlayer.has(owner.id)) {
      matchSeriesPerPlayer.set(owner.id, []);
    }
    matchSeriesPerPlayer
      .get(owner.id)!
      .push({ ts, win: !!r.win, matchId: r.match_id });

    // ── Role
    const role = normalizeRole(r.role);
    if (!roleAgg.has(role)) roleAgg.set(role, { games: 0, wins: 0 });
    const ra = roleAgg.get(role)!;
    ra.games += 1;
    if (r.win) ra.wins += 1;

    // ── Champion
    const champ = r.champion_name ?? "Unknown";
    if (!championAgg.has(champ)) {
      championAgg.set(champ, { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });
    }
    const ca = championAgg.get(champ)!;
    ca.games += 1;
    if (r.win) ca.wins += 1;
    ca.kills += r.kills ?? 0;
    ca.deaths += r.deaths ?? 0;
    ca.assists += r.assists ?? 0;

    // ── KDA bucket
    const kdaVal =
      (r.deaths ?? 0) === 0
        ? Math.min(99, (r.kills ?? 0) + (r.assists ?? 0))
        : ((r.kills ?? 0) + (r.assists ?? 0)) / (r.deaths ?? 0);
    for (let bi = 0; bi < TREND_KDA_BUCKETS.length; bi++) {
      const b = TREND_KDA_BUCKETS[bi];
      if (kdaVal >= b.min && kdaVal < b.max) {
        kdaCounts[bi] += 1;
        break;
      }
    }

    // ── Match-level dedupe (per match across squads)
    if (!seenMatches.has(r.match_id)) {
      seenMatches.add(r.match_id);

      // Lobby totals (per-match counted once)
      totals.games += 1;
      if (r.win) totals.wins += 1;
      totals.durationSec += m.game_duration_seconds ?? 0;

      // Daily
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      const dayKey = d.toISOString().slice(0, 10);
      if (!dailyByKey.has(dayKey)) {
        dailyByKey.set(dayKey, {
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
        });
      }
      const da = dailyByKey.get(dayKey)!;
      da.games += 1;
      if (r.win) da.wins += 1;
      da.kills += r.kills ?? 0;
      da.deaths += r.deaths ?? 0;
      da.assists += r.assists ?? 0;

      // Hourly heatmap (local time)
      const dt = new Date(ts);
      const weekday = (dt.getDay() + 6) % 7;            // 0 = Monday
      const hour = dt.getHours();
      hourlyHeatmap[weekday][hour] += 1;

      // Duration
      const dur = m.game_duration_seconds ?? 0;
      for (let bi = 0; bi < TREND_DURATION_BUCKETS.length; bi++) {
        const b = TREND_DURATION_BUCKETS[bi];
        if (dur >= b.min && dur < b.max) {
          durationCounts[bi] += 1;
          break;
        }
      }

      // Queue
      const qid = m.queue_id;
      if (qid === 420) {
        queueAgg.solo += 1;
        if (r.win) queueAgg.soloWins += 1;
      } else if (qid === 440) {
        queueAgg.flex += 1;
        if (r.win) queueAgg.flexWins += 1;
      } else {
        queueAgg.other += 1;
      }
    }

    // Totals from participant view (per-player damage etc.)
    totals.kills += r.kills ?? 0;
    totals.deaths += r.deaths ?? 0;
    totals.assists += r.assists ?? 0;
    totals.damage += r.total_damage_to_champions ?? 0;
    totals.gold += r.gold_earned ?? 0;
    totals.vision += r.vision_score ?? 0;
  }

  // ── Streaks (per player → global longest)
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const series of matchSeriesPerPlayer.values()) {
    series.sort((a, b) => a.ts - b.ts);
    let curW = 0;
    let curL = 0;
    for (const g of series) {
      if (g.win) {
        curW += 1;
        curL = 0;
        if (curW > longestWinStreak) longestWinStreak = curW;
      } else {
        curL += 1;
        curW = 0;
        if (curL > longestLossStreak) longestLossStreak = curL;
      }
    }
  }

  // ── Per-player wins-after-loss / wins-after-win + uniqueChampions
  const perPlayerStats = Array.from(perPlayer.values()).map((p) => {
    const games = p.games;
    const winrate = games > 0 ? Math.round((p.wins / games) * 100) : 0;
    const avgKda =
      p.deaths === 0
        ? Math.min(99, p.kills + p.assists)
        : (p.kills + p.assists) / p.deaths;
    return {
      playerId: p.playerId,
      displayName: p.displayName,
      color: p.color,
      games,
      wins: p.wins,
      losses: games - p.wins,
      winrate,
      avgKills: games > 0 ? p.kills / games : 0,
      avgDeaths: games > 0 ? p.deaths / games : 0,
      avgAssists: games > 0 ? p.assists / games : 0,
      avgKda,
      avgDamage: games > 0 ? p.damage / games : 0,
      avgGoldPerMin:
        p.duration > 0 ? (p.gold * 60) / p.duration : 0,
      avgVision: games > 0 ? p.vision / games : 0,
      avgCsPerMin: 0, // CS not in participants table yet
      uniqueChampions: p.championSet.size,
    };
  });

  // ── Daily — fill missing dates between sinceTs and today with zeros
  const dailyOut: Array<{
    date: string;
    games: number;
    wins: number;
    avgKda: number;
  }> = [];
  const startDay = new Date(sinceTs);
  startDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let d = new Date(startDay); d <= today; d.setDate(d.getDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const agg = dailyByKey.get(key);
    const games = agg?.games ?? 0;
    const wins = agg?.wins ?? 0;
    const k = agg?.kills ?? 0;
    const de = agg?.deaths ?? 0;
    const a = agg?.assists ?? 0;
    const avgKda = de === 0 ? Math.min(99, k + a) : (k + a) / de;
    dailyOut.push({ date: key, games, wins, avgKda: Math.round(avgKda * 100) / 100 });
  }

  // ── Top champions (slice by games)
  const topChampions = Array.from(championAgg.entries())
    .map(([champion, a]) => {
      const avgKda =
        a.deaths === 0
          ? Math.min(99, a.kills + a.assists)
          : (a.kills + a.assists) / a.deaths;
      return {
        champion,
        games: a.games,
        wins: a.wins,
        winrate: Math.round((a.wins / a.games) * 100),
        avgKda: Math.round(avgKda * 100) / 100,
      };
    })
    .sort((x, y) => y.games - x.games)
    .slice(0, 20);

  // ── Role distribution sorted by games
  const roleDistribution = Array.from(roleAgg.entries())
    .map(([role, a]) => ({
      role,
      games: a.games,
      wins: a.wins,
      winrate: a.games > 0 ? Math.round((a.wins / a.games) * 100) : 0,
    }))
    .sort((x, y) => y.games - x.games);

  // ── Active days (days with at least one game)
  const activeDays = Array.from(dailyByKey.values()).filter(
    (d) => d.games > 0
  ).length;

  return Response.json({
    sinceIso,
    lobbySummary: {
      ...totals,
      avgGameDurationSec:
        totals.games > 0 ? totals.durationSec / totals.games : 0,
      activeDays,
      sinceIso,
    },
    daily: dailyOut,
    hourlyHeatmap, // [weekday][hour]
    durationHistogram: TREND_DURATION_BUCKETS.map((b, i) => ({
      label: b.label,
      count: durationCounts[i],
    })),
    kdaHistogram: TREND_KDA_BUCKETS.map((b, i) => ({
      label: b.label,
      count: kdaCounts[i],
    })),
    queueBreakdown: queueAgg,
    roleDistribution,
    topChampions,
    streaks: {
      longestWinStreak,
      longestLossStreak,
    },
    perPlayer: perPlayerStats,
  });
}

// ─── GET /api/scout/leaderboard/:slug?window=today|week|all ─────────────
// Returns aggregated player stats over the chosen window.
// All metrics are computed per (lobby_player) by summing across the player's
// 1-3 accounts. min_games gates winrate / kda displays.

type LeaderboardAccountRow = {
  // Identity — one row per (lobby) account.
  puuid: string;
  region: string;
  riotName: string;
  riotTag: string;
  iconId: number | null;
  // Owning player (for grouping / accent color).
  playerId: string;
  playerDisplayName: string;
  color: string | null;
  // Rank
  currentRank: {
    tier: string;
    rankDivision: string | null;
    lp: number;
    wins: number;
    losses: number;
  } | null;
  // Window stats
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  kills: number;
  deaths: number;
  assists: number;
  avgKda: number;          // Infinity-safe: caps at 99 for "Perfect" runs
  balance: number;         // ladderScore delta since lobby creation (signed)
};

function windowStartIso(window: string): string | null {
  const now = Date.now();
  if (window === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (window === "week") {
    return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  }
  return null; // all-time
}

export async function readScoutLeaderboardHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // Cutoff = lobby creation date. Everything is "since the lobby existed".
  const { data: lobbyMeta } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  const startIso = lobbyMeta?.created_at
    ? new Date(lobbyMeta.created_at).toISOString()
    : null;

  // 1. Resolve all (player → accounts) — one row per account in the lobby.
  const { data: players, error: playersErr } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, scout_lobby_accounts(puuid, is_primary, region, riot_name, riot_tag)"
    )
    .eq("lobby_slug", slug);

  if (playersErr) {
    console.error("scout leaderboard: players read error:", playersErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!players || players.length === 0) {
    return Response.json({ accounts: [] });
  }

  // Build a flat list of all accounts with their player metadata attached.
  type AccountRef = {
    puuid: string;
    region: string;
    riotName: string;
    riotTag: string;
    playerId: string;
    playerDisplayName: string;
    color: string | null;
  };
  const accountList: AccountRef[] = [];
  for (const p of players as any[]) {
    for (const a of p.scout_lobby_accounts ?? []) {
      accountList.push({
        puuid: a.puuid,
        region: a.region,
        riotName: a.riot_name,
        riotTag: a.riot_tag,
        playerId: p.id,
        playerDisplayName: p.display_name,
        color: p.color,
      });
    }
  }
  if (accountList.length === 0) {
    return Response.json({ accounts: [] });
  }
  const allPuuids = accountList.map((a) => a.puuid);

  // 2. Icon lookup per account (users.icon_id).
  const iconByPuuid = new Map<string, number | null>();
  {
    const { data: iconRows } = await supabaseAdmin
      .from("users")
      .select("puuid, icon_id")
      .in("puuid", allPuuids);
    for (const r of iconRows ?? []) iconByPuuid.set(r.puuid, r.icon_id ?? null);
  }

  // 3. Aggregate participants per (puuid) in window.
  let q = supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, win, kills, deaths, assists, matches!inner(game_creation, queue_id)"
    )
    .in("puuid", allPuuids);
  if (startIso) q = q.gte("matches.game_creation", startIso);
  const { data: partRows, error: partErr } = await q;
  if (partErr) {
    console.error("scout leaderboard: participants read error:", partErr);
    return Response.json({ error: "Failed to read matches" }, { status: 500 });
  }

  type Agg = {
    games: number;
    wins: number;
    kills: number;
    deaths: number;
    assists: number;
  };
  const byPuuid = new Map<string, Agg>();
  for (const a of accountList) {
    byPuuid.set(a.puuid, { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });
  }
  // Dedupe (puuid, matchId) — a row should count once even if duplicated.
  const seen = new Set<string>();
  for (const r of (partRows ?? []) as any[]) {
    const key = `${r.puuid}:${r.match_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const agg = byPuuid.get(r.puuid);
    if (!agg) continue;
    agg.games += 1;
    if (r.win) agg.wins += 1;
    agg.kills += r.kills ?? 0;
    agg.deaths += r.deaths ?? 0;
    agg.assists += r.assists ?? 0;
  }

  // 4. Snapshot lookups — current rank (latest) + LP delta in window.
  const currentRankByPuuid = new Map<
    string,
    { tier: string; rankDivision: string | null; lp: number; wins: number; losses: number }
  >();
  const balanceByPuuid = new Map<string, number>();

  {
    const { data: latestRows } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("puuid, tier, rank_division, lp, wins, losses, taken_at")
      .in("puuid", allPuuids)
      .eq("queue_type", "RANKED_SOLO_5x5")
      .order("taken_at", { ascending: false });
    for (const r of (latestRows ?? []) as any[]) {
      if (!currentRankByPuuid.has(r.puuid)) {
        currentRankByPuuid.set(r.puuid, {
          tier: r.tier,
          rankDivision: r.rank_division ?? null,
          lp: Number(r.lp ?? 0),
          wins: Number(r.wins ?? 0),
          losses: Number(r.losses ?? 0),
        });
      }
    }

    let lpq = supabaseAdmin
      .from("scout_rank_snapshots")
      .select("puuid, lp, tier, rank_division, taken_at")
      .in("puuid", allPuuids)
      .eq("queue_type", "RANKED_SOLO_5x5")
      .order("taken_at", { ascending: true });
    if (startIso) lpq = lpq.gte("taken_at", startIso);
    const { data: snapRows } = await lpq;

    const windowByPuuid = new Map<string, { first: any; last: any }>();
    for (const s of (snapRows ?? []) as any[]) {
      const cur = windowByPuuid.get(s.puuid);
      if (!cur) windowByPuuid.set(s.puuid, { first: s, last: s });
      else cur.last = s;
    }
    for (const [puuid, { first, last }] of windowByPuuid) {
      const firstScore = ladderScore(first.tier, first.rank_division, first.lp ?? 0);
      const lastScore = ladderScore(last.tier, last.rank_division, last.lp ?? 0);
      balanceByPuuid.set(puuid, lastScore - firstScore);
    }
  }

  // 5. Build rows — one per account.
  const accountRows: LeaderboardAccountRow[] = accountList.map((a) => {
    const agg = byPuuid.get(a.puuid) ?? {
      games: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };
    const games = agg.games;
    const winrate = games > 0 ? Math.round((agg.wins / games) * 100) : 0;
    const avgKda =
      agg.deaths === 0
        ? Math.min(99, agg.kills + agg.assists)
        : (agg.kills + agg.assists) / agg.deaths;

    return {
      puuid: a.puuid,
      region: a.region,
      riotName: a.riotName,
      riotTag: a.riotTag,
      iconId: iconByPuuid.get(a.puuid) ?? null,
      playerId: a.playerId,
      playerDisplayName: a.playerDisplayName,
      color: a.color,
      currentRank: currentRankByPuuid.get(a.puuid) ?? null,
      games,
      wins: agg.wins,
      losses: games - agg.wins,
      winrate,
      kills: agg.kills,
      deaths: agg.deaths,
      assists: agg.assists,
      avgKda,
      balance: balanceByPuuid.get(a.puuid) ?? 0,
    };
  });

  return Response.json({ accounts: accountRows });
}

// ─── GET /api/scout/feed/:slug ──────────────────────────────────────────
// Paginated unified feed: every match where any lobby account played, newest
// first. Each row carries the participant row of the lobby account, plus
// `lobbyPlayers` listing which lobby players appeared in the match (used by
// the squad badge on the frontend).
//
// Cursor: ISO timestamp of the oldest game_creation in the previous page.
const FEED_DEFAULT_LIMIT = 20;
const FEED_MAX_LIMIT = 50;

type ParticipantSlim = {
  puuid: string;
  summonerName: string | null;
  riotTagline: string | null;     // for building /summoners/<region>/<name>-<tag>
  championName: string | null;
  role: string | null;            // TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY
  teamId: number | null;
  platform: string | null;        // e.g. EUW1 — for region inference
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
};

type FeedItem = {
  // Identity of this row: matchId + which lobby player owns it (so a single
  // squad game becomes 2-5 rows, one per involved player). Frontend uses
  // ownerPlayerId to bucket into per-player sections.
  rowId: string;                 // `${matchId}:${ownerPlayerId}`
  matchId: string;
  ownerPlayerId: string;
  queueId: number | null;
  gameCreation: string;          // ISO
  gameDurationSeconds: number | null;
  platform: string | null;
  participant: {
    puuid: string;
    summonerName: string | null;
    teamId: number | null;
    championId: number | null;
    championName: string | null;
    role: string | null;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
    goldEarned: number;
    totalDamageToChampions: number;
    visionScore: number;
    items: number[];
    perkPrimaryStyle: number | null;
    perkSubStyle: number | null;
    perkKeystone: number | null;
    // LP delta for this match (post-game). Computed from rank snapshots:
    //   - lpDelta: signed LP change when tier+division didn't change
    //   - rankChange: "PROMOTION" / "DEMOTION" when they did (lpDelta is null)
    //   - rankAfter: the tier+division reached when rankChange is set
    // All null if no snapshot pair found for this match.
    lpDelta: number | null;
    rankChange: "PROMOTION" | "DEMOTION" | null;
    rankAfter: { tier: string; division: string | null } | null;
  };
  // All 10 players in the match (slim) — used by the scout MatchCard to
  // render the team scoreboard inline.
  allParticipants: ParticipantSlim[];
  lobbyPlayers: Array<{
    playerId: string;
    displayName: string;
    color: string | null;
    accountPuuid: string;
  }>;
  // Every lobby account puuid that played this match (NOT deduped by player
  // — a player using 2 different accounts in the same game appears twice).
  // Used by the scoreboard to mark duos/trios regardless of grouping.
  lobbyAccountPuuidsInMatch: string[];
};

// In-memory cache for Riot match details. Match data is immutable post-game
// so we can cache aggressively. Reduces feed-load latency from ~1.5s to instant
// when matches are already known.
const SCOUT_MATCH_DETAILS_CACHE = new Map<string, { data: any; ts: number }>();
const SCOUT_MATCH_DETAILS_TTL = 60 * 60 * 1000; // 1h
const SCOUT_MATCH_DETAILS_MAX = 2000;

function getCachedMatchDetails(id: string): any | null {
  const e = SCOUT_MATCH_DETAILS_CACHE.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > SCOUT_MATCH_DETAILS_TTL) {
    SCOUT_MATCH_DETAILS_CACHE.delete(id);
    return null;
  }
  return e.data;
}
function setCachedMatchDetails(id: string, data: any) {
  if (SCOUT_MATCH_DETAILS_CACHE.size >= SCOUT_MATCH_DETAILS_MAX) {
    const k = SCOUT_MATCH_DETAILS_CACHE.keys().next().value;
    if (k) SCOUT_MATCH_DETAILS_CACHE.delete(k);
  }
  SCOUT_MATCH_DETAILS_CACHE.set(id, { data, ts: Date.now() });
}

// Numeric ID extractor — match IDs look like "EUW1_7234567890". The numeric
// part is monotonic per platform so we can sort by it for "newest first".
function numericMatchId(id: string): number {
  const part = id.split("_")[1] ?? "0";
  return Number(part) || 0;
}

export async function readScoutFeedHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  // pathname is /api/scout/feed/:slug
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const rawCursor = url.searchParams.get("cursor"); // numeric ID stringified
  const limitRaw = Number(url.searchParams.get("limit") ?? FEED_DEFAULT_LIMIT);
  const limit = Math.min(
    FEED_MAX_LIMIT,
    Math.max(1, Number.isFinite(limitRaw) ? limitRaw : FEED_DEFAULT_LIMIT)
  );

  // Parse cursor: numeric ID for new format. ISO strings (old format) → ignore.
  let cursorNum: number | null = null;
  if (rawCursor) {
    const asNum = Number(rawCursor);
    if (Number.isFinite(asNum) && asNum > 0) cursorNum = asNum;
  }

  // 1. Resolve lobby accounts → puuid + region map
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select(
      "puuid, region, lobby_player_id, scout_lobby_players!inner(id, display_name, color, lobby_slug)"
    )
    .eq("scout_lobby_players.lobby_slug", slug);

  if (accErr) {
    console.error("scout feed: account lookup error:", accErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!accounts || accounts.length === 0) {
    return Response.json({ items: [], nextCursor: null });
  }

  type LobbyPlayerInfo = {
    playerId: string;
    displayName: string;
    color: string | null;
  };
  const puuidToPlayers = new Map<string, LobbyPlayerInfo[]>();
  const puuidToRegion = new Map<string, string>();
  for (const a of accounts as any[]) {
    const lp: LobbyPlayerInfo = {
      playerId: a.scout_lobby_players.id,
      displayName: a.scout_lobby_players.display_name,
      color: a.scout_lobby_players.color,
    };
    if (!puuidToPlayers.has(a.puuid)) puuidToPlayers.set(a.puuid, []);
    puuidToPlayers.get(a.puuid)!.push(lp);
    puuidToRegion.set(a.puuid, a.region);
  }
  const allPuuids = Array.from(puuidToPlayers.keys());

  // 2. For each puuid, fetch top N match IDs directly from Riot (parallel).
  //    Riot returns newest-first already. type=ranked covers solo/duo + flex.
  const { startTime, endTime } = getCurrentSeasonWindow();
  const RIOT_FETCH_COUNT = 100; // generous for pagination

  const matchIdsByPuuid = new Map<string, string[]>();
  await Promise.all(
    allPuuids.map(async (puuid) => {
      const region = puuidToRegion.get(puuid)!;
      try {
        const ids = await getMatchIdsByPuuidOpts(puuid, region, {
          start: 0,
          count: RIOT_FETCH_COUNT,
          type: "ranked",
          startTime,
          endTime,
        });
        matchIdsByPuuid.set(puuid, ids ?? []);
      } catch (err) {
        console.error(
          `scout feed: Riot match-ids fetch failed for ${puuid.slice(0, 8)}…:`,
          (err as any)?.message ?? err
        );
        matchIdsByPuuid.set(puuid, []);
      }
    })
  );

  // 3. Build dedup map: matchId → which lobby puuids played in it.
  //    A squad game lists multiple puuids; a solo game lists one.
  const matchToPuuids = new Map<string, Set<string>>();
  for (const [puuid, ids] of matchIdsByPuuid) {
    for (const id of ids) {
      if (!matchToPuuids.has(id)) matchToPuuids.set(id, new Set());
      matchToPuuids.get(id)!.add(puuid);
    }
  }

  // 4. Sort match IDs by numeric ID desc (newest first), apply cursor filter,
  //    then take this page's worth.
  let sortedMatchIds = Array.from(matchToPuuids.keys()).sort(
    (a, b) => numericMatchId(b) - numericMatchId(a)
  );
  if (cursorNum != null) {
    sortedMatchIds = sortedMatchIds.filter(
      (id) => numericMatchId(id) < cursorNum!
    );
  }
  const pageMatchIds = sortedMatchIds.slice(0, limit);
  const hasMore = sortedMatchIds.length > limit;

  console.log(
    `📥 feed ${slug}: ${allPuuids.length} puuids → ${matchToPuuids.size} unique matches → page ${pageMatchIds.length} (cursor=${cursorNum ?? "-"}, newest=${pageMatchIds[0] ?? "(none)"})`
  );

  // 5. Fetch match details for the page. Cache hits are instant; misses go
  //    to Riot in parallel batches of 5 to stay under rate limits.
  const matchDetailsById = new Map<string, any>();
  const toFetch: string[] = [];
  for (const id of pageMatchIds) {
    const cached = getCachedMatchDetails(id);
    if (cached) matchDetailsById.set(id, cached);
    else toFetch.push(id);
  }

  const DETAIL_BATCH = 5;
  for (let i = 0; i < toFetch.length; i += DETAIL_BATCH) {
    const batch = toFetch.slice(i, i + DETAIL_BATCH);
    await Promise.all(
      batch.map(async (mid) => {
        const anyPuuid = Array.from(matchToPuuids.get(mid)!)[0];
        const region = puuidToRegion.get(anyPuuid) ?? "EUW";
        try {
          const data = await getMatchDetails(mid, region);
          setCachedMatchDetails(mid, data);
          matchDetailsById.set(mid, data);
        } catch (err) {
          console.error(
            `scout feed: match details fetch failed for ${mid}:`,
            (err as any)?.message ?? err
          );
        }
      })
    );
  }

  // 6. Build FeedItems from match details. One row per (match, owner player).
  type ParticipantSlim = {
    puuid: string;
    summonerName: string | null;
    riotTagline: string | null;
    championName: string | null;
    role: string | null;
    teamId: number | null;
    platform: string | null;
    win: boolean;
    kills: number;
    deaths: number;
    assists: number;
  };

  const ROLE_ORDER: Record<string, number> = {
    TOP: 0,
    JUNGLE: 1,
    MIDDLE: 2,
    BOTTOM: 3,
    UTILITY: 4,
  };

  const items: FeedItem[] = [];

  for (const mid of pageMatchIds) {
    const match = matchDetailsById.get(mid);
    if (!match?.info) continue;

    const info = match.info;
    const platform = mid.split("_")[0] ?? null;

    // Normalize duration (Riot sometimes returns it in ms)
    let durationSec = info.gameDuration ?? 0;
    if (durationSec > 100_000) durationSec = Math.floor(durationSec / 1000);

    const gameStart =
      info.gameStartTimestamp ?? info.gameCreation ?? 0;
    const gameCreationIso = gameStart
      ? new Date(gameStart).toISOString()
      : new Date().toISOString();

    // All 10 participants for the scoreboard
    const rawPlayers = info.participants ?? [];
    const allParticipants: ParticipantSlim[] = rawPlayers
      .map((p: any) => ({
        puuid: p.puuid,
        summonerName: p.riotIdGameName ?? p.summonerName ?? null,
        riotTagline: p.riotIdTagline ?? null,
        championName: p.championName ?? null,
        role: p.teamPosition || p.individualPosition || null,
        teamId: p.teamId ?? null,
        platform,
        win: !!p.win,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        assists: p.assists ?? 0,
      }))
      .sort((a: any, b: any) => {
        const t = (a.teamId ?? 0) - (b.teamId ?? 0);
        if (t !== 0) return t;
        const ra = ROLE_ORDER[(a.role ?? "").toUpperCase()] ?? 99;
        const rb = ROLE_ORDER[(b.role ?? "").toUpperCase()] ?? 99;
        if (ra !== rb) return ra - rb;
        return (a.championName ?? "").localeCompare(b.championName ?? "");
      });

    // Which lobby players are in this match? Dedupe by playerId.
    const matchPuuids = Array.from(matchToPuuids.get(mid) ?? []);
    const lobbyPlayers: Array<LobbyPlayerInfo & { accountPuuid: string }> = [];
    const seenPlayerIds = new Set<string>();
    for (const puuid of matchPuuids) {
      const owners = puuidToPlayers.get(puuid) ?? [];
      for (const o of owners) {
        if (!seenPlayerIds.has(o.playerId)) {
          seenPlayerIds.add(o.playerId);
          lobbyPlayers.push({ ...o, accountPuuid: puuid });
        }
      }
    }

    // One FeedItem per (match, owner player). If a player has 2 accounts in
    // the same game (rare), the first owner gets the row.
    for (const owner of lobbyPlayers) {
      const me = rawPlayers.find((p: any) => p.puuid === owner.accountPuuid);
      if (!me) continue;

      items.push({
        rowId: `${mid}:${owner.playerId}`,
        matchId: mid,
        ownerPlayerId: owner.playerId,
        queueId: info.queueId ?? null,
        gameCreation: gameCreationIso,
        gameDurationSeconds: durationSec,
        platform,
        participant: {
          puuid: me.puuid,
          summonerName: me.riotIdGameName ?? me.summonerName ?? null,
          teamId: me.teamId ?? null,
          championId: me.championId ?? null,
          championName: me.championName ?? null,
          role: me.teamPosition || me.individualPosition || null,
          win: !!me.win,
          kills: me.kills ?? 0,
          deaths: me.deaths ?? 0,
          assists: me.assists ?? 0,
          goldEarned: me.goldEarned ?? 0,
          totalDamageToChampions: me.totalDamageDealtToChampions ?? 0,
          visionScore: me.visionScore ?? 0,
          items: [
            me.item0,
            me.item1,
            me.item2,
            me.item3,
            me.item4,
            me.item5,
            me.item6,
          ].map((x: any) => x ?? 0),
          perkPrimaryStyle: me.perks?.styles?.[0]?.style ?? null,
          perkSubStyle: me.perks?.styles?.[1]?.style ?? null,
          perkKeystone:
            me.perks?.styles?.[0]?.selections?.[0]?.perk ?? null,
          lpDelta: null,
          rankChange: null,
          rankAfter: null,
        },
        allParticipants,
        lobbyPlayers,
        lobbyAccountPuuidsInMatch: matchPuuids,
      });
    }
  }

  // Already sorted by mid order which is numeric desc = newest first.
  // Stabilize ties by ownerPlayerId.
  items.sort((a, b) => {
    const t =
      new Date(b.gameCreation).getTime() - new Date(a.gameCreation).getTime();
    if (t !== 0) return t;
    return a.ownerPlayerId.localeCompare(b.ownerPlayerId);
  });

  // ─── LP delta per match ──────────────────────────────────────────────
  // For each (puuid, queue) we have a time-ordered list of rank snapshots.
  // For an item, find the snapshot taken right after that match — preferred
  // by match_id (snapshot fired by ingestSingleMatch), fallback to taken_at
  // closest after the game end. Pair with the previous snapshot to compute
  // the delta. Tier+division change → flag promotion/demotion instead of LP.
  const puuidsNeedingSnap = new Set<string>();
  for (const it of items) {
    if (it.queueId === 420 || it.queueId === 440) {
      puuidsNeedingSnap.add(it.participant.puuid);
    }
  }
  if (puuidsNeedingSnap.size > 0) {
    const { data: snapRows } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select(
        "puuid, queue_type, tier, rank_division, lp, taken_at, match_id"
      )
      .in("puuid", Array.from(puuidsNeedingSnap))
      .in("queue_type", ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"])
      .order("taken_at", { ascending: true });

    type Snap = {
      tier: string;
      rank_division: string | null;
      lp: number;
      taken_at: string;
      match_id: string | null;
    };
    const snapsByKey = new Map<string, Snap[]>();
    for (const s of (snapRows ?? []) as any[]) {
      const key = `${s.puuid}|${s.queue_type}`;
      if (!snapsByKey.has(key)) snapsByKey.set(key, []);
      snapsByKey.get(key)!.push({
        tier: s.tier,
        rank_division: s.rank_division ?? null,
        lp: Number(s.lp ?? 0),
        taken_at: s.taken_at,
        match_id: s.match_id ?? null,
      });
    }

    for (const it of items) {
      const qt =
        it.queueId === 420
          ? "RANKED_SOLO_5x5"
          : it.queueId === 440
            ? "RANKED_FLEX_SR"
            : null;
      if (!qt) continue;
      const list = snapsByKey.get(`${it.participant.puuid}|${qt}`);
      if (!list || list.length < 2) continue;

      // Find post-match snapshot: prefer match_id link, fallback to taken_at
      // immediately after match end.
      let afterIdx = list.findIndex((s) => s.match_id === it.matchId);
      if (afterIdx === -1) {
        const gameEndMs =
          new Date(it.gameCreation).getTime() +
          (it.gameDurationSeconds ?? 0) * 1000;
        // First snapshot with taken_at >= gameEnd
        afterIdx = list.findIndex(
          (s) => new Date(s.taken_at).getTime() >= gameEndMs
        );
      }
      if (afterIdx <= 0) continue; // need a snapshot before it too

      const before = list[afterIdx - 1];
      const after = list[afterIdx];

      const sameTierDiv =
        before.tier === after.tier &&
        before.rank_division === after.rank_division;

      if (sameTierDiv) {
        it.participant.lpDelta = after.lp - before.lp;
      } else {
        const beforeScore = ladderScore(
          before.tier,
          before.rank_division,
          before.lp
        );
        const afterScore = ladderScore(
          after.tier,
          after.rank_division,
          after.lp
        );
        it.participant.rankChange =
          afterScore > beforeScore ? "PROMOTION" : "DEMOTION";
        it.participant.rankAfter = {
          tier: after.tier,
          division: after.rank_division,
        };
      }
    }
  }

  // Cursor for next page = numeric ID of last match in this page.
  const lastMid = pageMatchIds[pageMatchIds.length - 1];
  const nextCursor =
    hasMore && lastMid ? String(numericMatchId(lastMid)) : null;

  // Fire-and-forget: keep DB stats fresh in background. Doesn't block the
  // response. Snapshots run on lobby refresh, not here.
  for (const puuid of allPuuids) {
    const region = puuidToRegion.get(puuid)!;
    ingestQuickThenBackground(puuid, region).catch(() => {});
  }

  return Response.json({ items, nextCursor });
}

// ─── PATCH /api/scout/lobby/:slug ───────────────────────────────────────
// Replace the lobby's player+account list. Auth: must be the owner (login
// match on owner_user_id) OR provide ?key=<ownerKey> matching the row.
// Replaces players atomically — deletes all existing then re-inserts.
export async function updateScoutLobbyHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // 1. Auth check — owner key OR logged-in owner_user_id
  const url = new URL(req.url);
  const providedKey = url.searchParams.get("key");

  const { data: lobby, error: lobbyErr } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug, owner_key, owner_user_id, name")
    .eq("slug", slug)
    .maybeSingle();
  if (lobbyErr || !lobby) {
    return Response.json({ error: "Lobby not found" }, { status: 404 });
  }

  const userId = await getAuthUserId(req);
  const isOwnerByUser = !!userId && userId === lobby.owner_user_id;
  const isOwnerByKey = !!providedKey && providedKey === lobby.owner_key;
  if (!isOwnerByUser && !isOwnerByKey) {
    return Response.json({ error: "Not authorized" }, { status: 403 });
  }

  // 2. Validate body — same shape as create
  let body: CreateLobbyBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (name.length > 80)
    return Response.json({ error: "name too long" }, { status: 400 });

  const players = Array.isArray(body.players) ? body.players : [];
  if (players.length === 0) {
    return Response.json({ error: "At least one player is required" }, { status: 400 });
  }
  if (players.length > MAX_PLAYERS_PER_LOBBY) {
    return Response.json(
      { error: `Max ${MAX_PLAYERS_PER_LOBBY} players per lobby` },
      { status: 400 }
    );
  }
  for (const p of players) {
    const dn = (p.displayName ?? "").trim();
    if (!dn) return Response.json({ error: "Player displayName required" }, { status: 400 });
    if (dn.length > 40)
      return Response.json({ error: "Player displayName too long" }, { status: 400 });
    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    if (accounts.length === 0) {
      return Response.json({ error: `Player "${dn}" has no accounts` }, { status: 400 });
    }
    if (accounts.length > MAX_ACCOUNTS_PER_PLAYER) {
      return Response.json(
        { error: `Max ${MAX_ACCOUNTS_PER_PLAYER} accounts per player` },
        { status: 400 }
      );
    }
    for (const a of accounts) {
      if (!a.puuid || !a.region || !a.riotName || !a.riotTag) {
        return Response.json({ error: "Account is missing required fields" }, { status: 400 });
      }
    }
  }

  // 3. Update lobby name
  await supabaseAdmin
    .from("scout_lobbies")
    .update({
      name,
      is_public: body.isPublic !== false,
    })
    .eq("slug", slug);

  // 4. Wipe + re-insert players. ON DELETE CASCADE removes their accounts.
  await supabaseAdmin
    .from("scout_lobby_players")
    .delete()
    .eq("lobby_slug", slug);

  for (let pIdx = 0; pIdx < players.length; pIdx++) {
    const p = players[pIdx];
    const { data: playerRow, error: playerErr } = await supabaseAdmin
      .from("scout_lobby_players")
      .insert({
        lobby_slug: slug,
        display_name: p.displayName.trim(),
        color: p.color ?? null,
        order_index: pIdx,
      })
      .select("id")
      .single();
    if (playerErr || !playerRow) {
      console.error("scout update: player insert error:", playerErr);
      return Response.json({ error: "Failed to update players" }, { status: 500 });
    }

    const accountRows = p.accounts.map((a, aIdx) => ({
      lobby_player_id: playerRow.id,
      puuid: a.puuid,
      region: a.region.toUpperCase(),
      riot_name: a.riotName,
      riot_tag: a.riotTag,
      is_primary: aIdx === 0,
      order_index: aIdx,
    }));
    const { error: accErr } = await supabaseAdmin
      .from("scout_lobby_accounts")
      .insert(accountRows);
    if (accErr) {
      console.error("scout update: accounts insert error:", accErr);
      return Response.json({ error: "Failed to update accounts" }, { status: 500 });
    }
  }

  // 5. Kick ingestion + baseline snapshot for every account (covers any
  //    newly-added accounts; existing ones get fresh data too).
  for (const p of players) {
    for (const a of p.accounts) {
      ingestQuickThenBackground(a.puuid, a.region).catch((e) =>
        console.error(`scout update ingest error for ${a.puuid}:`, e)
      );
      writeRankSnapshot(a.puuid, a.region).catch((e) =>
        console.error(`scout update snapshot error for ${a.puuid}:`, e)
      );
    }
  }

  return Response.json({ slug, ok: true });
}

// ─── POST /api/scout/refresh/:slug ──────────────────────────────────────
// Triggers Riot match ingestion for every puuid in the lobby, then bumps
// `last_refresh_at`. No backend rate limit — ingestQuickThenBackground is
// idempotent (skips already-ingested matches) so spam-clicking is cheap.
// The frontend has its own 5s click debounce.
//
// Public — anyone with the slug can trigger a refresh (cheap, capped by
// Riot quota). If a lobby grows we may want auth here.

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min — must match frontend

export async function refreshScoutLobbyHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // 1. Verify lobby exists.
  const { data: lobbyRow, error: lobbyErr } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug")
    .eq("slug", slug)
    .maybeSingle();
  if (lobbyErr || !lobbyRow) {
    return Response.json({ error: "Lobby not found" }, { status: 404 });
  }

  // 2. Resolve all account puuids+region for ingestion.
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select("puuid, region, scout_lobby_players!inner(lobby_slug)")
    .eq("scout_lobby_players.lobby_slug", slug);

  if (accErr) {
    console.error("scout refresh: account lookup error:", accErr);
    return Response.json({ error: "Failed to read accounts" }, { status: 500 });
  }

  // Await ingestion (parallel) so freshly-played matches are in DB by the
  // time the frontend refetches. Capped at 15s — if Riot is slow we return
  // anyway and the remaining work continues in background.
  const REFRESH_TIMEOUT_MS = 15_000;
  type PerAccountResult = {
    puuid: string;
    region: string;
    riotMatchIdsSeen: number;
    topMatchIdsFromRiot: string[];
    existingInDb: number;
    newIngested: number;
    riotError?: string;
    timedOut?: boolean;
    error?: string;
  };
  const accountList = (accounts ?? []) as any[];
  const perAccountResults: PerAccountResult[] = accountList.map((a) => ({
    puuid: a.puuid,
    region: a.region,
    riotMatchIdsSeen: 0,
    topMatchIdsFromRiot: [],
    existingInDb: 0,
    newIngested: 0,
    timedOut: true, // optimistically set; flipped to false when result lands
  }));

  const ingestionTasks = accountList.map((a, idx) =>
    ingestQuickThenBackground(a.puuid, a.region)
      .then((res) => {
        const slot = perAccountResults[idx];
        slot.riotMatchIdsSeen = res.riotMatchIdsSeen;
        slot.topMatchIdsFromRiot = res.topMatchIdsFromRiot;
        slot.existingInDb = res.existingInDb;
        slot.newIngested = res.newIngested;
        if (res.riotError) slot.riotError = res.riotError;
        slot.timedOut = false;
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `scout refresh: ingest error for ${String(a.puuid).slice(0, 8)}…:`,
          msg
        );
        perAccountResults[idx].error = msg;
        perAccountResults[idx].timedOut = false;
      })
  );
  // Rank snapshots are fast (one Riot call each, no per-match fetches) —
  // keep them fire-and-forget alongside.
  for (const a of accountList) {
    writeRankSnapshot(a.puuid, a.region).catch((e) =>
      console.error(
        `scout refresh: snapshot error for ${String(a.puuid).slice(0, 8)}…:`,
        e
      )
    );
  }

  const timeoutMark = Symbol("timeout");
  const raced = await Promise.race([
    Promise.all(ingestionTasks).then(() => "done" as const),
    new Promise((resolve) =>
      setTimeout(() => resolve(timeoutMark), REFRESH_TIMEOUT_MS)
    ),
  ]);
  const timedOut = raced === timeoutMark;
  if (timedOut) {
    console.warn(
      `scout refresh ${slug}: ingestion timed out after ${REFRESH_TIMEOUT_MS}ms — continuing in background`
    );
  }

  // Summary log so we can see in the backend terminal what happened.
  const totalNew = perAccountResults.reduce((s, r) => s + r.newIngested, 0);
  const totalSeen = perAccountResults.reduce((s, r) => s + r.riotMatchIdsSeen, 0);
  console.log(
    `🔄 scout refresh ${slug}: ${accountList.length} accounts, riotIds=${totalSeen}, newIngested=${totalNew}${timedOut ? " (TIMED OUT)" : ""}`
  );

  const newTs = new Date().toISOString();
  const { error: updErr } = await supabaseAdmin
    .from("scout_lobbies")
    .update({ last_refresh_at: newTs })
    .eq("slug", slug);

  if (updErr) {
    const msg = (updErr as any).message ?? String(updErr);
    console.error("scout refresh: last_refresh_at update failed:", msg);
    const isMissingColumn =
      /column .* does not exist/i.test(msg) ||
      (updErr as any).code === "42703";
    return Response.json(
      {
        error: isMissingColumn
          ? "Missing column scout_lobbies.last_refresh_at — run migration: ALTER TABLE scout_lobbies ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ NULL;"
          : `Failed to update last_refresh_at: ${msg}`,
      },
      { status: 500 }
    );
  }

  return Response.json({
    lastRefreshAt: newTs,
    nextRefreshAt: new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString(),
    skipped: false,
    accountsRefreshed: accountList.length,
    ingestionTimedOut: timedOut,
    perAccount: perAccountResults.map((r) => ({
      puuid: r.puuid.slice(0, 8) + "…",
      region: r.region,
      riotMatchIdsSeen: r.riotMatchIdsSeen,
      topMatchIdsFromRiot: r.topMatchIdsFromRiot,
      existingInDb: r.existingInDb,
      newIngested: r.newIngested,
      ...(r.riotError ? { riotError: r.riotError } : {}),
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
  });
}

// ─── GET /api/scout/lobby/:slug ─────────────────────────────────────────
// Public read. Returns the lobby + nested players + accounts.
// owner_key + password_hash are stripped from the response.
export async function readScoutLobbyHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const { data: lobby, error: lobbyErr } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug, name, is_public, created_at, last_active_at, last_refresh_at, owner_user_id")
    .eq("slug", slug)
    .maybeSingle();

  if (lobbyErr) {
    console.error("scout_lobbies read error:", lobbyErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!lobby) return Response.json({ error: "Not found" }, { status: 404 });

  const { data: players, error: playersErr } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, order_index, scout_lobby_accounts(id, puuid, region, riot_name, riot_tag, is_primary, order_index)"
    )
    .eq("lobby_slug", slug)
    .order("order_index", { ascending: true });

  if (playersErr) {
    console.error("scout_lobby_players read error:", playersErr);
    return Response.json({ error: "Failed to read players" }, { status: 500 });
  }

  // Sort accounts within each player by order_index
  const normalizedPlayers = (players ?? []).map((p: any) => ({
    id: p.id,
    displayName: p.display_name,
    color: p.color,
    orderIndex: p.order_index,
    accounts: (p.scout_lobby_accounts ?? [])
      .sort((a: any, b: any) => a.order_index - b.order_index)
      .map((a: any) => ({
        id: a.id,
        puuid: a.puuid,
        region: a.region,
        riotName: a.riot_name,
        riotTag: a.riot_tag,
        isPrimary: a.is_primary,
        orderIndex: a.order_index,
      })),
  }));

  // Enrich each player with a profile icon. We pick the primary account's
  // puuid (fallback: first account) and look up icon_id from the cached
  // users table. Best-effort — if missing, frontend falls back to a default.
  const primaryPuuids = normalizedPlayers
    .map((p) => {
      const primary = p.accounts.find((a: any) => a.isPrimary) ?? p.accounts[0];
      return primary?.puuid as string | undefined;
    })
    .filter(Boolean) as string[];

  let iconByPuuid = new Map<string, number | null>();
  if (primaryPuuids.length > 0) {
    const { data: iconRows } = await supabaseAdmin
      .from("users")
      .select("puuid, icon_id")
      .in("puuid", primaryPuuids);
    for (const r of iconRows ?? []) {
      iconByPuuid.set(r.puuid, r.icon_id ?? null);
    }
  }

  const playersWithIcon = normalizedPlayers.map((p) => {
    const primary = p.accounts.find((a: any) => a.isPrimary) ?? p.accounts[0];
    const iconId = primary ? iconByPuuid.get(primary.puuid) ?? null : null;
    return { ...p, iconId };
  });

  // Bump last_active_at (fire-and-forget)
  supabaseAdmin
    .from("scout_lobbies")
    .update({ last_active_at: new Date().toISOString() })
    .eq("slug", slug)
    .then(() => {});

  return Response.json({
    slug: lobby.slug,
    name: lobby.name,
    isPublic: lobby.is_public,
    createdAt: lobby.created_at,
    lastActiveAt: lobby.last_active_at,
    lastRefreshAt: lobby.last_refresh_at ?? null,
    ownerUserId: lobby.owner_user_id ?? null,
    players: playersWithIcon,
  });
}
