// src/server/routes/getPlayerChampionRunes.ts
//
// "Import the runes THAT player ran on the champion I just locked."
//
// ⚠️ SERVED LIVE FROM RIOT, never from our own match tables, and that is a
// correctness decision rather than a performance one. The box's `participants`
// is coverage-limited and lags roughly seventy days on the tail, so "the last
// 30 ranked games of an arbitrary Riot ID" is a set we simply do not hold.
// Answering "NO AZIR IN THEIR LAST 30" out of partial coverage would be a lie
// about the player rather than a fact about us — and this whole panel already
// refuses to hand over another lane's runes for exactly that reason.
//
// ⚠️ `participant.perks` on a match-v5 match IS the page that player ran, in
// slot order, with the stat shards beside it. Nothing is inferred, reconstructed
// or guessed. That is the only reason this feature can exist at all.

import {
  getAccountByRiotId,
  getMatchDetails,
  getMatchIdsByPuuidOpts,
  RateLimitError,
} from "../riot";

/* ── caches ──────────────────────────────────────────────────────────────
   ⚠️ Match objects are cached by ID and SHARED with nothing: getMatches.ts
   keeps its own private map. Two caches double the Riot bill for the same
   games, so if these two ever need to agree, extract one module — do not
   copy a third.                                                            */
const matchCache = new Map<string, { data: any; ts: number }>();
const MATCH_TTL_MS = 10 * 60 * 1000;
const MATCH_CACHE_MAX = 500;

const puuidCache = new Map<string, { puuid: string; ts: number }>();
const PUUID_TTL_MS = 30 * 60 * 1000;

const idsCache = new Map<string, { ids: string[]; ts: number }>();
const IDS_TTL_MS = 60 * 1000;

/** Whole-answer cache, so an impatient second Enter costs nothing. */
const answerCache = new Map<string, { json: any; ts: number }>();
const ANSWER_TTL_MS = 30 * 1000;

const QUEUE_SOLO = 420;
const BATCH_SIZE = 5; // same pace getMatches.ts uses against the same limits

function getMatch(id: string): any | null {
  const e = matchCache.get(id);
  if (!e) return null;
  if (Date.now() - e.ts > MATCH_TTL_MS) {
    matchCache.delete(id);
    return null;
  }
  return e.data;
}

function putMatch(id: string, data: any): void {
  if (matchCache.size >= MATCH_CACHE_MAX) {
    const k = matchCache.keys().next().value;
    if (k) matchCache.delete(k);
  }
  matchCache.set(id, { data, ts: Date.now() });
}

