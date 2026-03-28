import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { TwitterApi } from 'twitter-api-v2';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateViewpoints, matchUserTweets, classifyTweetIntent } from './services/gemini.js';
import { fetchTopPosts, reconstructThread, fetchUserTweets } from './services/xSearch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const {
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  CALLBACK_URL = 'http://localhost:3000/callback',
  SESSION_SECRET = 'change-me-in-production',
  PORT = 3000,
} = process.env;

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

app.use(express.json());
app.use(express.static(__dirname));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Dashboard — guarded: redirect to / if not authenticated
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// Step 1: Start OAuth flow
app.get('/auth/twitter', (req, res) => {
  const client = new TwitterApi({ clientId: X_CLIENT_ID });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: ['users.read', 'tweet.read'],
  });
  req.session.codeVerifier = codeVerifier;
  req.session.oauthState = state;
  res.redirect(url);
});

// Step 2: Handle callback from X
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const { codeVerifier, oauthState } = req.session;

  if (!codeVerifier || !state || state !== oauthState || !code) {
    return res.status(400).send('Invalid OAuth state. Please try again.');
  }

  try {
    const client = new TwitterApi({ clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET });
    const { client: userClient, accessToken } = await client.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: CALLBACK_URL,
    });

    const { data: user } = await userClient.v2.me();
    req.session.user = { id: user.id, name: user.name, username: user.username };
    req.session.accessToken = accessToken;
    delete req.session.codeVerifier;
    delete req.session.oauthState;
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(403).send('Authentication failed. Please try again.');
  }
});

// API: return current user from session
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

// API: return tweets for the authenticated user via search
app.get('/api/feed', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const userClient = new TwitterApi(req.session.accessToken);
    const username = req.session.user.username;

    const results = await userClient.v2.search(`from:${username}`, {
      max_results: 10,
      'tweet.fields': ['created_at', 'author_id'],
      'user.fields': ['name', 'username', 'profile_image_url'],
      expansions: ['author_id'],
    });

    const tweets = results.data.data ?? [];
    const users = results.data.includes?.users ?? [];
    const usersById = Object.fromEntries(users.map(u => [u.id, u]));

    const feed = tweets.map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      author: usersById[tweet.author_id] ?? req.session.user,
    }));

    res.json(feed);
  } catch (err) {
    console.error(err);
    if (err.code === 402) {
      return res.status(402).json({ error: 'X API Basic tier required to read tweets. Upgrade at developer.twitter.com.' });
    }
    res.status(500).json({ error: 'Failed to fetch tweets' });
  }
});

// API: analyze a single tweet and return viewpoint threads if debatable
app.post('/api/feed/analyze-tweet', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const { tweet_text } = req.body;
  if (!tweet_text?.trim()) return res.status(400).json({ error: 'tweet_text is required' });

  try {
    const { debatable } = await classifyTweetIntent(tweet_text);
    if (!debatable) return res.json({ debatable: false });

    const { viewpoint_a, viewpoint_b } = await generateViewpoints(tweet_text);

    const [postsA, postsB] = await Promise.all([
      fetchTopPosts(req.session.accessToken, viewpoint_a.query),
      fetchTopPosts(req.session.accessToken, viewpoint_b.query),
    ]);

    const [threadsA, threadsB] = await Promise.all([
      Promise.all(postsA.map(async p => ({
        root: p,
        replies: await reconstructThread(req.session.accessToken, p.conversation_id, p.author_id),
      }))),
      Promise.all(postsB.map(async p => ({
        root: p,
        replies: await reconstructThread(req.session.accessToken, p.conversation_id, p.author_id),
      }))),
    ]);

    res.json({
      debatable: true,
      viewpoint_a_label: viewpoint_a.label,
      viewpoint_b_label: viewpoint_b.label,
      viewpoint_a_threads: threadsA,
      viewpoint_b_threads: threadsB,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// Research page — auth guarded
app.get('/research', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(join(__dirname, 'research.html'));
});

// API: Viewpoint comparison
app.post('/api/research/compare-viewpoints', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const { user_prompt } = req.body;
  if (!user_prompt?.trim()) return res.status(400).json({ error: 'user_prompt is required' });

  const { accessToken, user } = req.session;

  try {
    // 1. Run viewpoint generation + user tweet fetch in parallel
    const [{ viewpoint_a, viewpoint_b }, userTweets] = await Promise.all([
      generateViewpoints(user_prompt),
      fetchUserTweets(accessToken, user.id).catch(() => []),
    ]);

    // 2. Always attempt semantic match against user's tweets (non-fatal)
    let userPerspective = [];
    try {
      if (userTweets.length > 0) {
        const { matched_ids } = await matchUserTweets(user_prompt, userTweets);
        const matchedTweets = userTweets.filter(t => matched_ids.includes(t.id));
        if (matchedTweets.length > 0) {
          userPerspective = await Promise.all(
            matchedTweets.map(async t => ({
              root: { ...t, author: user },
              replies: await reconstructThread(accessToken, t.conversation_id, user.id),
            }))
          );
        }
      }
    } catch {
      // Non-fatal: skip user perspective silently
    }

    // 4. Fetch top posts for both viewpoints in parallel
    const [postsA, postsB] = await Promise.all([
      fetchTopPosts(accessToken, viewpoint_a.query),
      fetchTopPosts(accessToken, viewpoint_b.query),
    ]);

    // 5. Reconstruct threads for all posts in parallel
    const [threadsA, threadsB] = await Promise.all([
      Promise.all(postsA.map(async p => ({
        root: p,
        replies: await reconstructThread(accessToken, p.conversation_id, p.author_id),
      }))),
      Promise.all(postsB.map(async p => ({
        root: p,
        replies: await reconstructThread(accessToken, p.conversation_id, p.author_id),
      }))),
    ]);

    res.json({
      viewpoint_a_label: viewpoint_a.label,
      viewpoint_b_label: viewpoint_b.label,
      viewpoint_a_threads: threadsA,
      viewpoint_b_threads: threadsB,
      ...(userPerspective.length > 0 && { user_perspective: userPerspective }),
    });

  } catch (err) {
    console.error(err);
    if (err.code === 429) return res.status(429).json({ error: 'rate_limit', message: 'X API rate limit hit. Try again in 15 minutes.' });
    if (err.code === 402) return res.status(402).json({ error: 'upgrade_required', message: 'X API Basic tier required.' });
    res.status(500).json({ error: 'llm_failed', message: 'Something went wrong. Please try again.' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => {
  console.log(`EchoChamberAI running at http://localhost:${PORT}`);
});
