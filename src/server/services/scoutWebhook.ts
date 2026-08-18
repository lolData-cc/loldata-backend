// src/server/services/scoutWebhook.ts
//
// Scout lobby → Discord webhook delivery.
//
// Turns a finished game into a rich Discord embed that mirrors a row of the
// scout feed: champion icon, K/D/A, KDA ratio, CS, damage, kill participation,
// LP delta, queue, duration and the lobby's average elo. When several lobby
// members played the SAME game we emit one "squad" embed listing each of them
// instead of spamming the channel.
//
// Everything here is fire-and-forget: a webhook problem must never break the
// sweep that called it, so nothing throws — failures are returned/logged and
// recorded on the row so the lobby UI can surface a dead webhook.

const CDN = "https://cdn2.loldata.cc";
const SITE = "https://loldata.cc";

// Champion art on our CDN is VERSIONED — `/<ddragon-version>/img/champion/X.png`.
// An unversioned path 404s, and Discord silently drops a thumbnail it can't
// fetch, so the embed just loses its icon with no error anywhere.
//
// The version comes from the CDN's own marker rather than Riot's versions.json:
// the marker says what our CDN actually HAS. If the DDragon→R2 sync ever stalls
// again, Riot's newest version would be a directory that doesn't exist here.
const CDN_VERSION_MARKER = `${CDN}/_current_version.txt`;
const CDN_VERSION_FALLBACK = "16.14.1";
const CDN_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

let cdnVersion = CDN_VERSION_FALLBACK;
let cdnVersionAt = 0;

async function currentCdnVersion(): Promise<string> {
  if (Date.now() - cdnVersionAt < CDN_VERSION_TTL_MS) return cdnVersion;
  try {
    const res = await fetch(CDN_VERSION_MARKER, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const v = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+$/.test(v)) {
        cdnVersion = v;
        cdnVersionAt = Date.now();
      }
    }
  } catch {
    /* keep the last known good version — a missing marker must not lose the icon */
  }
  return cdnVersion;
}

// Discord caps embeds at 10 per message and 6000 chars total; we stay far
// under both (1 embed, a handful of short fields).
const DISCORD_TIMEOUT_MS = 8000;

// ── colours (decimal, Discord wants ints) ───────────────────────────────
const COLOR_WIN = 0x00d992;   // jade
const COLOR_LOSS = 0xc93232;  // loss red
const COLOR_REMAKE = 0xf5a623;

/** Compact queue names for the rank line, where space is tight. */
const QUEUE_SHORT: Record<number, string> = {
  420: "Solo/Duo",
  440: "Flex",
  400: "Draft",
  430: "Blind",
  450: "ARAM",
  480: "Swiftplay",
  490: "Quickplay",
  700: "Clash",
  1700: "Arena",
};

const QUEUE_LABEL: Record<number, string> = {
  420: "Ranked Solo/Duo",
  440: "Ranked Flex",
  400: "Normal Draft",
  430: "Normal Blind",
  450: "ARAM",
  480: "Swiftplay",
  490: "Quickplay",
  700: "Clash",
  1700: "Arena",
};

