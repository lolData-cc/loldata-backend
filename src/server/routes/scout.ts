// src/server/routes/scout.ts
// Scout / Feed lobbies — shareable groups of up to 20 players (each with
// up to 3 Riot accounts). Public read by slug, owner-key gated writes.

import { supabaseAdmin } from "../supabase/client";
import { ingestQuickThenBackground } from "../services/matchIngest";
import { writeRankSnapshot, ladderScore, invalidatePuuidLobbyCache, isPuuidInAnyLobby } from "../services/rankSnapshot";
import {
  getAccountByPuuid,
  getLiveGameByPuuid,
  getMatchDetails,
  getMatchIdsByPuuidOpts,
} from "../riot";
import { getCurrentSeasonWindow } from "../season";

// ─── constants ─────────────────────────────────────────────────────────
const MAX_PLAYERS_PER_LOBBY = 20;
const MAX_ACCOUNTS_PER_PLAYER = 3;
const SLUG_LENGTH = 7;
const OWNER_KEY_LENGTH = 32;

// Per-plan lobby limits — free users 3, premium (a.k.a. PRO) 5, elite 10.
// Reads `profile_players.plan`: null/"free" → free tier.
const LOBBY_LIMITS: Record<"free" | "premium" | "elite", number> = {
  free: 3,
  premium: 5,
  elite: 10,
};

type PlanTier = "free" | "premium" | "elite";

function normalizePlan(planRaw: string | null | undefined): PlanTier {
  const p = (planRaw ?? "").toLowerCase();
  if (p === "premium" || p === "elite") return p;
  return "free";
}

/** Fetch the lobby quota for a user given their plan. */
async function getLobbyQuota(userId: string): Promise<{
  plan: PlanTier;
  used: number;
  limit: number;
}> {
  const { data: profile } = await supabaseAdmin
    .from("profile_players")
    .select("plan")
    .eq("profile_id", userId)
    .maybeSingle();
  const plan = normalizePlan(profile?.plan ?? null);

  const { count } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug", { count: "exact", head: true })
    .eq("owner_user_id", userId);

  return { plan, used: count ?? 0, limit: LOBBY_LIMITS[plan] };
}
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
  /** Existing scout_lobby_players.id when updating an existing row.
   *  Null/omitted when adding a fresh player. Used by the PATCH
   *  handler to do diff-based updates so claim + verify state on
   *  the row survives the edit. */
  id?: string | null;
  displayName: string;
  color?: string | null;
  accounts: AccountInput[];
};

