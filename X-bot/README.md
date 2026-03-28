# 🤖 EchoChamber Bot

An X/Twitter bot that watches for `@echochamber_bot` mentions, extracts the topic from the tweet, and replies with a link to a generated AI debate video.

---

## How It Works

```
User tweets: "@echochamber_bot iran vs usa war"
         ↓
Bot polls X API every 60 seconds
         ↓
Detects new mention → extracts topic "iran vs usa war"
         ↓
Generates workflow link (→ your n8n / Veo pipeline)
         ↓
Replies: "@user 🎬 Two AI agents are about to go head-to-head on:
          "iran vs usa war"
          Watch the debate 👇
          https://echochamber.app/debate?topic=iran+vs+usa+war"
```

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js ≥ 18 | Uses native ES modules |
| X Developer Account | [developer.twitter.com](https://developer.twitter.com) |
| X API **Basic** plan ($100/mo) | Free tier cannot read mentions |
| A **bot X account** | Separate account for the bot (not your personal one) |

---

## Step 1 — Create the Bot X Account

1. Create a new X account: `@echochamber_bot` (or similar)
2. Log into [developer.twitter.com](https://developer.twitter.com) with that account
3. Create a new **App** under your project

---

## Step 2 — Set App Permissions

In the Developer Portal → Your App → **Settings**:
- Set **App permissions** to **Read and Write**
- Under **User authentication settings**, enable **OAuth 1.0a**
- Set callback URL to `https://localhost` (placeholder is fine)

---

## Step 3 — Get Your Credentials

In Developer Portal → Your App → **Keys and Tokens**:

| Key | Where to find it |
|---|---|
| `TWITTER_API_KEY` | "Consumer Keys" → API Key |
| `TWITTER_API_SECRET` | "Consumer Keys" → API Key Secret |
| `TWITTER_ACCESS_TOKEN` | "Access Token and Secret" → Access Token |
| `TWITTER_ACCESS_SECRET` | "Access Token and Secret" → Access Token Secret |

> ⚠️ Make sure the Access Token was generated with **Read and Write** permissions.

---

## Step 4 — Install & Configure

```bash
git clone <this-repo>
cd echochamber-bot

npm install

cp .env.example .env
# Edit .env and fill in your 4 credentials
```

---

## Step 5 — Run the Bot

```bash
npm start
```

You should see:
```
🤖 EchoChamber bot starting…
[2026-03-27T...] Polling for mentions…
  No new mentions.
```

Now tweet from your personal account `@Rohitecho44`:
```
@echochamber_bot iran vs usa war tensions
```

Within 60 seconds the bot will reply with the debate link.

---

## Connecting Your Real Video Pipeline (Next Step)

In `bot.js`, find this function and replace it with your actual n8n webhook call:

```js
function generateWorkflowLink(topic) {
  // TODO: replace with real n8n webhook trigger + Veo video generation
  const encoded = encodeURIComponent(topic.slice(0, 60));
  return `https://echochamber.app/debate?topic=${encoded}`;
}
```

**With n8n**, it would look like:

```js
async function generateWorkflowLink(topic) {
  const res = await fetch("https://your-n8n-instance.com/webhook/echochamber", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic }),
  });
  const { videoUrl } = await res.json();
  return videoUrl;
}
```

Your n8n workflow receives `{ topic }`, kicks off Veo video generation, and returns `{ videoUrl }`.

---

## Deploying (Keep It Running 24/7)

### Option A — Railway (easiest, free tier available)
1. Push to GitHub
2. Connect repo on [railway.app](https://railway.app)
3. Add your `.env` vars in Railway's dashboard
4. Deploy — done

### Option B — PM2 on a VPS
```bash
npm install -g pm2
pm2 start bot.js --name echochamber-bot
pm2 save
pm2 startup
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Node.js (ES Modules) |
| X API client | `twitter-api-v2` |
| Auth method | OAuth 1.0a (required for posting) |
| Mention detection | Polling (`GET /2/users/:id/mentions`) every 60s |
| Config | `dotenv` |
