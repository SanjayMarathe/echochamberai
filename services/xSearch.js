import { TwitterApi } from 'twitter-api-v2';

const TWEET_FIELDS = ['public_metrics', 'conversation_id', 'author_id', 'created_at', 'attachments'];
const USER_FIELDS = ['name', 'username', 'profile_image_url'];
const MEDIA_FIELDS = ['type', 'url', 'preview_image_url', 'variants', 'duration_ms'];

function buildClient(accessToken) {
  return accessToken instanceof TwitterApi ? accessToken : new TwitterApi(accessToken);
}

function resolveAuthors(includes) {
  const users = includes?.users ?? [];
  return Object.fromEntries(users.map(u => [u.id, u]));
}

function resolveMedia(includes) {
  const media = includes?.media ?? [];
  return Object.fromEntries(media.map(m => [m.media_key, m]));
}

// Pick the best mp4 variant from a video media object
function bestVideoUrl(media) {
  if (!media?.variants) return null;
  const mp4s = media.variants
    .filter(v => v.content_type === 'video/mp4' && v.url)
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0));
  return mp4s[0]?.url ?? null;
}

function extractMedia(tweet, mediaById) {
  const keys = tweet.attachments?.media_keys ?? [];
  for (const key of keys) {
    const m = mediaById[key];
    if (!m) continue;
    if (m.type === 'video' || m.type === 'animated_gif') {
      const url = bestVideoUrl(m);
      if (url) return { type: 'video', url, preview: m.preview_image_url ?? null };
    }
    if (m.type === 'photo' && m.url) {
      return { type: 'photo', url: m.url };
    }
  }
  return null;
}

// Progressively strip operators to broaden the query
function relaxQuery(query) {
  return query
    .replace(/min_faves:\d+/g, '')
    .replace(/min_retweets:\d+/g, '')
    .replace(/min_replies:\d+/g, '')
    .replace(/has:\S+/g, '')
    .replace(/lang:\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Extract only plain keywords, dropping all Twitter operators and exclusions
function keywordsOnly(query) {
  return query
    .split(/\s+/)
    .filter(t => !t.startsWith('-') && !t.includes(':') && !/^["(]/.test(t))
    .slice(0, 3)
    .join(' ')
    .trim();
}

// For video search: use only the first 1-2 keywords so has:videos has room to find results
function videoKeywords(query) {
  return query
    .split(/\s+/)
    .filter(t => !t.startsWith('-') && !t.includes(':') && !/^["(]/.test(t))
    .slice(0, 2)
    .join(' ')
    .trim();
}

function normaliseTweet(t, usersById, mediaById) {
  return {
    id: t.id,
    text: t.text,
    created_at: t.created_at,
    conversation_id: t.conversation_id,
    author_id: t.author_id,
    public_metrics: t.public_metrics,
    author: usersById[t.author_id] ?? null,
    media: extractMedia(t, mediaById),
  };
}

async function searchTweets(client, q) {
  const res = await client.v2.search(q, {
    max_results: 100,
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    expansions: ['author_id', 'attachments.media_keys'],
  });
  const tweets = res.data.data ?? [];
  const usersById = resolveAuthors(res.data.includes);
  const mediaById = resolveMedia(res.data.includes);
  return { tweets, usersById, mediaById };
}

export async function fetchTopPosts(accessToken, query) {
  const client = buildClient(accessToken);
  const seen = new Set();
  const withVideo = [];
  const withoutVideo = [];

  const relaxed = relaxQuery(query);
  const keywords = keywordsOnly(query);
  const vkw = videoKeywords(query);

  // Ladder: 1-2 keyword video search → original → relaxed → bare keywords
  const ladder = [
    `${vkw} has:videos`,  // short keywords + has:videos for broadest video reach
    query,                 // original with -is:retweet etc.
    relaxed,               // stripped operators
    keywords,              // bare keywords fallback
  ].filter((q, i, arr) => q && arr.indexOf(q) === i); // dedupe

  for (const q of ladder) {
    const haveEnough = (withVideo.length + withoutVideo.length) >= 5;
    if (haveEnough) break;
    console.log(`[xSearch] query: "${q}" (videos:${withVideo.length} other:${withoutVideo.length})`);
    try {
      const { tweets, usersById, mediaById } = await searchTweets(client, q);
      console.log(`[xSearch] got ${tweets.length} results`);
      for (const t of tweets) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const norm = normaliseTweet(t, usersById, mediaById);
        if (norm.media?.type === 'video') {
          withVideo.push(norm);
        } else {
          withoutVideo.push(norm);
        }
      }
    } catch (err) {
      console.warn(`[xSearch] query failed: ${err?.message}`);
    }
  }

  const byLikes = (a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0);

  // Return exactly 5 tweets sorted by likes — no video bias, strict count.
  const all = [...withVideo, ...withoutVideo].sort(byLikes).slice(0, 5);
  return all;
}

export async function reconstructThread(accessToken, conversationId, authorId) {
  const client = buildClient(accessToken);
  try {
    const res = await client.v2.search(
      `conversation_id:${conversationId} from:${authorId}`,
      { max_results: 20, 'tweet.fields': ['created_at', 'author_id', 'text'] }
    );
    const replies = res.data.data ?? [];
    return replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  } catch {
    return [];
  }
}

export async function fetchUserTweets(accessToken, userId) {
  const client = buildClient(accessToken);
  const res = await client.v2.userTimeline(userId, {
    max_results: 50,
    'tweet.fields': ['created_at', 'public_metrics', 'conversation_id', 'text'],
    'user.fields': USER_FIELDS,
    expansions: ['author_id'],
  });
  return res.data.data ?? [];
}
