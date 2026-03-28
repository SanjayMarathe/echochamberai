import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import { TwitterApi } from 'twitter-api-v2';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { generateViewpoints, matchUserTweets, classifyTweetIntent, analyzeTweetFull, answerFromClips, generateAnswer, searchTweets, extractVideoTimestamp } from './services/gemini.js';
import { buildDebateScript, generateFullVideo } from './services/videoGenerator.js';
import { fetchTopPosts, reconstructThread, fetchUserTweets } from './services/xSearch.js';
import { getCachedAnalysis, cacheAnalysis, getVideoJob, upsertVideoJob } from './services/cache.js';
import { initIndex, ensureIndexed, queryVideos } from './services/twelvelabs.js';

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

// API: analyze a tweet — streams progress via SSE
app.get('/api/feed/analyze-tweet', async (req, res) => {
  const { tweet_id, tweet_text } = req.query;
  if (!tweet_text?.trim()) return res.status(400).end();

  // Use the authenticated user's token if available, otherwise fall back to bot credentials
  const xClient = req.session.accessToken ? req.session.accessToken : botClient;
  const excludeClause = req.session.user ? `-from:${req.session.user.username}` : '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Cache hit — instant complete
    if (tweet_id) {
      const cached = await getCachedAnalysis(tweet_id);
      if (cached) { emit({ type: 'complete', cached: true, ...cached }); return res.end(); }
    }

    emit({ type: 'progress', pct: 12, message: 'Classifying tweet…' });
    const metrics = await analyzeTweetFull(tweet_text);
    if (!metrics.debatable) { emit({ type: 'complete', debatable: false, ...metrics }); return res.end(); }

    emit({ type: 'progress', pct: 30, message: 'Generating viewpoints…' });
    const { viewpoint_a: va, viewpoint_b: vb } = await generateViewpoints(tweet_text);

    emit({ type: 'progress', pct: 48, message: `Searching X for "${va.label}" and "${vb.label}"…` });
    const [postsA, postsB] = await Promise.all([
      fetchTopPosts(xClient, `${va.query} ${excludeClause}`.trim()),
      fetchTopPosts(xClient, `${vb.query} ${excludeClause}`.trim()),
    ]);

    emit({ type: 'progress', pct: 65, message: `Pulled ${postsA.length + postsB.length} tweets — reconstructing threads…` });
    const [threadsA, threadsB] = await Promise.all([
      Promise.all(postsA.map(async p => ({
        root: p,
        replies: await reconstructThread(xClient, p.conversation_id, p.author_id),
      }))),
      Promise.all(postsB.map(async p => ({
        root: p,
        replies: await reconstructThread(xClient, p.conversation_id, p.author_id),
      }))),
    ]);

    emit({ type: 'progress', pct: 90, message: 'Finalising analysis…' });

    const totalA = threadsA.reduce((s, t) => s + (t.root.public_metrics?.like_count ?? 0), 0);
    const totalB = threadsB.reduce((s, t) => s + (t.root.public_metrics?.like_count ?? 0), 0);
    const totalEngagement = totalA + totalB;
    const viewpointBalance = totalEngagement > 0 ? Math.round((totalA / totalEngagement) * 100) : 50;

    const result = {
      debatable: true,
      bias_score: metrics.bias_score,
      sentiment: metrics.sentiment,
      framing: metrics.framing,
      echo_chamber_risk: metrics.echo_chamber_risk,
      discourse_type: metrics.discourse_type,
      viewpoint_a_label: va.label,
      viewpoint_b_label: vb.label,
      viewpoint_a_threads: threadsA,
      viewpoint_b_threads: threadsB,
      viewpoint_balance: viewpointBalance,
      total_engagement: totalEngagement,
    };

    if (tweet_id) cacheAnalysis(tweet_id, result).catch(() => {});
    emit({ type: 'complete', ...result });
    res.end();
  } catch (err) {
    console.error(err);
    emit({ type: 'error', message: err.status === 429 ? 'Rate limit hit — try again in 15 min.' : 'Analysis failed.' });
    res.end();
  }
});

// Expose Mapbox token to client
app.get('/api/mapbox-token', (req, res) => {
  res.json({ token: process.env.MAPBOX_TOKEN ?? '' });
});

// Public: fetch tweet by ID using bot credentials (authenticated v2 lookup)
const botClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

app.get('/api/tweet/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: tweet, includes } = await botClient.v2.singleTweet(id, {
      'tweet.fields': ['author_id', 'created_at', 'text'],
      'user.fields': ['name', 'username', 'profile_image_url'],
      expansions: ['author_id'],
    });
    const author = includes?.users?.[0] ?? {};
    res.json({ id: tweet.id, text: tweet.text, created_at: tweet.created_at, author });
  } catch (err) {
    res.status(404).json({ error: 'Tweet not found' });
  }
});

