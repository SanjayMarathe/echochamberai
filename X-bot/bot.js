import { TwitterApi } from "twitter-api-v2";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// ── Twitter client ────────────────────────────────────────────────────────────
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const rwClient = client.readWrite;

// ── Persisted replied IDs ─────────────────────────────────────────────────────
const REPLIED_FILE = "./replied_ids.json";

function loadRepliedIds() {
  try {
    if (fs.existsSync(REPLIED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(REPLIED_FILE, "utf8")));
    }
  } catch {}
  return new Set();
}

function saveRepliedIds(set) {
  const arr = [...set].slice(-1000);
  fs.writeFileSync(REPLIED_FILE, JSON.stringify(arr), "utf8");
}

const repliedIds = loadRepliedIds();
let lastMentionId = process.env.SINCE_ID || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTopic(text) {
  const cleaned = text.replace(/^(@\w+\s*)+/i, "").trim();
  return cleaned || "a hot-button topic";
}

function generateWorkflowLink(twitterId) {
  return `https://unconfirmatory-kenia-trigonally.ngrok-free.dev/dashboard/${twitterId}`;
}

function buildReply(authorUsername, topic, link) {
  // Add a unique timestamp so X never flags it as duplicate content
  const ts = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return (
    `@${authorUsername} 🎬 Two AI agents are about to debate:\n` +
    `"${topic.slice(0, 80)}"\n\n` +
    `Watch the debate 👇\n${link}\n[${ts}]`
  );
}

// ── Core polling loop ─────────────────────────────────────────────────────────
async function pollMentions() {
  try {
    console.log(`[${new Date().toISOString()}] Polling for mentions…`);

    const me = await rwClient.v2.me();
    const params = {
      max_results: 10,
      "tweet.fields": ["author_id", "text", "conversation_id", "in_reply_to_user_id"],
      expansions: ["author_id"],
      "user.fields": ["username"],
    };

    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await rwClient.v2.userMentionTimeline(me.data.id, params);

    if (!mentions.data?.data?.length) {
      console.log("  No new mentions.");
      return;
    }

    const userMap = {};
    for (const u of mentions.data?.includes?.users ?? []) {
      userMap[u.id] = u.username;
    }

    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
      // Always update lastMentionId so we don't keep re-fetching old tweets
      if (!lastMentionId || BigInt(tweet.id) > BigInt(lastMentionId)) {
        lastMentionId = tweet.id;
      }

      // Skip if already replied
      if (repliedIds.has(tweet.id)) {
        console.log(`  ⏭️  Already handled ${tweet.id}, skipping.`);
        continue;
      }

      // Skip tweets authored by the bot itself (prevents replying to own replies)
      if (tweet.author_id === me.data.id) {
        console.log(`  ⏭️  Skipping own tweet ${tweet.id}`);
        repliedIds.add(tweet.id);
        saveRepliedIds(repliedIds);
        continue;
      }

      // Skip reply chains we're not the target of
      if (tweet.in_reply_to_user_id && tweet.in_reply_to_user_id !== me.data.id) {
        console.log(`  ⏭️  Skipping reply-chain tweet ${tweet.id}`);
        repliedIds.add(tweet.id);
        saveRepliedIds(repliedIds);
        continue;
      }

      const authorUsername = userMap[tweet.author_id] ?? tweet.author_id;
      const topic = extractTopic(tweet.text);
      const link = generateWorkflowLink(tweet.id);
      const reply = buildReply(authorUsername, topic, link);

      console.log(`  ↳ Replying to @${authorUsername} about "${topic}"`);

      try {
        await rwClient.v2.reply(reply, tweet.id);
        console.log(`  ✅ Reply sent!`);
      } catch (replyErr) {
        // Even if reply fails (duplicate, etc.), mark as handled so we don't retry forever
        console.error(`  ❌ Reply failed (${replyErr?.code}): ${replyErr?.message}`);
        if (replyErr?.data?.detail) console.error(`     Detail: ${replyErr.data.detail}`);
      }

      // Always mark as handled regardless of success/failure
      repliedIds.add(tweet.id);
      saveRepliedIds(repliedIds);
    }

    console.log(`  ✅ Done. Last id: ${lastMentionId}`);
  } catch (err) {
    if (err?.code === 429) {
      console.warn("  ⚠️  Rate limited – will retry next cycle.");
    } else {
      console.error("  ❌ Error code:", err?.code);
      console.error("  ❌ Error message:", err?.message);
      console.error("  ❌ Full error:", JSON.stringify(err?.data ?? err, null, 2));
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 20  * 1000;

console.log("🤖 EchoChamber bot starting…");
pollMentions();
setInterval(pollMentions, POLL_INTERVAL_MS);