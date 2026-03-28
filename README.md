# EchoChamberAI

Break out of your social media bubble. Echo surfaces the opposing viewpoints you never see — then generates an AI debate video between them and lets you question the participants live.

---

## What It Does

1. **Sign in with X** — authenticate with your Twitter/X account
2. **Select a tweet** — pick any tweet from your feed that touches a contested topic
3. **Oracle Analysis** — AI classifies the tweet, generates two opposing viewpoints, and pulls the top 5 real tweets from each side
4. **Debate Video** — Veo 3.0 generates a CNN-style debate video between the two sides, posted to X and tagged to you
5. **Ask the Authors** — search across all sourced tweets with natural language; Gemini finds the most relevant responses with real video timestamps
6. **Hold Space to Ask** — while watching the debate video, hold spacebar to pause and speak a question; ElevenLabs transcribes it, Gemini writes an in-character answer, ElevenLabs speaks it back, then the video resumes

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ / Express |
| Auth | Twitter OAuth 2.0 (PKCE) via `twitter-api-v2` |
| AI — Analysis | Gemini 2.5 Flash (intent, viewpoints, bias scoring) |
| AI — Video Generation | Veo 3.0 (`veo-3.0-generate-001`) |
| AI — Image Generation | Nano Banana Pro (character profile images) |
| AI — STT | ElevenLabs Scribe v1 |
| AI — TTS | ElevenLabs `eleven_multilingual_v2` |
| AI — Video Timestamps | Gemini Files API (on-demand, no pre-indexing) |
| X Bot Posting | Twitter API v1.1 (chunked video upload) + v2 (tweet) |
| Database | Supabase (oracle analysis cache + video job persistence) |
| Video Processing | FFmpeg (caption burning, clip stitching) |
| Maps | Mapbox GL JS |
| Frontend | Vanilla JS + Tailwind CSS |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/SanjayMarathe/echochamberai.git
cd echochamberai
npm install
```

### 2. Install FFmpeg

FFmpeg must be installed and on your PATH.

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### 3. Environment variables

Create a `.env` file in the project root:

```env
# X / Twitter — OAuth 2.0 (user login)
X_CLIENT_ID=your_x_oauth2_client_id
X_CLIENT_SECRET=your_x_oauth2_client_secret
CALLBACK_URL=http://localhost:3000/callback

# X / Twitter — OAuth 1.0a (bot posting)
TWITTER_API_KEY=your_bot_api_key
TWITTER_API_SECRET=your_bot_api_secret
TWITTER_ACCESS_TOKEN=your_bot_access_token
TWITTER_ACCESS_SECRET=your_bot_access_secret

# Google AI (Gemini + Veo)
GEMINI_API_KEY=your_gemini_api_key

# ElevenLabs (STT + TTS)
ELEVENLABS_API_KEY=your_elevenlabs_api_key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_publishable_key

# Mapbox
MAPBOX_TOKEN=your_mapbox_public_token

# TwelveLabs (optional)
TWELVELABS_API_KEY=your_twelvelabs_api_key

