// src/server/realtime/scoutRealtime.ts
//
// Tiny realtime hub for scout lobby live chat.
//
// Bun's `serve()` exposes pub/sub on the WebSocket server: a socket
// calls `ws.subscribe(topic)` and anyone can `server.publish(topic, …)`
// to fan a message out to every subscriber. We hold the server ref
// here (set once at startup) so the plain HTTP chat POST handler — which
// has no socket context — can still broadcast the message it just
// inserted to every open lobby page.
//
// Topic convention: `chat:<slug>`. One topic per lobby.

import type { Server } from "bun";

// The per-connection data we stash on each upgraded socket.
export type ScoutWsData = { slug: string };

let serverRef: Server | null = null;

export function setRealtimeServer(server: Server): void {
  serverRef = server;
}

export function chatTopic(slug: string): string {
  return `chat:${slug}`;
}

// Broadcast a freshly-created chat message to every socket subscribed
// to this lobby. No-op until the server ref is set (i.e. before boot).
export function broadcastChatMessage(slug: string, message: unknown): void {
  if (!serverRef) return;
  serverRef.publish(
    chatTopic(slug),
    JSON.stringify({ type: "chat", message })
  );
}

// Broadcast a bounty event (claimed / surpassed) to the lobby's chat.
// These are ephemeral — they ride the same socket as chat but aren't
// persisted, so they appear live as an animated banner for whoever's
// watching. Same topic as chat so one subscription covers both.
export function broadcastBountyEvent(slug: string, event: unknown): void {
  if (!serverRef) return;
  serverRef.publish(
    chatTopic(slug),
    JSON.stringify({ type: "bounty", event })
  );
}
