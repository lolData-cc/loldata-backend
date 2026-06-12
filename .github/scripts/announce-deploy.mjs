// .github/scripts/announce-deploy.mjs
//
// Posts a "deploy changelog" to a Discord webhook on every push to the
// default branch. Run by the `announce-deploy.yml` GitHub Action in each
// repo (frontend / backend / this bot). The content = the feature bullets
// from the commit messages included in the push (merge commits are
// skipped so the underlying feat/fix commit's bullets surface).
//
// Reads from the environment (all provided by GitHub Actions):
//   DISCORD_DEPLOY_WEBHOOK  - the private channel's webhook URL (secret)
//   REPO_LABEL              - "Frontend" | "Backend" | "Bot" (display)
//   GITHUB_EVENT_PATH       - path to the push event payload (auto-set)
//   GITHUB_REPOSITORY       - "owner/name" (auto-set, fallback)
//   DRY_RUN                 - if set, print the payload instead of posting
//
// No npm deps — uses Node 18+ global fetch + top-level await (.mjs).

import { readFileSync } from "node:fs";

const webhook = process.env.DISCORD_DEPLOY_WEBHOOK;
const dryRun = !!process.env.DRY_RUN;

if (!webhook && !dryRun) {
  console.log("DISCORD_DEPLOY_WEBHOOK not set — skipping announcement.");
  process.exit(0);
}

const label = process.env.REPO_LABEL || "App";
const eventPath = process.env.GITHUB_EVENT_PATH;
const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};

const commits = Array.isArray(event.commits) ? event.commits : [];
const repoName =
  event.repository?.full_name || process.env.GITHUB_REPOSITORY || "";
const compareUrl = event.compare || event.head_commit?.url || "";

const JADE = 0x00d992;

// "merge: …" / "Merge branch …" commits carry no feature bullets — skip
// them so the real feat/fix commit underneath gets announced.
const isMerge = (msg) => /^merge\b/i.test(msg.trim());

// Pull the title + "- " bullets out of each non-merge commit in the push.
const sections = [];
for (const c of commits) {
  const msg = (c.message || "").trim();
  if (!msg || isMerge(msg)) continue;
  const lines = msg.split("\n");
  const title = lines[0].trim();
  const bullets = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l && !/co-authored-by/i.test(l))
    .map((l) => `• ${l}`);
  sections.push({ title, bullets });
}

// Fallback: a push of only merge commits → use the head commit's title.
if (sections.length === 0 && event.head_commit) {
  const title = (event.head_commit.message || "").split("\n")[0].trim();
  if (title) sections.push({ title, bullets: [] });
}

if (sections.length === 0) {
  console.log("Nothing to announce (no feature commits in this push).");
  process.exit(0);
}

let description = "";
for (const s of sections) {
  description += `**${s.title}**\n`;
  if (s.bullets.length) description += `${s.bullets.join("\n")}\n`;
  description += "\n";
}
description = description.trim().slice(0, 4000); // Discord embed cap

const author =
  event.head_commit?.author?.username ||
  event.head_commit?.author?.name ||
  event.pusher?.name ||
  "";
const sha = (event.head_commit?.id || "").slice(0, 7);

const footerBits = [repoName, sha && `#${sha}`, author && `by ${author}`].filter(
  Boolean
);

const embed = {
  author: { name: "loldata · deploy" },
  title: `🚀 ${label} deployed → ${event.ref?.split("/").pop() || "master"}`,
  url: compareUrl || undefined,
  description,
  color: JADE,
  footer: { text: footerBits.join("  ·  ") },
  timestamp: new Date().toISOString(),
};

const payload = { username: "loldata", embeds: [embed] };

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  console.error(
    `Discord webhook failed: ${res.status} ${await res.text().catch(() => "")}`
  );
  process.exit(1);
}
console.log(`Announced ${label} deploy — ${sections.length} commit(s).`);