# Session
SESSION_SECRET=some-long-random-string
PORT=3000
```

### 4. Supabase tables

Run in your Supabase SQL editor:

```sql
CREATE TABLE tweet_analyses (
  tweet_id   text PRIMARY KEY,
  analysis   jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE video_jobs (
  tweet_id   text PRIMARY KEY,
  status     text NOT NULL DEFAULT 'processing',
  video_url  text,
  tweet_url  text,
  error_msg  text,
  updated_at timestamptz DEFAULT now()
);
```

### 5. X Developer App setup

You need two X developer apps (or one with both OAuth flows):

**User login (OAuth 2.0 PKCE):**
- Add `http://localhost:3000/callback` as a redirect URI
- Enable `users.read` and `tweet.read` scopes
- Copy Client ID → `X_CLIENT_ID`, Client Secret → `X_CLIENT_SECRET`

**Bot posting (OAuth 1.0a):**
- Enable read/write permissions
- Generate access token + secret for the bot account
- Copy all four keys into the `TWITTER_*` env vars

### 6. Gemini / Veo access

Veo 3.0 requires a Gemini API key with video generation access. Verify access to `veo-3.0-generate-001` at [ai.google.dev](https://ai.google.dev).

### 7. Run

```bash
npm start
# → http://localhost:3000
```

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Landing page |
| `GET` | `/dashboard` | Tweet feed (auth required) |
| `GET` | `/dashboard/:tweetId` | Tweet detail + oracle + video |
| `GET` | `/auth/twitter` | Start OAuth 2.0 login |
| `GET` | `/callback` | OAuth callback |
| `GET` | `/api/me` | Current session user |
| `GET` | `/api/feed` | Authenticated user's tweets |
| `GET` | `/api/feed/analyze-tweet` | SSE — oracle analysis stream |
| `GET` | `/api/generate-debate-video/:tweetId` | SSE — Veo video generation stream |
| `GET` | `/api/video-job/:tweetId` | Video job status (Supabase) |
| `POST` | `/api/stt` | ElevenLabs speech-to-text |
| `POST` | `/api/ask/:tweetId` | Gemini answer + ElevenLabs TTS |
| `POST` | `/api/video-query` | Gemini text search across sourced tweets |
| `GET` | `/api/video-proxy` | Twitter CDN video proxy |
| `GET` | `/api/tweet/:id` | Single tweet lookup |
| `GET` | `/logout` | Destroy session |

---

## Features In Depth

### Oracle Analysis (SSE)
Streams progress to the client in real time:
1. Classify tweet intent and compute bias/sentiment/echo risk metrics (Gemini)
2. Generate two opposing viewpoint labels + X search queries
3. Fetch top 5 tweets per viewpoint sorted by engagement
4. Reconstruct reply threads for context
5. Cache result to Supabase — revisiting the page is instant

### Debate Video Generation
- Gemini writes a multi-line debate script from the sourced tweet content
- Nano Banana generates character profile images for each debater
- Veo 3.0 generates 8-second clips per script line with rate-limit-aware batching
- FFmpeg burns captions and stitches clips into a final MP4
- Bot posts the video to X tagging the logged-in user; a "View on X" badge overlays the video
- Job status persisted in Supabase — navigating away and back reconnects to an in-progress job or shows the cached video instantly

### Space-to-Ask
- Hold `spacebar` while watching the debate video
- `MediaRecorder` captures mic audio
- On release: audio → `/api/stt` → ElevenLabs Scribe transcribes it
- Transcript → `/api/ask/:tweetId` → Gemini writes a 3-line in-character response → ElevenLabs TTS converts to audio
- Response plays back, then video resumes from the exact paused timestamp

### Ask the Authors
- Natural language search across all 10 sourced tweets (~1s via Gemini 2.5 Flash, no pre-indexing)
- For matched tweets with video: uploads clip to Gemini Files API to extract a real timestamp (~10s)
- Results show author, relevance score, and a play button that opens the video at the matched moment
- Supports `@mention` filtering via autocomplete dropdown

---

## Project Structure

```
echochamberai/
├── server.js              # Express app — all API routes
├── index.html             # Landing page
├── dashboard.html         # Tweet feed
├── tweet.html             # Tweet detail + oracle + video + Q&A
├── analytics.html         # Analytics page
├── services/
│   ├── gemini.js          # Gemini AI (analysis, viewpoints, search, STT answers, timestamps)
│   ├── videoGenerator.js  # Veo pipeline (script → clips → FFmpeg stitch)
│   ├── cache.js           # Supabase (oracle cache + video job persistence)
│   ├── xSearch.js         # X API search + thread reconstruction
│   └── twelvelabs.js      # TwelveLabs video indexing (legacy)
└── clips/                 # Generated MP4s and MP3s (gitignored)
```

---
## [Demo Link](https://youtu.be/Y-DQiYntUac)
