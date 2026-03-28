import { TwitterApi } from 'twitter-api-v2';

const TWEET_FIELDS = ['public_metrics', 'conversation_id', 'author_id', 'created_at'];
const USER_FIELDS = ['name', 'username', 'profile_image_url'];

function buildClient(accessToken) {
  return new TwitterApi(accessToken);
}

function resolveAuthors(includes) {
  const users = includes?.users ?? [];
  return Object.fromEntries(users.map(u => [u.id, u]));
}

function lowerMinFaves(query) {
  const steps = [
    ['min_faves:100', 'min_faves:50'],
    ['min_faves:50', 'min_faves:10'],
  ];
  for (const [from, to] of steps) {
    if (query.includes(from)) return query.replace(from, to);
  }
  return null;
}

export async function fetchTopPosts(accessToken, query) {
  const client = buildClient(accessToken);
  let currentQuery = query;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await client.v2.search(currentQuery, {
      max_results: 20,
      'tweet.fields': TWEET_FIELDS,
      'user.fields': USER_FIELDS,
      expansions: ['author_id'],
    });

    const tweets = res.data.data ?? [];
    if (tweets.length > 0) {
      const usersById = resolveAuthors(res.data.includes);
      const sorted = tweets
        .sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))
        .slice(0, 5);

      return sorted.map(t => ({
        id: t.id,
        text: t.text,
        created_at: t.created_at,
        conversation_id: t.conversation_id,
        author_id: t.author_id,
        public_metrics: t.public_metrics,
        author: usersById[t.author_id] ?? null,
      }));
    }

    const relaxed = lowerMinFaves(currentQuery);
    if (!relaxed) break;
    currentQuery = relaxed;
  }

  return [];
}

export async function reconstructThread(accessToken, conversationId, authorId) {
  const client = buildClient(accessToken);
  try {
    const res = await client.v2.search(
      `conversation_id:${conversationId} from:${authorId}`,
      {
        max_results: 20,
        'tweet.fields': ['created_at', 'author_id', 'text'],
      }
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