type CreateLobbyBody = {
  name: string;
  isPublic?: boolean;
  password?: string | null;
  heroChampion?: string | null;
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

  // ─── Plan quota check ────────────────────────────────────────────────
  // Free: 3, Premium (PRO): 5, Elite: 10.
  const quota = await getLobbyQuota(userId);
  if (quota.used >= quota.limit) {
    return Response.json(
      {
        error: `Lobby limit reached (${quota.used}/${quota.limit} on the ${quota.plan} plan)`,
        plan: quota.plan,
        used: quota.used,
        limit: quota.limit,
        upgradeHint:
          quota.plan === "free"
            ? "Upgrade to PRO for 5 lobbies, or Elite for 10."
            : quota.plan === "premium"
              ? "Upgrade to Elite for 10 lobbies."
              : null,
      },
      { status: 403 }
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
    hero_champion: body.heroChampion?.trim() || null,
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
  //
  // We also invalidate the "is this puuid in any lobby?" cache for each
  // new puuid — otherwise the next post-match snapshotIfTracked() could
  // hit a stale `false` entry (from when this puuid wasn't tracked) and
  // silently skip the snapshot for up to PUUID_LOBBY_TTL.
  for (const p of players) {
    for (const a of p.accounts) {
      invalidatePuuidLobbyCache(a.puuid);
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

// ─── GET /api/scout/my-lobbies ──────────────────────────────────────────
// Returns the authenticated user's lobbies + quota. Used by the dashboard
// to render the SCOUT tab with the create button gated on the limit.
export async function readMyScoutLobbiesHandler(
  req: Request
): Promise<Response> {
  const userId = await getAuthUserId(req);
  if (!userId) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }

  const quota = await getLobbyQuota(userId);

  // Fetch lobbies + a count of unique players per lobby (for the card preview).
  const { data: lobbies, error } = await supabaseAdmin
    .from("scout_lobbies")
    .select(
      "slug, name, created_at, last_active_at, last_refresh_at, is_public, scout_lobby_players(id)"
    )
    .eq("owner_user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("scout my-lobbies read error:", error);
    return Response.json({ error: "Failed to read lobbies" }, { status: 500 });
  }

  const items = (lobbies ?? []).map((l: any) => ({
    slug: l.slug,
    name: l.name,
    isPublic: l.is_public,
    createdAt: l.created_at,
    lastActiveAt: l.last_active_at,
    lastRefreshAt: l.last_refresh_at,
    playerCount: Array.isArray(l.scout_lobby_players)
      ? l.scout_lobby_players.length
      : 0,
  }));

  return Response.json({
    plan: quota.plan,
    used: quota.used,
    limit: quota.limit,
    canCreate: quota.used < quota.limit,
    lobbies: items,
  });
}

// ─── GET /api/scout/live/:slug ──────────────────────────────────────────
// Returns every lobby player currently in-game (Spectator-v5 lookup per
// puuid). One LiveSession per player + account that's live. Frontend
// polls this every ~30s. We cache aggressively per-puuid (10s) so a
// hammering polling loop doesn't burn Riot quota.
type LiveParticipantSlim = {
  puuid: string;
  championId: number;
  summonerName: string | null;
  teamId: number;
  isLobbyMember: boolean;
  lobbyPlayerId: string | null; // populated when isLobbyMember
  spell1Id: number;             // summoner spell 1 (e.g. flash)
  spell2Id: number;             // summoner spell 2
  keystoneId: number | null;    // primary rune keystone
  primaryStyleId: number | null; // primary rune tree (for tooltip)
  subStyleId: number | null;     // secondary rune tree
};
type LiveSession = {
  // Identity of which lobby player + account is in game.
  playerId: string;
  displayName: string;
  color: string | null;
  iconId: number | null;
  accountPuuid: string;
  region: string;
  riotName: string;
  riotTag: string;
  // Game info from Spectator API.
  gameId: number;
  gameQueueConfigId: number;
  gameMode: string;
  gameType: string;
  gameStartTime: number; // epoch ms (0 = not started yet)
  gameLength: number;     // seconds
  mapId: number;
  // Player's own pick.
  championId: number;
  // All 10 (or fewer for ARAM remakes) participants.
  participants: LiveParticipantSlim[];
  // Banned champions per team (pickTurn order preserved). Empty for modes
  // without bans (ARAM, URF, etc).
  bansBlue: number[];
  bansRed: number[];
};

const LIVE_CACHE = new Map<
  string,
  { value: any; ts: number }
>(); // key = puuid
const LIVE_TTL_MS = 10_000;
const LIVE_TTL_NEGATIVE_MS = 25_000; // negative cache: don't re-poll "not in game" too aggressively

export async function readScoutLiveHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // 1. Lobby accounts + player metadata.
  const { data: playerRows, error: playerErr } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, order_index, scout_lobby_accounts(puuid, region, riot_name, riot_tag, is_primary, order_index)"
    )
    .eq("lobby_slug", slug)
    .order("order_index", { ascending: true });

  if (playerErr) {
    console.error("scout live: lobby read error:", playerErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!playerRows || playerRows.length === 0) {
    return Response.json({ sessions: [], polledAt: Date.now() });
  }

  // Flat list of (player, account) to poll.
  type Probe = {
    playerId: string;
    displayName: string;
    color: string | null;
    primaryPuuid: string;
    accountPuuid: string;
    region: string;
    riotName: string;
    riotTag: string;
  };
  const probes: Probe[] = [];
  const allLobbyPuuids = new Set<string>();
  for (const p of playerRows as any[]) {
    const accounts = (p.scout_lobby_accounts ?? []) as any[];
    accounts.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    const primary = accounts.find((a) => a.is_primary) ?? accounts[0];
    if (!primary) continue;
    for (const a of accounts) {
      allLobbyPuuids.add(a.puuid);
      probes.push({
        playerId: p.id,
        displayName: p.display_name,
        color: p.color ?? null,
        primaryPuuid: primary.puuid,
        accountPuuid: a.puuid,
        region: a.region,
        riotName: a.riot_name,
        riotTag: a.riot_tag,
      });
    }
  }

  // Map puuid → owning lobby player id so we can mark participants in the
  // game that belong to the same lobby (rare but possible squad games).
  const puuidToLobbyPlayerId = new Map<string, string>();
  for (const p of probes) {
    puuidToLobbyPlayerId.set(p.accountPuuid, p.playerId);
  }

  // 2. Poll Spectator API per puuid (parallel). Cached for LIVE_TTL_MS.
  async function fetchLive(puuid: string, region: string): Promise<any> {
    const cached = LIVE_CACHE.get(puuid);
    if (cached) {
      const age = Date.now() - cached.ts;
      const isNeg = cached.value === null;
      if ((isNeg && age < LIVE_TTL_NEGATIVE_MS) || (!isNeg && age < LIVE_TTL_MS)) {
        return cached.value;
      }
    }
    try {
      const data = await getLiveGameByPuuid(puuid, region);
      LIVE_CACHE.set(puuid, { value: data, ts: Date.now() });
      return data;
    } catch (e) {
      console.error(
        `scout live: Spectator fetch failed for ${puuid.slice(0, 8)}…:`,
        (e as any)?.message ?? e
      );
      return null;
    }
  }

  const probeResults = await Promise.all(
    probes.map((p) =>
      fetchLive(p.accountPuuid, p.region).then((game) => ({ probe: p, game }))
    )
  );

  // 3. Avatar lookups for lobby players (use primary puuid).
  const iconByPuuid = new Map<string, number | null>();
  {
    const primaries = Array.from(new Set(probes.map((p) => p.primaryPuuid)));
    if (primaries.length > 0) {
      const { data: iconRows } = await supabaseAdmin
        .from("users")
        .select("puuid, icon_id")
        .in("puuid", primaries);
      for (const r of iconRows ?? []) iconByPuuid.set(r.puuid, r.icon_id ?? null);
    }
  }

  // 4. Build LiveSession[] — one entry per (player, account) currently in
  //    a game. Dedupe by gameId+playerId so a squad game isn't reported
  //    five times.
  const sessions: LiveSession[] = [];
  const seen = new Set<string>(); // gameId:playerId
  for (const { probe, game } of probeResults) {
    if (!game || typeof game.gameId !== "number") continue;
    const dedupeKey = `${game.gameId}:${probe.playerId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const participants: LiveParticipantSlim[] = (game.participants ?? []).map(
      (p: any) => ({
        puuid: p.puuid,
        championId: p.championId,
        summonerName: p.riotId
          ? String(p.riotId).split("#")[0]
          : p.summonerName ?? null,
        teamId: p.teamId,
        isLobbyMember: allLobbyPuuids.has(p.puuid),
        lobbyPlayerId: puuidToLobbyPlayerId.get(p.puuid) ?? null,
        spell1Id: Number(p.spell1Id ?? 0),
        spell2Id: Number(p.spell2Id ?? 0),
        keystoneId: p.perks?.perkIds?.[0] ?? null,
        primaryStyleId: p.perks?.perkStyle ?? null,
        subStyleId: p.perks?.perkSubStyle ?? null,
      })
    );

    const me = participants.find((p) => p.puuid === probe.accountPuuid);

    // Bans — split by teamId, preserve pickTurn order.
    const banned = (game.bannedChampions ?? []) as Array<{
      championId: number;
      teamId: number;
      pickTurn: number;
    }>;
    const sortedBans = [...banned].sort(
      (a, b) => (a.pickTurn ?? 0) - (b.pickTurn ?? 0)
    );
    const bansBlue = sortedBans
      .filter((b) => b.teamId === 100 && b.championId > 0)
      .map((b) => b.championId);
    const bansRed = sortedBans
      .filter((b) => b.teamId === 200 && b.championId > 0)
      .map((b) => b.championId);

    sessions.push({
      playerId: probe.playerId,
      displayName: probe.displayName,
      color: probe.color,
      iconId: iconByPuuid.get(probe.primaryPuuid) ?? null,
      accountPuuid: probe.accountPuuid,
      region: probe.region,
      riotName: probe.riotName,
      riotTag: probe.riotTag,
      gameId: game.gameId,
      gameQueueConfigId: game.gameQueueConfigId ?? 0,
      gameMode: game.gameMode ?? "",
      gameType: game.gameType ?? "",
      gameStartTime: game.gameStartTime ?? 0,
      gameLength: game.gameLength ?? 0,
      mapId: game.mapId ?? 0,
      championId: me?.championId ?? 0,
      participants,
      bansBlue,
      bansRed,
    });
  }

  return Response.json({
    sessions,
    polledAt: Date.now(),
  });
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
  // Per-account champion breakdown, keyed by puuid. Lets the frontend
  // render an account switcher so the user can flip between e.g. "main"
  // and "smurf" stats without a separate request.
  perAccount: Record<string, ChampionLine[]>;
};

export async function readScoutChampionsHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const window = url.searchParams.get("window") ?? "all";
  const windowIso = windowStartIso(window);

  // Always clamp to lobby creation so champions counted in the lobby's
  // history don't include matches that predate the lobby itself.
  const { data: lobbyMeta } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  const lobbyCreatedIso = lobbyMeta?.created_at
    ? new Date(lobbyMeta.created_at).toISOString()
    : null;
  // Use the LATER of the requested window start and the lobby creation.
  const startIso =
    windowIso && lobbyCreatedIso
      ? windowIso > lobbyCreatedIso
        ? windowIso
        : lobbyCreatedIso
      : (windowIso ?? lobbyCreatedIso);

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

  // Two passes through the rows:
  //   (1) per-player aggregate (the "All accounts" view) — dedupes by
  //       playerId:matchId so the rare case of a single player having two
  //       linked accounts in the same match doesn't double-count.
  //   (2) per-account aggregate (each puuid's own stats) — dedupes by
  //       puuid:matchId so each account's own history is independent.
  const seenPlayer = new Set<string>();
  const aggPlayer = new Map<
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

  const seenAccount = new Set<string>();
  const aggAccount = new Map<
    string,
    {
      puuid: string;
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

    // Player-level aggregate
    const playerSeenKey = `${owner.id}:${r.match_id}`;
    if (!seenPlayer.has(playerSeenKey)) {
      seenPlayer.add(playerSeenKey);
      const pKey = `${owner.id}::${champ}`;
      if (!aggPlayer.has(pKey)) {
        aggPlayer.set(pKey, {
          playerId: owner.id,
          champion: champ,
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
        });
      }
      const a = aggPlayer.get(pKey)!;
      a.games += 1;
      if (r.win) a.wins += 1;
      a.kills += r.kills ?? 0;
      a.deaths += r.deaths ?? 0;
      a.assists += r.assists ?? 0;
    }

    // Per-account aggregate
    const accountSeenKey = `${r.puuid}:${r.match_id}`;
    if (!seenAccount.has(accountSeenKey)) {
      seenAccount.add(accountSeenKey);
      const aKey = `${r.puuid}::${champ}`;
      if (!aggAccount.has(aKey)) {
        aggAccount.set(aKey, {
          puuid: r.puuid,
          champion: champ,
          games: 0,
          wins: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
        });
      }
      const a = aggAccount.get(aKey)!;
      a.games += 1;
      if (r.win) a.wins += 1;
      a.kills += r.kills ?? 0;
      a.deaths += r.deaths ?? 0;
      a.assists += r.assists ?? 0;
    }
  }

  function toLine(a: {
    champion: string;
    games: number;
    wins: number;
    kills: number;
    deaths: number;
    assists: number;
  }): ChampionLine {
    const avgKda =
      a.deaths === 0
        ? Math.min(99, a.kills + a.assists)
        : (a.kills + a.assists) / a.deaths;
    return {
      champion: a.champion,
      games: a.games,
      wins: a.wins,
      winrate: a.games > 0 ? Math.round((a.wins / a.games) * 100) : 0,
      kills: a.kills,
      deaths: a.deaths,
      assists: a.assists,
      avgKda: Math.round(avgKda * 100) / 100,
    };
  }

  const byPlayer = new Map<string, ChampionLine[]>();
  for (const a of aggPlayer.values()) {
    if (!byPlayer.has(a.playerId)) byPlayer.set(a.playerId, []);
    byPlayer.get(a.playerId)!.push(toLine(a));
  }

  const byAccount = new Map<string, ChampionLine[]>();
  for (const a of aggAccount.values()) {
    if (!byAccount.has(a.puuid)) byAccount.set(a.puuid, []);
    byAccount.get(a.puuid)!.push(toLine(a));
  }

  // Reverse lookup: playerId → puuids that belong to it (from the lobby
  // membership map we already built above).
  const puuidsByPlayerId = new Map<string, string[]>();
  for (const [puuid, owner] of playerByPuuid.entries()) {
    if (!puuidsByPlayerId.has(owner.id)) puuidsByPlayerId.set(owner.id, []);
    puuidsByPlayerId.get(owner.id)!.push(puuid);
  }

  const out: ChampionsPlayer[] = allPlayers.map((p) => {
    const perAccount: Record<string, ChampionLine[]> = {};
    for (const puuid of puuidsByPlayerId.get(p.id) ?? []) {
      perAccount[puuid] = (byAccount.get(puuid) ?? [])
        .sort((x, y) => y.games - x.games || y.winrate - x.winrate)
        .slice(0, 5);
    }
    return {
      playerId: p.id,
      displayName: p.displayName,
      color: p.color,
      champions: (byPlayer.get(p.id) ?? [])
        .sort((x, y) => y.games - x.games || y.winrate - x.winrate)
        .slice(0, 5),
      perAccount,
    };
  });

  return Response.json({ players: out, window });
}

// ─── GET /api/scout/habits/:slug?window=today|week|all ─────────────────
// Per-player "personality" metrics:
//   - winrate after a loss (do they tilt-queue?)
//   - winrate after a win
//   - longest win streak, longest loss streak
//   - time-of-day distribution (binned into 4 quarters of the day)
type TimeBucket = { games: number; wins: number; winrate: number };
type HabitsPlayer = {
  playerId: string;
  displayName: string;
  color: string | null;
  games: number;
  afterLoss: { games: number; wins: number; winrate: number };
  afterWin: { games: number; wins: number; winrate: number };
  longestWinStreak: number;
  longestLossStreak: number;
  // Each time bucket now carries games + wins + winrate so the frontend
  // can render an exact-WR tooltip on hover.
  timeOfDay: {
    morning: TimeBucket;
    afternoon: TimeBucket;
    evening: TimeBucket;
    night: TimeBucket;
  };
};

function tagTimeOfDay(
  d: Date
): "morning" | "afternoon" | "evening" | "night" {
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
    const todCounts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    const todWins = { morning: 0, afternoon: 0, evening: 0, night: 0 };

    for (let i = 0; i < series.length; i++) {
      const g = series[i];
      const slot = tagTimeOfDay(new Date(g.ts));
      todCounts[slot] += 1;
      if (g.win) todWins[slot] += 1;
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
      timeOfDay: {
        morning: makeTimeBucket(todCounts.morning, todWins.morning),
        afternoon: makeTimeBucket(todCounts.afternoon, todWins.afternoon),
        evening: makeTimeBucket(todCounts.evening, todWins.evening),
        night: makeTimeBucket(todCounts.night, todWins.night),
      },
    });
  }

  return Response.json({ players: out, window });
}

function makeTimeBucket(games: number, wins: number): TimeBucket {
  return {
    games,
    wins,
    winrate: games > 0 ? Math.round((wins / games) * 100) : 0,
  };
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
    .slice(0, 10);

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
  // Longest consecutive-wins streak inside the window. Used by the new
  // "Longest Streak" sidebar widget.
  streak: number;
  // The lobby member this account's player shares the most games with
  // inside the window (same match_id, same team_id, → played together).
  // Populated as the "primary partner" so widgets can add a "+ X" badge
  // when the top entry's stats are largely co-occurring with another
  // lobby player. Null if there's no shared activity.
  primaryPartner: {
    playerId: string;
    displayName: string;
    color: string | null;
    iconId: number | null;
    sharedGames: number;
    sharedWins: number;
  } | null;
};

// Top-of-the-lobby duo aggregates — surfaced separately so the frontend
// can pick "single vs duo" per widget. A duo only wins display when its
// metric strictly exceeds the best individual; on ties the duo wins
// because the shared narrative is more interesting ("Gabri+Isac 7W"
// reads better than just "Isac 7W" when both did it together).
type LeaderboardDuo = {
  playerIdA: string;
  playerIdB: string;
  displayNameA: string;
  displayNameB: string;
  colorA: string | null;
  colorB: string | null;
  iconIdA: number | null;
  iconIdB: number | null;
  sharedGames: number;
  sharedWins: number;
};
type LeaderboardDuoStreak = LeaderboardDuo & { length: number };
type LeaderboardDuoKda = LeaderboardDuo & { avgKda: number };
type LeaderboardDuoWinrate = LeaderboardDuo & { winrate: number };

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

// ─── GET /api/scout/lp-timeline/:slug?period=day|week|month ─────────────
// Returns a per-player LP timeline since lobby creation. For each player,
// computes net LP change per bucket (day / ISO week / month) summed across
// the player's accounts. Used by the LP chart in the Leaderboard tab.
type LpTimelineBucket = { bucketStart: string; label: string };
type LpTimelineAccount = {
  puuid: string;
  region: string;
  riotName: string;
  riotTag: string;
  isPrimary: boolean;
  iconId: number | null;
  // ladderScore per bucket (forward-filled); null before first snapshot.
  scores: (number | null)[];
  finalScore: number | null;
  finalRank: { tier: string; division: string | null; lp: number } | null;
};
type LpTimelinePlayer = {
  playerId: string;
  displayName: string;
  color: string | null;
  // One entry per linked Riot account. Frontend renders one line per
  // account when a single player is isolated; otherwise it shows only
  // the primary account in the multi-player overlay.
  accounts: LpTimelineAccount[];
};

function lpBucketStart(ts: number, period: string): number {
  const d = new Date(ts);
  if (period === "today") {
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours()
    );
  }
  if (period === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  if (period === "week") {
    // ISO week: Monday is day 1.
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (day - 1));
    monday.setUTCHours(0, 0, 0, 0);
    return monday.getTime();
  }
  // day
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function lpAdvanceBucket(ts: number, period: string): number {
  const d = new Date(ts);
  if (period === "today") return ts + 3_600_000;
  if (period === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  if (period === "week") {
    return ts + 7 * 86_400_000;
  }
  return ts + 86_400_000;
}

function lpBucketLabel(ts: number, period: string): string {
  const d = new Date(ts);
  if (period === "today") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  }
  if (period === "month") {
    return d
      .toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
      .toUpperCase();
  }
  if (period === "week") {
    // ISO-ish "Wxx" — number of weeks since epoch's Monday isn't useful, use
    // year-week.
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const wk = Math.floor((d.getTime() - yearStart) / (7 * 86_400_000)) + 1;
    return `W${String(wk).padStart(2, "0")}`;
  }
  return d
    .toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" })
    .toUpperCase();
}

export async function readScoutLpTimelineHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const periodRaw = (url.searchParams.get("period") ?? "day").toLowerCase();
  const period: "today" | "day" | "week" | "month" =
    periodRaw === "today" ||
    periodRaw === "week" ||
    periodRaw === "month"
      ? (periodRaw as any)
      : "day";

  // 1. Lobby + players + accounts
  const { data: lobby } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  if (!lobby) {
    return Response.json({ error: "Lobby not found" }, { status: 404 });
  }
  const sinceTs = new Date(lobby.created_at).getTime();

  const { data: playerRows } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, order_index, scout_lobby_accounts(puuid, is_primary, region, riot_name, riot_tag, order_index)"
    )
    .eq("lobby_slug", slug)
    .order("order_index", { ascending: true });

  if (!playerRows || playerRows.length === 0) {
    return Response.json({ buckets: [], players: [], period });
  }

  // Collect every account (preserves region / name / tag for chip labels).
  type RawAcc = {
    puuid: string;
    region: string;
    riotName: string;
    riotTag: string;
    isPrimary: boolean;
    orderIndex: number;
  };
  const accountsByPlayer = new Map<string, RawAcc[]>();
  const allPuuids: string[] = [];
  for (const p of playerRows as any[]) {
    const list: RawAcc[] = ((p.scout_lobby_accounts ?? []) as any[])
      .map((a) => ({
        puuid: a.puuid,
        region: a.region,
        riotName: a.riot_name,
        riotTag: a.riot_tag,
        isPrimary: !!a.is_primary,
        orderIndex: a.order_index ?? 0,
      }))
      .sort((x, y) => x.orderIndex - y.orderIndex);
    accountsByPlayer.set(p.id, list);
    for (const a of list) allPuuids.push(a.puuid);
  }
  if (allPuuids.length === 0) {
    return Response.json({ buckets: [], players: [], period });
  }

  // Icon lookup for every account so chips can show avatars.
  const iconByPuuid = new Map<string, number | null>();
  {
    const { data: iconRows } = await supabaseAdmin
      .from("users")
      .select("puuid, icon_id")
      .in("puuid", allPuuids);
    for (const r of iconRows ?? []) iconByPuuid.set(r.puuid, r.icon_id ?? null);
  }

  // 3. Pull ALL solo/duo snapshots for the lobby puuids. We want history
  //    from inception (no since-filter) so the chart can show the very
  //    first snapshot — even if it predates the bucket window.
  //
  // Same Supabase row-cap pitfall as the leaderboard: a single
  // .in(puuids).order(taken_at) request silently caps at 1000 rows.
  // For a lobby that has accumulated thousands of snapshots, the
  // chart was missing every datapoint past the first ~1000 across
  // all accounts combined. Fan out per puuid instead.
  type Snap = {
    ts: number;
    score: number;
    tier: string;
    division: string | null;
    lp: number;
  };
  const snapsByPuuid = new Map<string, Snap[]>();
  // PostgREST caps responses at 1000 rows even when .limit(50000) is set,
  // which silently drops the latest snapshots for any puuid that has
  // accumulated more than ~3 days worth of 5-minute periodic samples.
  // Paginate via .range() chunks until a partial page comes back.
  async function fetchAllTimelineSnaps(puuid: string) {
    type Row = {
      puuid: string;
      tier: string;
      rank_division: string | null;
      lp: number;
      taken_at: string;
    };
    const PAGE = 1000;
    const MAX_PAGES = 50;
    const out: Row[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE;
      const to = from + PAGE - 1;
      const { data, error } = await supabaseAdmin
        .from("scout_rank_snapshots")
        .select("puuid, tier, rank_division, lp, taken_at")
        .eq("puuid", puuid)
        .eq("queue_type", "RANKED_SOLO_5x5")
        .order("taken_at", { ascending: true })
        .range(from, to);
      if (error) {
        console.error("lp timeline: snapshot page error:", error.message);
        break;
      }
      const rows = (data ?? []) as Row[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return { data: out };
  }
  const perPuuidTimeline = await Promise.all(
    allPuuids.map(fetchAllTimelineSnaps)
  );
  for (const { data: snapRows } of perPuuidTimeline) {
    for (const s of (snapRows ?? []) as any[]) {
      const arr = snapsByPuuid.get(s.puuid) ?? [];
      arr.push({
        ts: new Date(s.taken_at).getTime(),
        score: ladderScore(s.tier, s.rank_division ?? null, Number(s.lp ?? 0)),
        tier: s.tier,
        division: s.rank_division ?? null,
        lp: Number(s.lp ?? 0),
      });
    snapsByPuuid.set(s.puuid, arr);
    }
  }

  // 4. Generate buckets.
  // - today: 00:00 UTC → current hour (clipped to lobby creation if newer)
  // - day/week/month: lobby creation → today (inclusive)
  const buckets: LpTimelineBucket[] = [];
  const now = Date.now();
  let rangeStartTs = sinceTs;
  if (period === "today") {
    const d = new Date(now);
    const todayMidnight = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate()
    );
    rangeStartTs = Math.max(sinceTs, todayMidnight);
  }
  const startBucketTs = lpBucketStart(rangeStartTs, period);
  const endBucketTs = lpBucketStart(now, period);
  let cursor = startBucketTs;
  while (cursor <= endBucketTs) {
    buckets.push({
      bucketStart: new Date(cursor).toISOString(),
      label: lpBucketLabel(cursor, period),
    });
    cursor = lpAdvanceBucket(cursor, period);
  }

  // Per-bucket end-of-bucket score for ONE puuid. Forward-fills (a bucket
  // with no snapshot inherits the previous value) and returns the final
  // snapshot details for chip rendering.
  function timelineForPuuid(puuid: string): {
    scores: (number | null)[];
    finalScore: number | null;
    finalRank: { tier: string; division: string | null; lp: number } | null;
  } {
    const snaps = snapsByPuuid.get(puuid) ?? [];
    const scores: (number | null)[] = new Array(buckets.length).fill(null);
    if (snaps.length === 0) {
      return { scores, finalScore: null, finalRank: null };
    }
    let lastSnap: Snap | null = null;
    let snapIdx = 0;
    for (let b = 0; b < buckets.length; b++) {
      const bucketEnd =
        b + 1 < buckets.length
          ? new Date(buckets[b + 1].bucketStart).getTime()
          : Number.POSITIVE_INFINITY;
      while (snapIdx < snaps.length && snaps[snapIdx].ts < bucketEnd) {
        lastSnap = snaps[snapIdx];
        snapIdx++;
      }
      scores[b] = lastSnap ? lastSnap.score : null;
    }
    return {
      scores,
      finalScore: scores.length > 0 ? scores[scores.length - 1] : null,
      finalRank: lastSnap
        ? { tier: lastSnap.tier, division: lastSnap.division, lp: lastSnap.lp }
        : null,
    };
  }

  // 5. Build one player object per lobby player, with one timeline per
  //    linked account. Frontend renders the primary by default and lets
  //    the user toggle siblings.
  const players: LpTimelinePlayer[] = (playerRows as any[]).map((p) => {
    const rawAccounts = accountsByPlayer.get(p.id) ?? [];
    const accounts: LpTimelineAccount[] = rawAccounts.map((a) => {
      const tl = timelineForPuuid(a.puuid);
      return {
        puuid: a.puuid,
        region: a.region,
        riotName: a.riotName,
        riotTag: a.riotTag,
        isPrimary: a.isPrimary,
        iconId: iconByPuuid.get(a.puuid) ?? null,
        scores: tl.scores,
        finalScore: tl.finalScore,
        finalRank: tl.finalRank,
      };
    });

    return {
      playerId: p.id,
      displayName: p.display_name,
      color: p.color ?? null,
      accounts,
    };
  });

  return Response.json({ period, buckets, players });
}

export async function readScoutLeaderboardHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  // Window — `?window=today|week|all`. Defaults to all-time. The three
  // sidebar widgets (Player of the Day / Week / All time) were all
  // showing the same numbers because this handler used to ignore the
  // query string entirely and treated everything as "since lobby
  // creation". Now we honor the window AND clamp to lobby creation
  // (you can't have a metric from before the lobby existed).
  const url = new URL(req.url);
  const windowParam = url.searchParams.get("window") ?? "all";
  // Optional client-provided cutoff. The frontend uses this to pass
  // LOCAL midnight for the "today" widget, since the default helper
  // (windowStartIso) anchors on UTC midnight — which puts ~2h of the
  // previous day into "today" for European users right after midnight.
  // If `since` is provided, it overrides the default.
  const sinceParam = url.searchParams.get("since");
  const windowIso = sinceParam ?? windowStartIso(windowParam);

  const { data: lobbyMeta } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  const lobbyCreatedIso = lobbyMeta?.created_at
    ? new Date(lobbyMeta.created_at).toISOString()
    : null;
  const startIso =
    windowIso && lobbyCreatedIso
      ? windowIso > lobbyCreatedIso
        ? windowIso
        : lobbyCreatedIso
      : (windowIso ?? lobbyCreatedIso);

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
  // Dedup by puuid — if for any reason the lobby has two scout_lobby_accounts
  // rows pointing to the same puuid (legacy data, double-create races, etc.)
  // we'd otherwise render two leaderboard rows for the same account.
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
  const seenPuuids = new Set<string>();
  for (const p of players as any[]) {
    for (const a of p.scout_lobby_accounts ?? []) {
      if (seenPuuids.has(a.puuid)) continue;
      seenPuuids.add(a.puuid);
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
  //    Also build a per-puuid chronological match sequence we later use
  //    to compute (a) longest individual win-streak and (b) per-pair
  //    shared streaks — the data the new "Longest Streak" widget needs.
  let q = supabaseAdmin
    .from("participants")
    .select(
      "puuid, match_id, team_id, win, kills, deaths, assists, matches!inner(game_creation, queue_id)"
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
  type SeqEntry = {
    gameCreation: number;   // ms epoch — sortable
    matchId: string;
    teamId: number | null;
    win: boolean;
  };

  const byPuuid = new Map<string, Agg>();
  const seqByPuuid = new Map<string, SeqEntry[]>();
  for (const a of accountList) {
    byPuuid.set(a.puuid, { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 });
    seqByPuuid.set(a.puuid, []);
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

    const seq = seqByPuuid.get(r.puuid);
    if (seq) {
      const gc = r.matches?.game_creation
        ? new Date(r.matches.game_creation).getTime()
        : 0;
      seq.push({
        gameCreation: gc,
        matchId: r.match_id,
        teamId: r.team_id ?? null,
        win: !!r.win,
      });
    }
  }
  // Sort each puuid's sequence oldest → newest for the streak walk.
  for (const seq of seqByPuuid.values()) {
    seq.sort((a, b) => a.gameCreation - b.gameCreation);
  }

  // 4. Snapshot lookups — current rank (latest) + LP delta in window.
  //
  // Important: instead of a single .in(puuids).order(taken_at) query,
  // we fetch the OLDEST and NEWEST snapshot per puuid SEPARATELY with
  // .limit(1) each. The single query approach silently capped at
  // Supabase's default 1000-row response limit, which for lobbies with
  // 10+ accounts × 400+ snapshots each meant `last` was actually the
  // 1000th-oldest row, not the actual newest. Result: balance was 0
  // for accounts whose first ~100 snapshots happened to be at the
  // same LP — which is basically all of them.
  const currentRankByPuuid = new Map<
    string,
    { tier: string; rankDivision: string | null; lp: number; wins: number; losses: number }
  >();
  const balanceByPuuid = new Map<string, number>();
  const windowByPuuid = new Map<string, { first: any; last: any }>();

  await Promise.all(
    allPuuids.map(async (puuid) => {
      // Newest snapshot overall (for current rank display + window last).
      const { data: newestRows } = await supabaseAdmin
        .from("scout_rank_snapshots")
        .select("tier, rank_division, lp, wins, losses, taken_at")
        .eq("puuid", puuid)
        .eq("queue_type", "RANKED_SOLO_5x5")
        .order("taken_at", { ascending: false })
        .limit(1);
      const newest = newestRows?.[0];
      if (newest) {
        currentRankByPuuid.set(puuid, {
          tier: newest.tier,
          rankDivision: newest.rank_division ?? null,
          lp: Number(newest.lp ?? 0),
          wins: Number(newest.wins ?? 0),
          losses: Number(newest.losses ?? 0),
        });
      }

      // Oldest snapshot in window — the leaderboard "baseline".
      let oldestQ = supabaseAdmin
        .from("scout_rank_snapshots")
        .select("tier, rank_division, lp, taken_at")
        .eq("puuid", puuid)
        .eq("queue_type", "RANKED_SOLO_5x5")
        .order("taken_at", { ascending: true })
        .limit(1);
      if (startIso) oldestQ = oldestQ.gte("taken_at", startIso);
      const { data: oldestRows } = await oldestQ;
      const oldest = oldestRows?.[0];

      if (oldest && newest) {
        windowByPuuid.set(puuid, { first: oldest, last: newest });
      }
    })
  );

  {
    for (const [puuid, { first, last }] of windowByPuuid) {
      const firstScore = ladderScore(first.tier, first.rank_division, first.lp ?? 0);
      const lastScore = ladderScore(last.tier, last.rank_division, last.lp ?? 0);
      balanceByPuuid.set(puuid, lastScore - firstScore);
    }
  }

  // 4b. Streak + duo computation.
  //
  // We collapse the per-puuid sequence into a per-(lobby-player) sequence
  // first — a single human can have multiple Riot accounts in the lobby,
  // and a "winstreak" is owned by the human, not the account.
  //   - Dedup by match_id within a player (one match can only be played
  //     by one of their accounts at a time)
  //   - Sort each player's combined sequence chronologically
  //
  // Then:
  //   - longestIndividualStreak[playerId] = max consecutive `win=true`
  //     run in their sequence
  //   - shared streak for a pair (P1, P2) = walk the matches where BOTH
  //     played AND were on the same team_id, sorted by gameCreation,
  //     max consecutive `win=true` run (since same team → both same win)
  //   - primaryPartner[playerId] = the OTHER lobby player they share
  //     the most games with (decorates other widgets like "+ Isac")

  type PlayerMatch = {
    gameCreation: number;
    matchId: string;
    teamId: number | null;
    win: boolean;
  };
  const seqByPlayer = new Map<string, Map<string, PlayerMatch>>();
  const playerInfoById = new Map<
    string,
    { displayName: string; color: string | null; iconId: number | null }
  >();
  for (const a of accountList) {
    if (!seqByPlayer.has(a.playerId)) {
      seqByPlayer.set(a.playerId, new Map());
    }
    if (!playerInfoById.has(a.playerId)) {
      playerInfoById.set(a.playerId, {
        displayName: a.playerDisplayName,
        color: a.color,
        iconId: iconByPuuid.get(a.puuid) ?? null,
      });
    }
    const seq = seqByPuuid.get(a.puuid) ?? [];
    const pMap = seqByPlayer.get(a.playerId)!;
    for (const m of seq) {
      // First-write-wins dedup — if a player somehow has two accounts in
      // the same match the row is identical anyway (same team_id, win).
      if (!pMap.has(m.matchId)) pMap.set(m.matchId, m);
    }
  }

  // Sorted arrays per player for fast streak walks.
  const sortedSeqByPlayer = new Map<string, PlayerMatch[]>();
  for (const [pid, mp] of seqByPlayer) {
    const arr = [...mp.values()].sort(
      (a, b) => a.gameCreation - b.gameCreation
    );
    sortedSeqByPlayer.set(pid, arr);
  }

  function longestWinRun(seq: PlayerMatch[]): number {
    let longest = 0;
    let current = 0;
    for (const m of seq) {
      if (m.win) {
        current += 1;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
    }
    return longest;
  }

  const longestStreakByPlayer = new Map<string, number>();
  for (const [pid, seq] of sortedSeqByPlayer) {
    longestStreakByPlayer.set(pid, longestWinRun(seq));
  }

  // Pair walks: O(P²) pairs * O(avgMatches) per pair. Fine for ≤20
  // players which is the realistic lobby ceiling.
  const playerIds = [...sortedSeqByPlayer.keys()];
  let topDuoStreak: LeaderboardDuoStreak | null = null;
  let topDuoKda: LeaderboardDuoKda | null = null;
  let topDuoWinrate: LeaderboardDuoWinrate | null = null;

  // Per-puuid kills/deaths/assists per match (for duo KDA aggregation).
  // We need a lookup of kills/deaths/assists per (puuid, matchId).
  const statByPuuidMatch = new Map<string, { k: number; d: number; a: number; teamId: number | null }>();
  for (const r of (partRows ?? []) as any[]) {
    const key = `${r.puuid}:${r.match_id}`;
    statByPuuidMatch.set(key, {
      k: r.kills ?? 0,
      d: r.deaths ?? 0,
      a: r.assists ?? 0,
      teamId: r.team_id ?? null,
    });
  }

  // For each player, track their primary partner (most-shared lobby member).
  const partnerByPlayer = new Map<
    string,
    { playerId: string; sharedGames: number; sharedWins: number }
  >();

  for (let i = 0; i < playerIds.length; i++) {
    const A = playerIds[i];
    const aSeq = seqByPlayer.get(A)!;
    for (let j = i + 1; j < playerIds.length; j++) {
      const B = playerIds[j];
      const bSeq = seqByPlayer.get(B)!;

      // Shared matches with SAME team_id (i.e. they played together,
      // not on opposing sides of a custom or anything weird).
      const shared: PlayerMatch[] = [];
      for (const [matchId, aEntry] of aSeq) {
        const bEntry = bSeq.get(matchId);
        if (!bEntry) continue;
        if (aEntry.teamId !== bEntry.teamId) continue;
        shared.push(aEntry);
      }
      if (shared.length === 0) continue;
      shared.sort((x, y) => x.gameCreation - y.gameCreation);

      const sharedWins = shared.filter((m) => m.win).length;
      const sharedGames = shared.length;

      // Update primary partner for both directions if this is the most
      // games either of them has shared with someone so far.
      const curA = partnerByPlayer.get(A);
      if (!curA || sharedGames > curA.sharedGames) {
        partnerByPlayer.set(A, {
          playerId: B,
          sharedGames,
          sharedWins,
        });
      }
      const curB = partnerByPlayer.get(B);
      if (!curB || sharedGames > curB.sharedGames) {
        partnerByPlayer.set(B, {
          playerId: A,
          sharedGames,
          sharedWins,
        });
      }

      // Streak for this pair.
      const pairStreak = longestWinRun(shared);

      // Duo KDA: average across the shared matches, using both members'
      // numbers per match. Pick all A-puuids participating + all B-puuids
      // participating for each shared match.
      let dk = 0, dd = 0, da = 0;
      for (const m of shared) {
        for (const a of accountList) {
          if (a.playerId !== A && a.playerId !== B) continue;
          const stat = statByPuuidMatch.get(`${a.puuid}:${m.matchId}`);
          if (!stat) continue;
          dk += stat.k;
          dd += stat.d;
          da += stat.a;
        }
      }
      const duoAvgKda =
        dd === 0 ? Math.min(99, dk + da) : (dk + da) / dd;
      const duoWinrate =
        sharedGames > 0 ? Math.round((sharedWins / sharedGames) * 100) : 0;

      const aInfo = playerInfoById.get(A)!;
      const bInfo = playerInfoById.get(B)!;
      const duoBase: LeaderboardDuo = {
        playerIdA: A,
        playerIdB: B,
        displayNameA: aInfo.displayName,
        displayNameB: bInfo.displayName,
        colorA: aInfo.color,
        colorB: bInfo.color,
        iconIdA: aInfo.iconId,
        iconIdB: bInfo.iconId,
        sharedGames,
        sharedWins,
      };

      if (pairStreak > 0 && (!topDuoStreak || pairStreak > topDuoStreak.length)) {
        topDuoStreak = { ...duoBase, length: pairStreak };
      }
      // KDA needs a minimum sample so a single 7-kill game doesn't claim
      // "Top duo." Same threshold as the individual KDA picker — floor 3.
      if (sharedGames >= 3) {
        if (!topDuoKda || duoAvgKda > topDuoKda.avgKda) {
          topDuoKda = { ...duoBase, avgKda: duoAvgKda };
        }
        if (!topDuoWinrate || duoWinrate > topDuoWinrate.winrate) {
          topDuoWinrate = { ...duoBase, winrate: duoWinrate };
        }
      }
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

    // Streak and primary partner are per-PLAYER (not per-account) so
    // multiple Riot accounts owned by the same person share these values.
    const playerStreak = longestStreakByPlayer.get(a.playerId) ?? 0;
    const partner = partnerByPlayer.get(a.playerId) ?? null;
    const partnerInfo = partner ? playerInfoById.get(partner.playerId) : null;

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
      streak: playerStreak,
      primaryPartner:
        partner && partnerInfo
          ? {
              playerId: partner.playerId,
              displayName: partnerInfo.displayName,
              color: partnerInfo.color,
              iconId: partnerInfo.iconId,
              sharedGames: partner.sharedGames,
              sharedWins: partner.sharedWins,
            }
          : null,
    };
  });

  return Response.json({
    accounts: accountRows,
    topDuoStreak,
    topDuoKda,
    topDuoWinrate,
  });
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

  // Private-lobby gate — mirror readScoutLobbyHandler. A private
  // lobby's feed is only served to claimed members + admins; others
  // get an empty feed (the frontend shows a locked body anyway, but
  // this prevents reading the data via a direct API call).
  {
    const { data: lobbyMeta } = await supabaseAdmin
      .from("scout_lobbies")
      .select("is_public, owner_user_id")
      .eq("slug", slug)
      .maybeSingle();
    if (lobbyMeta && lobbyMeta.is_public === false) {
      let allowed = false;
      const viewerId = await getAuthUserId(req);
      if (viewerId) {
        const [{ data: claimed }, { data: admin }] = await Promise.all([
          supabaseAdmin
            .from("scout_lobby_players")
            .select("id")
            .eq("lobby_slug", slug)
            .eq("claimed_by_profile_id", viewerId)
            .maybeSingle(),
          supabaseAdmin
            .from("scout_lobby_admins")
            .select("profile_id")
            .eq("lobby_slug", slug)
            .eq("profile_id", viewerId)
            .maybeSingle(),
        ]);
        allowed =
          !!claimed || !!admin || viewerId === lobbyMeta.owner_user_id;
      }
      if (!allowed) {
        return Response.json({ items: [], nextCursor: null, locked: true });
      }
    }
  }

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

  // 1. Resolve lobby accounts → puuid + region map.
  //    Also pull claim/verify columns so the feed can decorate player
  //    names with the green Meta-style verify badge.
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("scout_lobby_accounts")
    .select(
      "puuid, region, lobby_player_id, verified_at, scout_lobby_players!inner(id, display_name, color, lobby_slug, claimed_by_profile_id, show_verify_badge)"
    )
    .eq("scout_lobby_players.lobby_slug", slug);

  if (accErr) {
    console.error("scout feed: account lookup error:", accErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!accounts || accounts.length === 0) {
    return Response.json({ items: [], nextCursor: null });
  }

  // Verify mode clamp — same policy as readScoutLobbyHandler.
  const { data: lobbyRow } = await supabaseAdmin
    .from("scout_lobbies")
    .select("verify_mode")
    .eq("slug", slug)
    .maybeSingle();
  const verifyMode =
    (((lobbyRow as any)?.verify_mode as
      | "disabled" | "claim_only" | "full" | null) ?? "full");

  type LobbyPlayerInfo = {
    playerId: string;
    displayName: string;
    color: string | null;
    showVerifyBadge: boolean;
    verifyGrade: 0 | 1 | 2;
  };
  // First pass: per-player aggregation of claimed + all-accounts-verified.
  type PlayerAgg = {
    displayName: string;
    color: string | null;
    isClaimed: boolean;
    showVerifyBadge: boolean;
    totalAccounts: number;
    verifiedAccounts: number;
  };
  const playerAggById = new Map<string, PlayerAgg>();
  for (const a of accounts as any[]) {
    const pid = a.scout_lobby_players.id;
    let agg = playerAggById.get(pid);
    if (!agg) {
      agg = {
        displayName: a.scout_lobby_players.display_name,
        color: a.scout_lobby_players.color,
        isClaimed: !!a.scout_lobby_players.claimed_by_profile_id,
        showVerifyBadge: !!a.scout_lobby_players.show_verify_badge,
        totalAccounts: 0,
        verifiedAccounts: 0,
      };
      playerAggById.set(pid, agg);
    }
    agg.totalAccounts += 1;
    if (a.verified_at) agg.verifiedAccounts += 1;
  }

  const puuidToPlayers = new Map<string, LobbyPlayerInfo[]>();
  const puuidToRegion = new Map<string, string>();
  for (const a of accounts as any[]) {
    const pid = a.scout_lobby_players.id;
    const agg = playerAggById.get(pid)!;
    let verifyGrade: 0 | 1 | 2 = 0;
    if (agg.isClaimed) {
      verifyGrade =
        agg.totalAccounts > 0 && agg.verifiedAccounts === agg.totalAccounts
          ? 2
          : 1;
    }
    // Apply same verify_mode clamp the lobby handler does.
    if (verifyMode === "disabled") verifyGrade = 0;
    else if (verifyMode === "claim_only" && verifyGrade === 2) verifyGrade = 1;
    const effectiveShowBadge =
      verifyMode !== "disabled" && agg.showVerifyBadge;
    const lp: LobbyPlayerInfo = {
      playerId: pid,
      displayName: agg.displayName,
      color: agg.color,
      showVerifyBadge: effectiveShowBadge,
      verifyGrade,
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
    // Same gotcha as the leaderboard query: a single .in(puuids)
    // .order(taken_at) request gets silently capped at Supabase's
    // 1000-row default. For a lobby that has accumulated thousands
    // of snapshots across all accounts that means everything past
    // the first day gets dropped, and the per-match lpDelta becomes
    // null because the post-match snapshot is missing from the list.
    // Fan out per puuid instead — small N, each query bounded by
    // that puuid's own snapshot count.
    type Snap = {
      tier: string;
      rank_division: string | null;
      lp: number;
      taken_at: string;
      match_id: string | null;
    };
    const snapsByKey = new Map<string, Snap[]>();

    const puuidsArr = Array.from(puuidsNeedingSnap);
    // PostgREST caps every response at 1000 rows regardless of .limit() or
    // .range() — that's the next gotcha after the per-puuid fan-out one.
    // For a tracked account that's been in a lobby for more than ~3 days
    // (1000 / 12 per hour from the 5-minute periodic sweep) only the
    // OLDEST 1000 snapshots come back when we sort ascending, which is
    // exactly the slice that doesn't help us compute deltas for recent
    // matches — the post-match snapshot for today is past row 1000 and
    // we never see it, so lpDelta stays null and the player wonders why
    // their wins aren't credited.
    //
    // Paginate explicitly with `.range()` chunks of 1000 until a partial
    // page comes back. 50k cap = ~5 weeks of 5-minute snapshots, which
    // is plenty for any feed window.
    async function fetchAllSnaps(puuid: string) {
      type Row = {
        puuid: string;
        queue_type: string;
        tier: string;
        rank_division: string | null;
        lp: number;
        taken_at: string;
        match_id: string | null;
      };
      const PAGE = 1000;
      const MAX_PAGES = 50;
      const out: Row[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE;
        const to = from + PAGE - 1;
        const { data, error } = await supabaseAdmin
          .from("scout_rank_snapshots")
          .select(
            "puuid, queue_type, tier, rank_division, lp, taken_at, match_id"
          )
          .eq("puuid", puuid)
          .in("queue_type", ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"])
          .order("taken_at", { ascending: true })
          .range(from, to);
        if (error) {
          console.error("scout feed: snapshot page error:", error.message);
          break;
        }
        const rows = (data ?? []) as Row[];
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return { data: out };
    }
    const perPuuid = await Promise.all(puuidsArr.map(fetchAllSnaps));
    for (const { data: snapRows } of perPuuid) {
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

      // Always compute the LP delta via ladderScore. For same-tier games
      // this is identical to (after.lp − before.lp). For promo/demote
      // games it correctly accounts for the division swap (e.g. losing
      // from EMERALD III 0 LP → EMERALD IV 75 LP is a real −25 LP loss,
      // not "no change" or "untrackable"), so the session aggregate
      // doesn't silently drop those games' deltas.
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
      it.participant.lpDelta = afterScore - beforeScore;

      const sameTierDiv =
        before.tier === after.tier &&
        before.rank_division === after.rank_division;
      if (!sameTierDiv) {
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

// ─── DELETE /api/scout/lobby/:slug ──────────────────────────────────────
// Delete a lobby (and CASCADE drops players + accounts). Auth: must be the
// owner (login match on owner_user_id) OR provide ?key=<ownerKey>.
// Rank snapshots are intentionally kept — they're keyed on puuid only and
// remain useful for any future lobby tracking the same accounts.
export async function deleteScoutLobbyHandler(
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const url = new URL(req.url);
  const providedKey = url.searchParams.get("key");

  const { data: lobby, error: lobbyErr } = await supabaseAdmin
    .from("scout_lobbies")
    .select("slug, owner_key, owner_user_id")
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

  const { error: delErr } = await supabaseAdmin
    .from("scout_lobbies")
    .delete()
    .eq("slug", slug);
  if (delErr) {
    console.error("scout delete error:", delErr);
    return Response.json({ error: "Failed to delete lobby" }, { status: 500 });
  }

  return Response.json({ slug, deleted: true });
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

  // 3. Update lobby name. heroChampion is only updated when the client sent
  //    a non-undefined value, so PATCHing without the field doesn't wipe it.
  const lobbyUpdate: Record<string, unknown> = {
    name,
    is_public: body.isPublic !== false,
  };
  if (body.heroChampion !== undefined) {
    lobbyUpdate.hero_champion = body.heroChampion?.trim() || null;
  }
  // v3 config: enabled tab list + verification mode. Validate
  // strictly so the CHECK constraint doesn't reject the write.
  if ((body as any).enabledTabs !== undefined) {
    const arr = (body as any).enabledTabs;
    if (
      Array.isArray(arr) &&
      arr.every((s) => typeof s === "string" && /^[a-z0-9_-]{1,32}$/.test(s))
    ) {
      lobbyUpdate.enabled_tabs = arr;
    }
  }
  if ((body as any).verifyMode !== undefined) {
    const vm = (body as any).verifyMode;
    if (vm === "disabled" || vm === "claim_only" || vm === "full") {
      lobbyUpdate.verify_mode = vm;
    }
  }
  await supabaseAdmin
    .from("scout_lobbies")
    .update(lobbyUpdate)
    .eq("slug", slug);

  // 4. Diff-based update of players + accounts.
  //
  // The old "DELETE all + INSERT" approach wiped claim/verify state on
  // every save because scout_lobby_players carries claimed_by_profile_id
  // and scout_lobby_accounts carries verified_at + verification_target_*
  // — all of which got nuked the moment an admin saved any edit. We
  // now do a proper diff:
  //
  //   players:
  //     • body.id matches existing → UPDATE display_name + color + order
  //     • body.id null / not found → INSERT new row
  //     • existing in DB but not in body → DELETE
  //
  //   accounts (per surviving/new player):
  //     • puuid matches existing → UPDATE riot_name/tag/order/is_primary
  //     • puuid not yet present → INSERT
  //     • existing puuid not in body → DELETE
  //
  // claim/verify rows survive because we never delete the parent
  // player or its accounts unless they're explicitly removed.

  const { data: existingPlayers } = await supabaseAdmin
    .from("scout_lobby_players")
    .select("id, display_name, color, order_index")
    .eq("lobby_slug", slug);
  const existingPlayerIds = new Set(
    (existingPlayers ?? []).map((p: any) => p.id as string)
  );
  const incomingIds = new Set<string>();

  // First pass: upsert each incoming player and capture its id.
  const resolvedPlayerIds: string[] = [];
  for (let pIdx = 0; pIdx < players.length; pIdx++) {
    const p = players[pIdx];
    const incomingId =
      typeof (p as any).id === "string" ? ((p as any).id as string) : null;

    let playerId: string;
    if (incomingId && existingPlayerIds.has(incomingId)) {
      // UPDATE in place — preserves claim/verify state.
      const { error: upErr } = await supabaseAdmin
        .from("scout_lobby_players")
        .update({
          display_name: p.displayName.trim(),
          color: p.color ?? null,
          order_index: pIdx,
        })
        .eq("id", incomingId);
      if (upErr) {
        console.error("scout update: player update error:", upErr);
        return Response.json({ error: "Failed to update players" }, { status: 500 });
      }
      playerId = incomingId;
    } else {
      // Brand new row.
      const { data: row, error: insErr } = await supabaseAdmin
        .from("scout_lobby_players")
        .insert({
          lobby_slug: slug,
          display_name: p.displayName.trim(),
          color: p.color ?? null,
          order_index: pIdx,
        })
        .select("id")
        .single();
      if (insErr || !row) {
        console.error("scout update: player insert error:", insErr);
        return Response.json({ error: "Failed to update players" }, { status: 500 });
      }
      playerId = row.id;
    }
    incomingIds.add(playerId);
    resolvedPlayerIds.push(playerId);
  }

  // Delete players the admin removed. ON DELETE CASCADE wipes their
  // accounts — and that's correct: if the human's removed from the
  // lobby their claim+verify history goes with them.
  const idsToDelete = [...existingPlayerIds].filter(
    (id) => !incomingIds.has(id)
  );
  if (idsToDelete.length > 0) {
    await supabaseAdmin
      .from("scout_lobby_players")
      .delete()
      .in("id", idsToDelete);
  }

  // Second pass: per-player account diff. Match on puuid because
  // that's what survives (riot_name etc. can change without breaking
  // identity).
  for (let pIdx = 0; pIdx < players.length; pIdx++) {
    const p = players[pIdx];
    const playerId = resolvedPlayerIds[pIdx];

    const { data: existingAccounts } = await supabaseAdmin
      .from("scout_lobby_accounts")
      .select("id, puuid")
      .eq("lobby_player_id", playerId);
    const existingByPuuid = new Map<string, string>(
      (existingAccounts ?? []).map((a: any) => [a.puuid, a.id])
    );
    const keepPuuids = new Set<string>();

    for (let aIdx = 0; aIdx < p.accounts.length; aIdx++) {
      const a = p.accounts[aIdx];
      keepPuuids.add(a.puuid);
      const existingId = existingByPuuid.get(a.puuid);
      const payload = {
        lobby_player_id: playerId,
        puuid: a.puuid,
        region: a.region.toUpperCase(),
        riot_name: a.riotName,
        riot_tag: a.riotTag,
        is_primary: aIdx === 0,
        order_index: aIdx,
      };
      if (existingId) {
        const { error: upErr } = await supabaseAdmin
          .from("scout_lobby_accounts")
          .update(payload)
          .eq("id", existingId);
        if (upErr) {
          console.error("scout update: account update error:", upErr);
          return Response.json({ error: "Failed to update accounts" }, { status: 500 });
        }
      } else {
        const { error: insErr } = await supabaseAdmin
          .from("scout_lobby_accounts")
          .insert(payload);
        if (insErr) {
          console.error("scout update: account insert error:", insErr);
          return Response.json({ error: "Failed to update accounts" }, { status: 500 });
        }
      }
    }

    // Remove accounts no longer in the player's set.
    const accountIdsToDelete: string[] = [];
    for (const [puuid, id] of existingByPuuid) {
      if (!keepPuuids.has(puuid)) accountIdsToDelete.push(id);
    }
    if (accountIdsToDelete.length > 0) {
      await supabaseAdmin
        .from("scout_lobby_accounts")
        .delete()
        .in("id", accountIdsToDelete);
    }
  }

  // 5. Kick ingestion + baseline snapshot for every account (covers any
  //    newly-added accounts; existing ones get fresh data too).
  //    Invalidate the puuid-in-lobby cache so post-match snapshots for
  //    fresh puuids start writing immediately instead of waiting out the
  //    cache TTL.
  for (const p of players) {
    for (const a of p.accounts) {
      invalidatePuuidLobbyCache(a.puuid);
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
  // keep them fire-and-forget alongside. We also invalidate the
  // puuid-in-lobby cache so any concurrent match-ingest snapshot calls
  // for these puuids see a fresh `true` instead of a stale `false`.
  for (const a of accountList) {
    invalidatePuuidLobbyCache(a.puuid);
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
  req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const { data: lobby, error: lobbyErr } = await supabaseAdmin
    .from("scout_lobbies")
    .select(
      "slug, name, is_public, created_at, last_active_at, last_refresh_at, owner_user_id, hero_champion, enabled_tabs, verify_mode"
    )
    .eq("slug", slug)
    .maybeSingle();

  if (lobbyErr) {
    console.error("scout_lobbies read error:", lobbyErr);
    return Response.json({ error: "Failed to read lobby" }, { status: 500 });
  }
  if (!lobby) return Response.json({ error: "Not found" }, { status: 404 });

  // Private-lobby gate. A private lobby's full content (players, ranks,
  // accounts, admins) is only returned to "members" — users who have
  // claimed an identity in the lobby OR are admins. Everyone else gets
  // a LOCKED stub with just the hero info (name + splash) so the
  // frontend can render the banner + a "this lobby is private" body.
  const isPublic = lobby.is_public !== false;
  let canViewFull = isPublic;
  if (!isPublic) {
    const viewerId = await getAuthUserId(req);
    if (viewerId) {
      const [{ data: claimed }, { data: admin }] = await Promise.all([
        supabaseAdmin
          .from("scout_lobby_players")
          .select("id")
          .eq("lobby_slug", slug)
          .eq("claimed_by_profile_id", viewerId)
          .maybeSingle(),
        supabaseAdmin
          .from("scout_lobby_admins")
          .select("profile_id")
          .eq("lobby_slug", slug)
          .eq("profile_id", viewerId)
          .maybeSingle(),
      ]);
      canViewFull =
        !!claimed || !!admin || viewerId === lobby.owner_user_id;
    }
  }

  if (!canViewFull) {
    // Locked stub — hero only, no sensitive content, no refresh clock.
    return Response.json({
      slug: lobby.slug,
      name: lobby.name,
      isPublic: false,
      locked: true,
      createdAt: lobby.created_at,
      lastActiveAt: lobby.last_active_at,
      lastRefreshAt: null,
      ownerUserId: lobby.owner_user_id ?? null,
      heroChampion: lobby.hero_champion ?? null,
      enabledTabs: [],
      verifyMode:
        ((lobby as any).verify_mode as
          | "disabled" | "claim_only" | "full" | null) ?? "full",
      players: [],
      admins: [],
    });
  }

  const { data: players, error: playersErr } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "id, display_name, color, order_index, claimed_by_profile_id, claimed_at, show_verify_badge, scout_lobby_accounts(id, puuid, region, riot_name, riot_tag, is_primary, order_index, verified_at)"
    )
    .eq("lobby_slug", slug)
    .order("order_index", { ascending: true });

  if (playersErr) {
    console.error("scout_lobby_players read error:", playersErr);
    return Response.json({ error: "Failed to read players" }, { status: 500 });
  }

  // Sort accounts within each player by order_index. Compute the
  // identity-verification grade:
  //   • grade 0 — not claimed
  //   • grade 1 — claimed, but at least one Riot account is unverified
  //   • grade 2 — claimed AND every Riot account has verified_at set
  // (Per user spec: Grade 2 requires ALL accounts, not just one.)
  const normalizedPlayers = (players ?? []).map((p: any) => {
    const accounts = (p.scout_lobby_accounts ?? [])
      .sort((a: any, b: any) => a.order_index - b.order_index)
      .map((a: any) => ({
        id: a.id,
        puuid: a.puuid,
        region: a.region,
        riotName: a.riot_name,
        riotTag: a.riot_tag,
        isPrimary: a.is_primary,
        orderIndex: a.order_index,
        verifiedAt: a.verified_at ?? null,
      }));
    const isClaimed = !!p.claimed_by_profile_id;
    const allAccountsVerified =
      accounts.length > 0 && accounts.every((a: any) => !!a.verifiedAt);
    // Compute the raw grade, then clamp by verify_mode so the
    // frontend never has to know about the policy:
    //   • disabled   → grade always 0, badge always off
    //   • claim_only → max grade 1 (no Grade 2 even if accounts verified)
    //   • full       → grade as computed
    const verifyMode =
      ((lobby as any).verify_mode as "disabled" | "claim_only" | "full" | null) ??
      "full";
    let verifyGrade: 0 | 1 | 2 = 0;
    if (isClaimed) verifyGrade = allAccountsVerified ? 2 : 1;
    if (verifyMode === "disabled") verifyGrade = 0;
    else if (verifyMode === "claim_only" && verifyGrade === 2) verifyGrade = 1;

    const effectiveShowBadge =
      verifyMode !== "disabled" && !!p.show_verify_badge;

    return {
      id: p.id,
      displayName: p.display_name,
      color: p.color,
      orderIndex: p.order_index,
      claimedByProfileId: p.claimed_by_profile_id ?? null,
      claimedAt: p.claimed_at ?? null,
      showVerifyBadge: effectiveShowBadge,
      verifyGrade,
      accounts,
    };
  });

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

  // Attach the current solo-queue rank to every account so the matches tab
  // can render a "start → current" pill on each group card without making
  // a second round-trip. Cheap: one limit(1) query per account, fanned
  // out in parallel.
  const allAccountPuuids = playersWithIcon.flatMap((p: any) =>
    p.accounts.map((a: any) => a.puuid as string)
  );
  const currentRankByPuuid = new Map<
    string,
    { tier: string; rankDivision: string | null; lp: number }
  >();
  await Promise.all(
    allAccountPuuids.map(async (puuid) => {
      const { data: rows } = await supabaseAdmin
        .from("scout_rank_snapshots")
        .select("tier, rank_division, lp")
        .eq("puuid", puuid)
        .eq("queue_type", "RANKED_SOLO_5x5")
        .order("taken_at", { ascending: false })
        .limit(1);
      const row = rows?.[0];
      if (row) {
        currentRankByPuuid.set(puuid, {
          tier: row.tier,
          rankDivision: row.rank_division ?? null,
          lp: Number(row.lp ?? 0),
        });
      }
    })
  );
  const playersWithRank = playersWithIcon.map((p: any) => ({
    ...p,
    accounts: p.accounts.map((a: any) => ({
      ...a,
      currentRank: currentRankByPuuid.get(a.puuid) ?? null,
    })),
  }));

  // Bump last_active_at (fire-and-forget)
  supabaseAdmin
    .from("scout_lobbies")
    .update({ last_active_at: new Date().toISOString() })
    .eq("slug", slug)
    .then(() => {});

  // Opportunistic snapshot — every lobby read fires a writeRankSnapshot
  // per account in the background. writeRankSnapshot dedupes inside
  // a 5-minute window so this is cheap (= 5 Riot calls only when more
  // than 5 min has passed since the last snapshot for that puuid).
  // This guarantees that even if the periodic sweep or post-match hooks
  // miss an update, just opening the lobby page kicks in fresh data.
  for (const p of playersWithIcon) {
    for (const a of p.accounts as Array<{ puuid: string; region: string }>) {
      invalidatePuuidLobbyCache(a.puuid);
      writeRankSnapshot(a.puuid, a.region).catch((e) =>
        console.warn(
          `scout lobby read: opportunistic snapshot error for ${String(a.puuid).slice(0, 8)}…:`,
          (e as any)?.message ?? e
        )
      );
    }
  }

  // Lobby admins — creator + co-admins. The frontend uses this to
  // gate the Edit dialog visibility and the Verify FAB visibility.
  const { data: adminRows } = await supabaseAdmin
    .from("scout_lobby_admins")
    .select("profile_id, granted_at, granted_by")
    .eq("lobby_slug", slug);
  const admins = (adminRows ?? []).map((a) => ({
    profileId: a.profile_id,
    grantedAt: a.granted_at,
    grantedBy: a.granted_by,
  }));

  return Response.json({
    slug: lobby.slug,
    name: lobby.name,
    isPublic: lobby.is_public !== false,
    locked: false,
    createdAt: lobby.created_at,
    lastActiveAt: lobby.last_active_at,
    lastRefreshAt: lobby.last_refresh_at ?? null,
    ownerUserId: lobby.owner_user_id ?? null,
    heroChampion: lobby.hero_champion ?? null,
    enabledTabs: (lobby as any).enabled_tabs ?? [
      "matches", "stats", "champions", "habits",
      "live", "leaderboard", "trending",
    ],
    verifyMode: ((lobby as any).verify_mode as
      | "disabled" | "claim_only" | "full" | null) ?? "full",
    players: playersWithRank,
    admins,
  });
}

// ─── GET /api/scout/snapshots-debug/:slug ─────────────────────────────
//
// Diagnostic endpoint. For every account in a lobby, returns:
//   - is_in_lobby_cache: what isPuuidInAnyLobby returns RIGHT NOW
//   - snapshot_count:    total scout_rank_snapshots rows for that puuid
//   - latest_snapshots:  the most recent 5 snapshots (taken_at, tier, lp)
//   - lobby_created_at:  the lobby's created_at (acts as leaderboard cutoff)
//   - snapshots_in_window: how many snapshots ≥ lobby_created_at
//
// Use this to confirm whether the LP-tracking path is actually writing
// rows. If snapshot_count is 1 (or 0) for an account that has played
// games since lobby creation, something upstream is broken.
//
// No auth — read-only diagnostic. Don't expose puuids that aren't
// already in the lobby payload.
export async function debugScoutSnapshotsHandler(
  _req: Request,
  pathname: string
): Promise<Response> {
  const slug = pathname.split("/").pop();
  if (!slug) return Response.json({ error: "Missing slug" }, { status: 400 });

  const { data: lobby } = await supabaseAdmin
    .from("scout_lobbies")
    .select("created_at")
    .eq("slug", slug)
    .maybeSingle();
  if (!lobby) return Response.json({ error: "Not found" }, { status: 404 });

  const lobbyCreatedAt = lobby.created_at;

  // scout_lobby_accounts is keyed by player_id, NOT lobby_slug — so we
  // resolve via the join: lobby_slug → players[].id → accounts[].
  const { data: playerRows } = await supabaseAdmin
    .from("scout_lobby_players")
    .select(
      "scout_lobby_accounts(puuid, region, riot_name, riot_tag, is_primary)"
    )
    .eq("lobby_slug", slug);

  const accounts: Array<{ puuid: string; region: string; riot_name: string; riot_tag: string; is_primary: boolean }> = [];
  for (const pr of (playerRows ?? []) as any[]) {
    for (const a of (pr.scout_lobby_accounts ?? []) as any[]) {
      accounts.push({
        puuid: a.puuid,
        region: a.region,
        riot_name: a.riot_name,
        riot_tag: a.riot_tag,
        is_primary: a.is_primary,
      });
    }
  }

  const out: Array<{
    puuid: string;
    riot_id: string;
    region: string;
    is_in_lobby_cache: boolean;
    snapshot_count: number;
    snapshots_in_window: number;
    latest_snapshots: Array<{ taken_at: string; tier: string; rank_division: string | null; lp: number; queue_type: string }>;
  }> = [];

  for (const a of accounts as Array<{ puuid: string; region: string; riot_name: string; riot_tag: string }>) {
    const inLobby = await isPuuidInAnyLobby(a.puuid);

    const { count: totalCount } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("puuid", a.puuid);

    const { count: windowCount } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("puuid", a.puuid)
      .gte("taken_at", lobbyCreatedAt);

    // Oldest snapshot in window (solo queue) — drives the baseline
    // the leaderboard computes balance against.
    const { data: oldestRows } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("taken_at, tier, rank_division, lp")
      .eq("puuid", a.puuid)
      .eq("queue_type", "RANKED_SOLO_5x5")
      .gte("taken_at", lobbyCreatedAt)
      .order("taken_at", { ascending: true })
      .limit(1);
    const oldestSolo = oldestRows?.[0] ?? null;

    // Newest snapshot (solo queue) — what the leaderboard compares
    // against the baseline.
    const { data: newestRows } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("taken_at, tier, rank_division, lp")
      .eq("puuid", a.puuid)
      .eq("queue_type", "RANKED_SOLO_5x5")
      .order("taken_at", { ascending: false })
      .limit(1);
    const newestSolo = newestRows?.[0] ?? null;

    // Number of DISTINCT (tier, division, lp) tuples in window — if
    // it's 1, the leaderboard balance will be 0 by definition.
    const { data: distinctRows } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("tier, rank_division, lp")
      .eq("puuid", a.puuid)
      .eq("queue_type", "RANKED_SOLO_5x5")
      .gte("taken_at", lobbyCreatedAt);
    const distinctKeys = new Set(
      (distinctRows ?? []).map((r: any) => `${r.tier}/${r.rank_division}/${r.lp}`)
    );

    const balance =
      oldestSolo && newestSolo
        ? ladderScore(newestSolo.tier, newestSolo.rank_division, Number(newestSolo.lp ?? 0)) -
          ladderScore(oldestSolo.tier, oldestSolo.rank_division, Number(oldestSolo.lp ?? 0))
        : 0;

    const { data: latest } = await supabaseAdmin
      .from("scout_rank_snapshots")
      .select("taken_at, tier, rank_division, lp, queue_type")
      .eq("puuid", a.puuid)
      .order("taken_at", { ascending: false })
      .limit(5);

    out.push({
      puuid: a.puuid,
      riot_id: `${a.riot_name}#${a.riot_tag}`,
      region: a.region,
      is_in_lobby_cache: inLobby,
      snapshot_count: totalCount ?? 0,
      snapshots_in_window: windowCount ?? 0,
      solo_baseline: oldestSolo,
      solo_current: newestSolo,
      solo_distinct_lp_values_in_window: distinctKeys.size,
      solo_balance_computed: balance,
      latest_snapshots: (latest ?? []) as any[],
    } as any);
  }

  return Response.json({
    slug,
    lobby_created_at: lobbyCreatedAt,
    accounts: out,
  });
}