// Individual tweet page — auth guarded
app.get('/dashboard/:tweetId', (req, res) => {
  res.sendFile(join(__dirname, 'tweet.html'));
});

// Analytics page — auth guarded
app.get('/analytics', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(join(__dirname, 'analytics.html'));
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

// DEBUG: test search directly with session token
app.get('/api/debug/search', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });
  const { generateViewpoints } = await import('./services/gemini.js');
  const { fetchTopPosts } = await import('./services/xSearch.js');
  const topic = req.query.topic || 'is usa or iran winning?';
  const rawQuery = req.query.raw;
  try {
    if (rawQuery) {
      const posts = await fetchTopPosts(req.session.accessToken, rawQuery);
      return res.json({ query: rawQuery, count: posts.length, posts });
    }
    const { viewpoint_a, viewpoint_b } = await generateViewpoints(topic);
    const [postsA, postsB] = await Promise.all([
      fetchTopPosts(req.session.accessToken, viewpoint_a.query),
      fetchTopPosts(req.session.accessToken, viewpoint_b.query),
    ]);
    res.json({ viewpoint_a, viewpoint_b, postsA_count: postsA.length, postsB_count: postsB.length, postsA, postsB });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// POST /api/video-query — find relevant tweets via Gemini text search (fast, no indexing)
app.post('/api/video-query', async (req, res) => {
  const { query, videos } = req.body;
  if (!query?.trim() || !Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'query and videos[] are required' });
  }

  try {
    const results = await searchTweets(query, videos);

    // Build base clips, then extract timestamps in parallel for video clips
    const baseClips = results.map(r => {
      const v = videos[r.index];
      if (!v) return null;
      return { r, v };
    }).filter(Boolean);

    const clips = await Promise.all(baseClips.map(async ({ r, v }) => {
      let start = 0;
      if (v.url) {
        start = await extractVideoTimestamp(v.url, query);
      }
      return {
        videoId: `text-${r.index}`,
        start,
        end: start + 10,
        score: r.score ?? 70,
        confidence: 'high',
        answer: r.answer,
        meta: {
          url: v.url ?? null,
          tweetText: v.tweetText,
          authorName: v.authorName,
          authorUsername: v.authorUsername,
          side: v.side ?? 'a',
        },
      };
    }));

    res.json({ clips });
  } catch (err) {
    console.error('[video-query]', err?.message);
    res.status(500).json({ error: 'analysis_failed', message: err.message });
  }
});

// GET /api/video-job/:tweetId — check persisted video job status
app.get('/api/video-job/:tweetId', async (req, res) => {
  const job = await getVideoJob(req.params.tweetId);
  res.json(job ?? { status: 'none' });
});

// GET /api/generate-debate-video/:tweetId — SSE stream, generates CNN-style debate video
app.get('/api/generate-debate-video/:tweetId', async (req, res) => {
  const { tweetId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // Check existing job first
    const existingJob = await getVideoJob(tweetId);

    if (existingJob?.status === 'complete') {
      emit({ type: 'complete', videoUrl: existingJob.video_url, tweetUrl: existingJob.tweet_url ?? undefined });
      return res.end();
    }

    if (existingJob?.status === 'processing') {
      // Another session is generating — poll until done
      emit({ type: 'progress', pct: 50, message: 'Video generation in progress…' });
      for (let i = 0; i < 60; i++) {
        await sleep(5000);
        const job = await getVideoJob(tweetId);
        if (job?.status === 'complete') {
          emit({ type: 'complete', videoUrl: job.video_url, tweetUrl: job.tweet_url ?? undefined });
          return res.end();
        }
        if (job?.status === 'error') {
          emit({ type: 'error', message: job.error_msg ?? 'Generation failed.' });
          return res.end();
        }
      }
      emit({ type: 'error', message: 'Timed out waiting for video.' });
      return res.end();
    }

    // No job — mark as processing and start generation
    await upsertVideoJob(tweetId, { status: 'processing' });

    emit({ type: 'progress', pct: 5, message: 'Fetching viewpoint data…' });
    const analysis = await getCachedAnalysis(tweetId);
    if (!analysis || !analysis.debatable) {
      await upsertVideoJob(tweetId, { status: 'error', error_msg: 'No viewpoint analysis found for this post.' }).catch(() => {});
      emit({ type: 'error', message: 'No viewpoint analysis found for this post.' });
      return res.end();
    }

    const tweetData = {
      viewpoint_a: { label: analysis.viewpoint_a_label },
      viewpoint_b: { label: analysis.viewpoint_b_label },
      postsA: (analysis.viewpoint_a_threads ?? []).map(t => t.root).filter(Boolean),
      postsB: (analysis.viewpoint_b_threads ?? []).map(t => t.root).filter(Boolean),
    };

    emit({ type: 'progress', pct: 15, message: 'Generating debate script…' });
    const { povs, script } = await buildDebateScript(tweetData);
    console.log(`[vidgen] script ready — ${script.length} lines`);

    const onProgress = (pct, message) => emit({ type: 'progress', pct, message });

    const videoUrl = await generateFullVideo(script, povs, onProgress);
    console.log(`[vidgen] video ready: ${videoUrl}`);

    let tweetUrl = null;

    // Post to X and tag the logged-in user
    if (req.session.user) {
      try {
        emit({ type: 'progress', pct: 97, message: 'Posting to X…' });
        const filePath = join(__dirname, videoUrl);
        const mediaId = await botClient.v1.uploadMedia(filePath, { mimeType: 'video/mp4', longVideo: true });
        const tweetText = `@${req.session.user.username} 🎬 "${analysis.viewpoint_a_label} vs ${analysis.viewpoint_b_label}"\n\nPowered by EchoChamberAI`;
        const posted = await botClient.v2.tweet({ text: tweetText, media: { media_ids: [mediaId] } });
        console.log(`[vidgen] posted to X: ${posted.data.id}`);
        tweetUrl = `https://x.com/i/status/${posted.data.id}`;
      } catch (tweetErr) {
        console.error('[vidgen] X post failed:', tweetErr.message);
      }
    }

    await upsertVideoJob(tweetId, { status: 'complete', video_url: videoUrl, tweet_url: tweetUrl });
    emit({ type: 'complete', videoUrl, ...(tweetUrl && { tweetUrl }) });
    res.end();
  } catch (err) {
    console.error('[vidgen]', err.message, '\n', err.stack);
    await upsertVideoJob(tweetId, { status: 'error', error_msg: err.message }).catch(() => {});
    emit({ type: 'error', message: err.message });
    res.end();
  }
});

