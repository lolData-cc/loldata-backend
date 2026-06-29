# Telegram admin feed

A Telegram "admin feed" that pings you on the events worth knowing about. No bot
process to run — the backend just sends messages with a bot token.

## Events covered

| Event | Where it fires | Message |
|-------|----------------|---------|
| 💸 New subscriber | Stripe webhook (`checkout.session.completed`) | `New PREMIUM/ELITE subscriber — <nametag> — €x/mo` |
| 📉 Cancellation | Stripe webhook (`customer.subscription.*`) | `Subscription cancelled — <nametag> — premium → free` |
| 🔁 Plan change | Stripe webhook | `Plan changed — premium → elite` |
| 🔭 New scout lobby | `POST /api/scout` (`scout.ts`) | `New scout lobby — <name> · N players — link` |
| 🆕 New signup | Supabase webhook → `/api/admin/hooks/supabase` | `New signup — <nametag> · <region>` |
| ✉️ Contact message | `POST /api/contact` (`contact.ts`) — automatic | `New contact message — <subject> — <body>` |
| 📨 Streamer application | Supabase webhook on `streamer_applications` | `New streamer application — <twitch> · <region>` |
| 📨 Pro application | Supabase webhook on `proApplications` | `New pro application — <name> · <riot id> · <team>` |

If the env vars are unset everything is a silent no-op, so this never changes
prod behaviour until you wire it up.

## 1. Create the bot

1. In Telegram, message **@BotFather** → `/newbot` → pick a name + username.
2. He replies with a **token** like `123456789:AAE…`. That's `TELEGRAM_BOT_TOKEN`.

## 2. Get your chat id

1. Open your new bot, press **Start**, send it any message (e.g. `hi`).
2. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
3. Find `"chat":{"id":123456789, …}` → that number is `TELEGRAM_ADMIN_CHAT_ID`.
   (For a group: add the bot to the group, send a message, the id is negative.)

## 3. Set env vars (on BOTH deployments)

loldata-backend runs on the **box** (api2.loldata.cc) *and* **Railway**
(api.loldata.cc). Stripe webhooks hit Railway; scout/signup hit the box — so set
these in **both** places:

```
TELEGRAM_BOT_TOKEN=123456789:AAE…
TELEGRAM_ADMIN_CHAT_ID=123456789
ADMIN_WEBHOOK_SECRET=<any long random string>   # used by the Supabase webhook
```

Then redeploy / restart the service.

## 4. Verify

```
curl -H "x-webhook-secret: <ADMIN_WEBHOOK_SECRET>" https://api2.loldata.cc/api/admin/hooks/test
```
You should get a Telegram message: **✅ loldata admin feed online**.

## 5. Wire signups (Supabase webhook)

Subscriptions + scout lobbies are automatic (they flow through the backend).
Signups happen in Supabase Auth, so point a DB webhook at us:

1. Supabase dashboard → **Database → Webhooks → Create a new hook**.
2. Table **`profile_players`**, events **INSERT**.
3. Type **HTTP Request**, method **POST**,
   URL `https://api2.loldata.cc/api/admin/hooks/supabase`.
4. HTTP Headers → add `x-webhook-secret` = your `ADMIN_WEBHOOK_SECRET`.
5. Save. New signups now ping the feed.

### Applications (Supabase webhooks)
Same recipe as the signup webhook (same URL + `x-webhook-secret`), on **INSERT** of:
- **`streamer_applications`** — users apply on /streamers
- **`proApplications`** — pro applications (note: camelCase table; arrives via the Discord pipeline)

### Contact
Automatic — the /contact form POSTs to `POST /api/contact` and the message is
forwarded straight to the feed. No webhook, no inbox infra needed.