const TIER_ORDER = [
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM",
  "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];
const DIVISIONS = ["IV", "III", "II", "I"];
const LP_PER_TIER = 400;

/** ladderScore → human tier, so an averaged score reads as "EMERALD II". */
export function scoreToTier(score: number): string {
  if (score <= 0) return "Unranked";
  const tierIdx = Math.min(TIER_ORDER.length - 1, Math.floor(score / LP_PER_TIER));
  const tier = TIER_ORDER[tierIdx];
  if (tierIdx >= TIER_ORDER.indexOf("MASTER")) {
    const lp = Math.round(score - TIER_ORDER.indexOf("MASTER") * LP_PER_TIER);
    return `${tier} ${lp} LP`;
  }
  const within = score - tierIdx * LP_PER_TIER;
  const div = DIVISIONS[Math.min(3, Math.floor(within / 100))];
  return `${tier} ${div}`;
}

/** Champion names → DDragon file names (Wukong etc. differ from the API id). */
function champFile(name: string): string {
  const fixes: Record<string, string> = {
    FiddleSticks: "Fiddlesticks",
    Wukong: "MonkeyKing",
  };
  return (fixes[name] ?? name).replace(/[^A-Za-z0-9]/g, "");
}

export type WebhookPlayerLine = {
  displayName: string;      // lobby display name
  riotId: string | null;    // "name#tag" for the profile link
  region: string;
  championName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  damage: number;
  kp: number | null;        // 0-100
  lpDelta: number | null;
  visionScore?: number | null;
  // Rank AFTER the game, from the post-match snapshot.
  tier?: string | null;         // "EMERALD"
  division?: string | null;     // "II" (Riot still sends "I" in Master+)
  lp?: number | null;           // absolute LP at that rank, after the game
  rankChange?: "PROMOTION" | "DEMOTION" | null;
};

/** Master/GM/Challenger have no divisions — Riot returns "I" anyway. */
const APEX_TIERS = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

/** Real League rank crest on our CDN — these live at the CDN ROOT, not under
 *  a version directory like champion art does. */
function rankIconUrl(tier?: string | null): string | null {
  if (!tier) return null;
  const t = tier.toLowerCase();
  return TIER_ORDER.some((x) => x.toLowerCase() === t)
    ? `${CDN}/ranks/${t}.png`
    : null;
}

/** Coloured marker for the tier, for the places an image can't go. */
const TIER_EMOJI: Record<string, string> = {
  IRON: "⚫", BRONZE: "🟤", SILVER: "⚪", GOLD: "🟡", PLATINUM: "🔷",
  EMERALD: "🟢", DIAMOND: "💎", MASTER: "🟣", GRANDMASTER: "🔴", CHALLENGER: "👑",
};

/**
 * "🟢 Emerald II · 42 LP (+18) — Solo/Duo": rank, where they now stand, the
 * swing, and WHICH LADDER it is.
 *
 * The queue rides here rather than only in the match footer because Solo/Duo
 * and Flex are separate ladders — an LP number is meaningless until you know
 * which one it came from. It also repeats on every block of a squad message,
 * where the footer only appears once at the very bottom.
 *
 * The absolute LP is the whole story in Master+, where LP *is* the rank; the
 * division is dropped there because Riot sends a meaningless "I".
 */
function rankLine(x: WebhookPlayerLine, queueShort: string): string {
  if (!x.tier) return `◈ ${queueShort}`;

  const pretty = x.tier.charAt(0) + x.tier.slice(1).toLowerCase();
  const apex = APEX_TIERS.has(x.tier);
  const rank = apex ? pretty : `${pretty}${x.division ? ` ${x.division}` : ""}`;
  const emoji = `${TIER_EMOJI[x.tier] ?? "◈"} `;
  const total = x.lp != null ? ` · ${x.lp} LP` : "";
  const tail = ` — ${queueShort}`;

  if (x.lpDelta == null) return `${emoji}${rank}${total}${tail}`;

  const swing = x.lpDelta > 0 ? `+${x.lpDelta}` : `${x.lpDelta}`;
  if (x.rankChange === "PROMOTION") return `${emoji}${rank}${total} · PROMOTED (${swing})${tail}`;
  if (x.rankChange === "DEMOTION") return `${emoji}${rank}${total} · DEMOTED (${swing})${tail}`;
  return `${emoji}${rank}${total} (${swing})${tail}`;
}

/** A pro / streamer who happened to be in the same game. */
export type WebhookNotable = {
  name: string;          // the handle everyone knows — "Faker"
  slug: string;          // /players/<slug>
  championName: string;
  kind: "pro" | "streamer";
};

export type WebhookMatchPayload = {
  lobbyName: string;
  lobbySlug: string;
  matchId: string;
  queueId: number | null;
  durationSec: number;
  gameEndMs: number | null;
  players: WebhookPlayerLine[];   // 1 = solo, 2+ = squad game
  avgLadderScore: number | null;  // averaged over the 10 participants we know
  notables?: WebhookNotable[];    // pros/streamers in the lobby of that game
};

/** How the group is announced when several lobby members shared a game. */
function partyLabel(n: number): string | null {
  if (n < 2) return null;
  if (n === 2) return "DUO";
  if (n === 3) return "TRIO";
  if (n === 4) return "FLEX 4";
  return "FULL 5";
}

const kdaRatio = (k: number, d: number, a: number) =>
  d === 0 ? "Perfect" : ((k + a) / d).toFixed(2);

const fmtNum = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

const fmtDuration = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function profileUrl(region: string, riotId: string | null): string | null {
  if (!riotId || !riotId.includes("#")) return null;
  const [name, tag] = riotId.split("#");
  return `${SITE}/summoners/${region.toLowerCase()}/${encodeURIComponent(name.replace(/\s+/g, "+"))}-${encodeURIComponent(tag)}`;
}

/** The three stat cells shared by every player block. */
function statFields(x: WebhookPlayerLine) {
  return [
    {
      name: "K / D / A",
      value: `**${x.kills} / ${x.deaths} / ${x.assists}**\n${kdaRatio(x.kills, x.deaths, x.assists)} KDA`,
      inline: true,
    },
    {
      name: "CS · Damage",
      value: `${x.cs} CS\n${fmtNum(x.damage)} to champions`,
      inline: true,
    },
    {
      // LP moved up to the author line (next to the rank crest), so this cell
      // carries the two remaining per-player numbers instead of repeating it.
      name: "KP · Vision",
      value:
        (x.kp != null ? `${x.kp}% kill participation` : "—") +
        (x.visionScore != null ? `\n${x.visionScore} vision score` : ""),
      inline: true,
    },
  ];
}

/**
 * Build the Discord embeds for a finished game — ONE message either way.
 *
 * Solo game  → a single embed, champion icon as thumbnail.
 * Squad game → one embed PER member, each with its own champion icon. Discord
 *   allows up to 10 embeds in a message, so the squad still arrives as a single
 *   notification; a single embed has only one thumbnail slot, which is why the
 *   squad case used to lose the champion art entirely.
 *
 * The match line (queue, duration, average elo) and the footer ride on the LAST
 * embed so they read as a caption for the whole group instead of repeating.
 */
export async function buildMatchEmbeds(
  p: WebhookMatchPayload
): Promise<Record<string, unknown>[]> {
  const isRemake = p.durationSec < 300;
  const queue = p.queueId != null ? QUEUE_LABEL[p.queueId] ?? `Queue ${p.queueId}` : "Custom";
  const queueShort = p.queueId != null ? QUEUE_SHORT[p.queueId] ?? queue : "Custom";
  const version = await currentCdnVersion();
  const lobbyUrl = `${SITE}/scout/${p.lobbySlug}`;
  const party = partyLabel(p.players.length);
  // Members can end up on OPPOSITE teams, so "the squad won" is only true when
  // everyone won — otherwise the group result is mixed and each block speaks
  // for itself.
  const sameSide = p.players.every((x) => x.win === p.players[0].win);

  // Deep link to the game's own page — the closest thing to a button a plain
  // channel webhook can send (real components need an application-owned
  // webhook, i.e. a bot).
  const matchUrl = `${SITE}/matches/${p.matchId}`;

  const matchField = {
    name: "Match",
    value:
      `${queue} · ${fmtDuration(p.durationSec)}` +
      (p.avgLadderScore ? `\nAvg elo **${scoreToTier(p.avgLadderScore)}**` : "") +
      `\n**[▸ Open match page](${matchUrl})**  ·  [lobby feed](${lobbyUrl})`,
    inline: false,
  };

  // "Faker on Kha'Zix, Caps on Nidalee" — who else was in the game.
  const notableField =
    p.notables && p.notables.length > 0
      ? {
          name: p.notables.length === 1 ? "Notable player" : "Notable players",
          value: p.notables
            .map(
              (n) =>
                `${n.kind === "pro" ? "🏆" : "📺"} **[${n.name}](${SITE}/players/${n.slug})** on ${n.championName}`
            )
            .join("\n"),
          inline: false,
        }
      : null;

  return p.players.map((x, i) => {
    const last = i === p.players.length - 1;
    const result = isRemake ? "REMAKE" : x.win ? "VICTORY" : "DEFEAT";
    const color = isRemake ? COLOR_REMAKE : x.win ? COLOR_WIN : COLOR_LOSS;
    const link = profileUrl(x.region, x.riotId);

    const embed: Record<string, unknown> = {
      // Party games are numbered so the blocks read as one group instead of
      // unrelated messages that happen to be adjacent. Deliberately a bare
      // counter, NOT "DUO 1/2": the party size and the Solo/Duo queue are
      // different things and putting the word here made the two unreadable.
      // The size word lives in the footer; the queue lives on the rank line.
      title: party
        ? `${result} · ${x.displayName} — ${x.championName}  ·  ${i + 1}/${p.players.length}`
        : `${result} · ${x.displayName} — ${x.championName}`,
      // The title is the primary click target → the match page.
      //
      // The `#pN` fragment is LOad-BEARING: Discord MERGES embeds that share an
      // identical `url` into a single embed (that is how the multi-image
      // gallery trick works). With every squad member pointing at the same
      // match page, only the first block survived and the partner silently
      // vanished. A distinct fragment keeps them separate; the SPA router
      // ignores it, so each title still opens the same match page.
      url: p.players.length > 1 ? `${matchUrl}#p${i + 1}` : matchUrl,
      color,
      // The account that played, linking to its loldata profile — the title
      // is spoken for by the match page now.
      ...(link && x.riotId ? { description: `[${x.riotId}](${link})` } : {}),
      fields: last
        ? [...statFields(x), ...(notableField ? [notableField] : []), matchField]
        : statFields(x),
      thumbnail: {
        url: `${CDN}/${version}/img/champion/${champFile(x.championName)}.png`,
      },
    };
    // Author on the first, footer/timestamp on the last — the group reads as
    // one card with a single header and a single footer.
    // Author = the player's RANK: real crest image + tier + LP change. An
    // embed's author is the only per-embed slot that takes a small icon, and
    // the champion already owns the thumbnail — so the rank goes here instead
    // of being approximated with an emoji.
    embed.author = {
      name: rankLine(x, queueShort),
      ...(rankIconUrl(x.tier) ? { icon_url: rankIconUrl(x.tier) } : {}),
    };
    // Lobby + party identity moved to the footer, which the author slot used
    // to hold.
    if (last) {
      embed.footer = {
        text:
          `${p.lobbyName} · ${queue}` +
          `${party ? ` · ${party} party${sameSide ? "" : ", opposite sides"}` : ""}` +
          ` · loldata.cc`,
      };
      embed.timestamp = new Date(p.gameEndMs ?? Date.now()).toISOString();
    }
    return embed;
  });
}

export type DeliveryResult = { ok: true } | { ok: false; error: string; permanent: boolean };

/** Name + picture shown as the message author. */
export type WebhookIdentity = {
  username?: string | null;
  avatarUrl?: string | null;
};

export const DEFAULT_WEBHOOK_USERNAME = "lolData Scout";
// A REAL image (128×128 png). The old default pointed at /favicon-192.png,
// which the SPA serves as index.html — Discord got text/html, couldn't decode
// it, and rendered no avatar at all.
export const DEFAULT_WEBHOOK_AVATAR = `${SITE}/logo.png`;

/**
 * POST embeds to a Discord webhook as ONE message (Discord caps a message at
 * 10 embeds; a squad game never exceeds 5).
 *
 * `identity` overrides the name/picture Discord has configured for the webhook.
 * Both fields are omitted when empty, which hands the identity back to Discord
 * — that is how a user gets an uploaded image instead of a hosted URL.
 *
 * Retries once on 429 honouring retry_after. Returns (never throws) so the
 * caller can record the failure on the row.
 * `permanent` = the webhook is gone/invalid (404/401/403) → auto-disable.
 */
export async function postToWebhook(
  url: string,
  embeds: Record<string, unknown>[],
  identity?: WebhookIdentity
): Promise<DeliveryResult> {
  const payload: Record<string, unknown> = { embeds: embeds.slice(0, 10) };
  if (identity?.username) payload.username = identity.username;
  if (identity?.avatarUrl) payload.avatar_url = identity.avatarUrl;
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), DISCORD_TIMEOUT_MS);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctl.signal,
      });
      clearTimeout(t);

      if (res.ok || res.status === 204) return { ok: true };

      if (res.status === 429 && attempt === 0) {
        let waitMs = 1500;
        try {
          const j: any = await res.json();
          if (typeof j?.retry_after === "number") waitMs = Math.min(10_000, j.retry_after * 1000);
        } catch { /* body wasn't json — use the default backoff */ }
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const permanent = res.status === 401 || res.status === 403 || res.status === 404;
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status}${text ? ` — ${text}` : ""}`, permanent };
    } catch (e: any) {
      if (attempt === 1) {
        return { ok: false, error: e?.name === "AbortError" ? "timeout" : String(e?.message ?? e), permanent: false };
      }
    }
  }
  return { ok: false, error: "unreachable", permanent: false };
}

/** Only real Discord webhook endpoints — blocks SSRF to internal hosts. */
export function isValidDiscordWebhook(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const okHost =
      u.hostname === "discord.com" ||
      u.hostname === "discordapp.com" ||
      u.hostname === "canary.discord.com" ||
      u.hostname === "ptb.discord.com";
    return okHost && u.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

/**
 * Ask Discord which channel a webhook belongs to.
 *
 * A plain GET on the webhook URL returns the webhook object — the token in the
 * path IS the credential, so this needs no bot and no scopes. We store the
 * result so the bot can map "/live typed in channel X" back to a lobby.
 * Returns null on any failure; the channel binding is a convenience, never a
 * reason to reject an otherwise valid webhook.
 */
export async function resolveWebhookChannel(
  url: string
): Promise<{ channelId: string | null; guildId: string | null } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return { channelId: j?.channel_id ?? null, guildId: j?.guild_id ?? null };
  } catch {
    return null;
  }
}

/** Avatar URLs are fetched by DISCORD, not by us — this is a sanity check on
 *  what the user typed, not an SSRF guard. */
export function isValidAvatarUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && raw.length <= 500;
  } catch {
    return false;
  }
}

/** "https://discord.com/api/webhooks/123456/abcdef…" → "…/123456/abc•••" */
export function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean); // api, webhooks, id, token
    const id = parts[2] ?? "";
    const token = parts[3] ?? "";
    return `discord.com/…/${id}/${token.slice(0, 4)}•••`;
  } catch {
    return "invalid url";
  }
}