// POST /api/stt — receive raw audio blob, transcribe via ElevenLabs Scribe
app.post('/api/stt', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: 'audio/webm' }), 'audio.webm');
    form.append('model_id', 'scribe_v1');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      body: form,
    });
    const data = await r.json();
    res.json({ transcript: data.text ?? '' });
  } catch (err) {
    console.error('[stt]', err.message);
    res.status(500).json({ transcript: '' });
  }
});

// POST /api/ask/:tweetId — generate AI spoken answer for a viewer question
app.post('/api/ask/:tweetId', async (req, res) => {
  const { tweetId } = req.params;
  const { question, speakerIndex = 0 } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });

  try {
    const analysis = await getCachedAnalysis(tweetId);
    if (!analysis) return res.status(404).json({ error: 'No analysis found' });

    const idx = speakerIndex === 1 ? 1 : 0;
    const viewpointLabel = idx === 0 ? analysis.viewpoint_a_label : analysis.viewpoint_b_label;
    const threads = idx === 0 ? analysis.viewpoint_a_threads : analysis.viewpoint_b_threads;
    const context = (threads ?? []).slice(0, 3).map(t => t.root?.text ?? '').filter(Boolean).join('\n');

    const answerText = await generateAnswer(viewpointLabel, context, question);
    console.log(`[ask] speaker=${idx} q="${question.slice(0, 60)}" answer="${answerText.slice(0, 80)}"`);

    const voiceId = idx === 0 ? 'EXAVITQu4vr4xnSDxMaL' : 'TxGEqnHWrfWFTfGW9XjX';
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: answerText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!ttsRes.ok) throw new Error(`ElevenLabs TTS error ${ttsRes.status}`);

    const audioBuf = await ttsRes.arrayBuffer();
    const audioId = crypto.randomUUID();
    const audioPath = join(__dirname, 'clips', `${audioId}.mp3`);
    await fs.writeFile(audioPath, Buffer.from(audioBuf));

    res.json({ audioUrl: `/clips/${audioId}.mp3` });
  } catch (err) {
    console.error('[ask]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video-proxy?url=... — proxy Twitter CDN videos to avoid 403 in browser
app.get('/api/video-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://video.twimg.com/')) {
    return res.status(400).end();
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://twitter.com/',
    'Origin': 'https://twitter.com',
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const upstream = await fetch(url, { headers });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const reader = upstream.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) return res.end();
      res.write(Buffer.from(value));
      return pump();
    };
    await pump();
  } catch (err) {
    console.error('[video-proxy]', err.message);
    res.status(502).end();
  }
});

app.use('/clips', express.static(join(__dirname, 'clips')));

app.listen(PORT, () => {
  console.log(`EchoChamberAI running at http://localhost:${PORT}`);
  initIndex().catch(err => console.error('[TwelveLabs] init error:', err?.message));
});