async function matchWithRetry(id: string, region: string, retries = 2): Promise<any> {
  const hit = getMatch(id);
  if (hit) return hit;
  for (let i = 0; i <= retries; i++) {
    try {
      const m = await getMatchDetails(id, region);
      putMatch(id, m);
      return m;
    } catch (err) {
      if (err instanceof RateLimitError && i < retries) {
        await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 1000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * The page, in the ONE order the League client will accept.
 *
 * ⚠️ THE ORDER IS THE CONTRACT. The desktop app's `toSelectedPerkIds` does not
 * sort, validate or infer anything — it concatenates and counts to nine. So the
 * ids have to leave here already in slot order: keystone first, then the three
 * primary minors, then the two secondary perks, then the shards in row order
 * offense / flex / defense. Riot gives `styles[].selections` in slot order and
 * `statPerks` as a named triple, so the mapping is direct — but nothing
 * downstream will catch a mistake, and the client rejects a bad page with a
 * message the player cannot act on.
 */
function pageFrom(perks: any): {
  primary: number[];
  secondary: number[];
  shards: number[];
  primaryStyle: number;
  subStyle: number;
  keystone: number;
} | null {
  const styles = perks?.styles;
  if (!Array.isArray(styles) || styles.length < 2) return null;

  // Riot has been known to order the styles by id rather than by role, so the
  // primary is found by its own description, never by its index.
  const prim = styles.find((s: any) => s?.description === "primaryStyle") ?? styles[0];
  const sub = styles.find((s: any) => s?.description === "subStyle") ?? styles[1];

  const primary = (prim?.selections ?? []).map((s: any) => Number(s?.perk)).filter(Boolean);
  const secondary = (sub?.selections ?? []).map((s: any) => Number(s?.perk)).filter(Boolean);
  const sp = perks?.statPerks ?? {};
  const shards = [Number(sp.offense), Number(sp.flex), Number(sp.defense)].filter(Boolean);

  if (primary.length !== 4 || secondary.length !== 2 || shards.length !== 3) return null;
  const primaryStyle = Number(prim?.style);
  const subStyle = Number(sub?.style);
  if (!primaryStyle || !subStyle) return null;

  return { primary, secondary, shards, primaryStyle, subStyle, keystone: primary[0]! };
}

type Body = {
  name?: string;
  tag?: string;
  region?: string;
  championId?: number;
  championName?: string;
  role?: string | null;
  count?: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function getPlayerChampionRunesHandler(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "bad-body" }, 400);
  }

  const name = (body.name ?? "").trim();
  const tag = (body.tag ?? "").trim().replace(/^#/, "");
  const region = (body.region ?? "EUW").trim().toUpperCase();
  const championId = Number(body.championId);
  const championName = (body.championName ?? "").trim();
  const role = body.role ? String(body.role).toUpperCase() : null;
  const count = Math.min(30, Math.max(1, Number(body.count) || 30));

  if (!name || !tag || !championId) return json({ error: "bad-body" }, 400);

  const key = `${name.toLowerCase()}#${tag.toLowerCase()}|${championId}|${count}`;
  const cachedAnswer = answerCache.get(key);
  if (cachedAnswer && Date.now() - cachedAnswer.ts < ANSWER_TTL_MS) {
    return json(cachedAnswer.json);
  }

  try {
    // 1 ── the Riot ID → puuid
    const pKey = `${name.toLowerCase()}#${tag.toLowerCase()}`;
    let puuid = "";
    const pc = puuidCache.get(pKey);
    if (pc && Date.now() - pc.ts < PUUID_TTL_MS) {
      puuid = pc.puuid;
    } else {
      const acc = await getAccountByRiotId(name, tag, region).catch(() => null);
      if (!acc?.puuid) return json({ error: "no-such-riot-id" }, 404);
      puuid = acc.puuid;
      puuidCache.set(pKey, { puuid, ts: Date.now() });
    }

    // 2 ── their last N ranked solo games
    const iKey = `${puuid}|${count}`;
    let ids: string[] = [];
    const ic = idsCache.get(iKey);
    if (ic && Date.now() - ic.ts < IDS_TTL_MS) {
      ids = ic.ids;
    } else {
      ids = await getMatchIdsByPuuidOpts(puuid, region, {
        start: 0,
        count,
        queue: QUEUE_SOLO,
        type: "ranked",
      });
      idsCache.set(iKey, { ids, ts: Date.now() });
    }

    if (!ids.length) {
      const out = { hit: null, checked: 0, partial: false, champions: [] as any[] };
      answerCache.set(key, { json: out, ts: Date.now() });
      return json(out);
    }

    // 3 ── walk them NEWEST FIRST and stop at the first game on this champion.
    //      Only the miss pays for all thirty, and the miss is the answer that
    //      has to be able to say "not in the last 30" truthfully.
    let checked = 0;
    let partial = false;
    let hit: any = null;
    let games = 0;
    let wins = 0;
    let offRole = 0;
    const others = new Map<string, number>();

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map((id) => matchWithRetry(id, region))
      );

      for (const s of settled) {
        if (s.status !== "fulfilled" || !s.value) {
          // A game we could not read is a hole in the window, and the answer
          // says so rather than pretending the window was complete.
          partial = true;
          continue;
        }
        checked++;
        const m = s.value;
        const me = (m.info?.participants ?? []).find((p: any) => p?.puuid === puuid);
        if (!me) {
          partial = true;
          continue;
        }
        if (Number(me.championId) !== championId) {
          const n = String(me.championName ?? "");
          if (n) others.set(n, (others.get(n) ?? 0) + 1);
          continue;
        }

        /**
         * ⚠️ THE ROLE IS A FILTER, not a footnote.
         *
         * A Qiyana jungle page handed to someone locking Qiyana mid is another
         * lane's runes, which is the one thing this panel is not allowed to do
         * — `runeGap` exists precisely so the app can say "no data for this
         * role" rather than borrow a page from a different one. A searched
         * player must be held to the same rule as the cohort.
         *
         * A game with no `teamPosition` at all is accepted: that is us being
         * unable to tell, not evidence of a different lane, and dropping it
         * would silently shrink the window.
         */
        const pos = String(me.teamPosition ?? "").toUpperCase();
        if (role && pos && pos !== role) {
          offRole++;
          continue;
        }

        games++;
        if (me.win) wins++;
        if (!hit) {
          const page = pageFrom(me.perks);
          if (!page) {
            // A game on the right champion whose page we cannot read is not a
            // hit — importing half a page is worse than importing none.
            partial = true;
            continue;
          }
          const end = Number(m.info?.gameEndTimestamp ?? m.info?.gameStartTimestamp ?? 0);
          hit = {
            page,
            matchId: m.metadata?.matchId ?? null,
            win: !!me.win,
            k: Number(me.kills ?? 0),
            d: Number(me.deaths ?? 0),
            a: Number(me.assists ?? 0),
            role: me.teamPosition ?? null,
            sameRole: !!role && String(me.teamPosition ?? "").toUpperCase() === role,
            agoDays: end ? Math.max(0, Math.round((Date.now() - end) / 86_400_000)) : null,
          };
        }
      }

      // Everything newer than the hit is resolved by construction — the walk is
      // in order — so the moment there is one, there is nothing left to learn
      // about which page is the most recent.
      if (hit) break;
    }

    const out = hit
      ? {
          hit: {
            ...hit,
            games,
            wins,
            winrate: games ? (wins / games) * 100 : 0,
            championName,
          },
          checked,
          partial,
          champions: [] as { name: string; games: number }[],
          offRole,
        }
      : {
          hit: null,
          checked,
          partial,
          // How many times they DID play the champion, just not in this lane.
          // It is the difference between "they do not play this" and "they
          // play this, elsewhere" — two answers that deserve different words.
          offRole,
          // What they DID play is what turns a dead end into something the
          // player can act on — they can search a different champion, or know
          // this account is not the one they meant.
          champions: [...others.entries()]
            .map(([n, g]) => ({ name: n, games: g }))
            .sort((a, b) => b.games - a.games)
            .slice(0, 4),
        };

    answerCache.set(key, { json: out, ts: Date.now() });
    return json(out);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return json({ error: "rate-limited", retryAfterMs: err.retryAfterMs ?? 5000 }, 429);
    }
    console.error("[player-champion-runes]", (err as any)?.message ?? err);
    return json({ error: "riot-unavailable" }, 502);
  }
}
