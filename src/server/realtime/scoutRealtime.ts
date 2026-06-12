// src/server/realtime/scoutRealtime.ts
//
// Realtime hub for scout lobby live chat + bounty banners.
//
// Bun's `serve()` exposes pub/sub on the WebSocket server: a socket
// calls `ws.subscribe(topic)` and anyone can `server.publish(topic, …)`
// to fan a message out to every subscriber. We hold the server ref
// here (set once at startup) so the plain HTTP chat POST handler — which
// has no socket context — can still broadcast the message it just
// inserted to every open lobby page.
//
// Topic convention: `chat:<slug>`. One topic per lobby.
//
// ── Cross-instance fan-out ──────────────────────────────────────────
// `server.publish()` only reaches sockets connected to THIS process. The
// moment the backend runs more than one instance (Railway replicas /
// horizontal scale), a chat POST that lands on instance A would never
// reach a viewer whose socket is held by instance B — live chat silently
// breaks for half the lobby. To stay correct under scale we relay every
// broadcast through a Supabase Realtime channel that every instance joins:
// the origin instance publishes locally (instant, no round-trip) AND
// relays to the others, which re-publish to their own sockets. Self-echo
// is ignored via a per-process instance id. This reuses Supabase (no new
// infra) and is opt-in via SCOUT_WS_FANOUT=1 so single-instance / local
// dev keeps the pure in-process path with zero extra connections.

import type { Server } from "bun";
import { supabaseAdmin } from "../supabase/client";

// The per-connection data we stash on each upgraded socket.
export type ScoutWsData = { slug: string };

let serverRef: Server | null = null;

// Cross-instance relay channel (null when fan-out is disabled or not yet
// connected). Typed off the client so we don't import RealtimeChannel.
let fanoutChannel: ReturnType<typeof supabaseAdmin.channel> | null = null;

// Unique per process, so an instance can ignore its own echoed broadcast.
const INSTANCE_ID =
  globalThis.crypto?.randomUUID?.() ?? `inst-${process.pid}-${process.uptime()}`;
const FANOUT_CHANNEL = "scout-fanout";
const FANOUT_EVENT = "relay";

export function setRealtimeServer(server: Server): void {
  serverRef = server;
}

export function chatTopic(slug: string): string {
  return `chat:${slug}`;
}

// Publish to the sockets subscribed on THIS instance only.
function publishLocal(slug: string, data: string): void {
  if (!serverRef) return;
  serverRef.publish(chatTopic(slug), data);
}

// Relay to the OTHER instances via Supabase Realtime broadcast. No-op
// when fan-out is disabled / the channel isn't joined yet. Fire-and-forget
// — local delivery already happened, so a relay hiccup never blocks chat.
function relayCrossInstance(slug: string, data: string): void {
  if (!fanoutChannel) return;
  try {
    Promise.resolve(
      fanoutChannel.send({
        type: "broadcast",
        event: FANOUT_EVENT,
        payload: { origin: INSTANCE_ID, slug, data },
      })
    ).catch(() => {
      /* relay best-effort; local clients already received it */
    });
  } catch {
    /* channel not ready — ignore */
  }
}

// Broadcast a freshly-created chat message to every socket subscribed
// to this lobby (this instance now, every instance when fan-out is on).
// No-op until the server ref is set (i.e. before boot).
export function broadcastChatMessage(slug: string, message: unknown): void {
  const data = JSON.stringify({ type: "chat", message });
  publishLocal(slug, data);
  relayCrossInstance(slug, data);
}

// Broadcast a bounty event (claimed / surpassed) to the lobby's chat.
// These are ephemeral — they ride the same socket as chat but aren't
// persisted, so they appear live as an animated banner for whoever's
// watching. Same topic as chat so one subscription covers both.
export function broadcastBountyEvent(slug: string, event: unknown): void {
  const data = JSON.stringify({ type: "bounty", event });
  publishLocal(slug, data);
  relayCrossInstance(slug, data);
}

// Opt-in cross-instance fan-out (see header). Call once at startup. Only
// meaningful when the backend runs >1 instance; set SCOUT_WS_FANOUT=1 on
// every instance. Harmless with a single instance (self-echo is ignored),
// but left off by default so local dev opens no extra Realtime socket and
// can't cross-talk with prod on the shared Supabase project.
export function initRealtimeFanout(): void {
  if (process.env.SCOUT_WS_FANOUT !== "1") return;
  if (fanoutChannel) return;
  try {
    const channel = supabaseAdmin.channel(FANOUT_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channel.on("broadcast", { event: FANOUT_EVENT }, (msg: any) => {
      const payload = msg?.payload as
        | { origin?: string; slug?: string; data?: string }
        | undefined;
      if (!payload?.slug || typeof payload.data !== "string") return;
      if (payload.origin === INSTANCE_ID) return; // our own echo
      publishLocal(payload.slug, payload.data);
    });
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        console.log(
          `[scout realtime] cross-instance fan-out active (instance ${INSTANCE_ID}).`
        );
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[scout realtime] fan-out channel status: ${status}`);
      }
    });
    fanoutChannel = channel;
  } catch (err) {
    console.error("[scout realtime] failed to init fan-out:", err);
    fanoutChannel = null;
  }
}
