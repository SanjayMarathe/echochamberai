import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'application/json' },
});

const textModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'text/plain' },
});

// Fast model for simple relevance ranking — thinking disabled for speed
const fastModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 0 },
  },
});

async function ask(prompt) {
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

export async function classifyIntent(userPrompt) {
  return ask(`
You are an intent classifier for a social media research tool.

Given the user's query, classify their intent into one of three categories:
- "genesearch": The user wants to research a general topic or public debate
- "self_tweet_expansion": The user is asking about something they likely have personal opinions or past tweets about (first-person language, personal views, statements like "my take", "I think", "what do people think about my stance on X")
- "other": Unclear or unrelated

User query: "${userPrompt}"

Respond with valid JSON only:
{ "intent": "genesearch" | "self_tweet_expansion" | "other", "reasoning": "brief explanation" }
`);
}

export async function generateViewpoints(userPrompt) {
  return ask(`
You are a research assistant that identifies two opposing viewpoints on a topic and generates X (Twitter) search queries to find popular threads representing each side.

Topic: "${userPrompt}"

Rules for search queries:
- Each query MUST end with: -is:retweet -is:reply
- Use EXACTLY 2-3 keywords — no more. X requires ALL keywords to appear in a tweet, so fewer = more results
- Only use plain keywords and the operators above — NO min_faves, NO min_retweets, NO min_replies, NO has:links
- Pick the 2-3 most common words people actually use when tweeting about this viewpoint
- Do NOT include people's names unless they are central to the debate
- Make the viewpoints genuinely opposing

Respond with valid JSON only:
{
  "viewpoint_a": { "label": "Short descriptive label (max 6 words)", "query": "full X search query string" },
  "viewpoint_b": { "label": "Short descriptive label (max 6 words)", "query": "full X search query string" }
}
`);
}

export async function classifyTweetIntent(tweetText) {
  return ask(`
You are an intent classifier for a social media research tool.

A user posted this tweet: "${tweetText}"

Determine if this tweet is about a topic that has two distinct, opposing public viewpoints worth researching (e.g. geopolitics, policy debates, economic arguments, social issues, technology disputes).

Respond with valid JSON only:
{ "debatable": true | false, "reasoning": "one sentence explanation" }
`);
}

export async function analyzeTweetFull(tweetText) {
  return ask(`
You are an AI discourse analyst for a social media research platform.

Analyze this tweet and return structured metrics. Be accurate — do not default to middle values.

Tweet: "${tweetText}"

Respond with valid JSON only:
{
  "debatable": boolean — true only if this touches a genuinely contested topic with two distinct sides worth researching,
  "bias_score": integer 0–100 — 0 = completely neutral framing, 100 = extremely one-sided. A neutral question scores 10–25. A strong opinion scores 60+,
  "sentiment": one of: "neutral" | "analytical" | "hopeful" | "alarmist" | "angry" | "sarcastic",
  "framing": one of: "question" | "declarative" | "emotional" | "satirical" | "informational",
  "echo_chamber_risk": one of: "low" | "medium" | "high" — how much this post could reinforce a single-viewpoint bubble,
  "discourse_type": one of: "geopolitical" | "economic" | "social" | "technology" | "cultural" | "other"
}
`);
}

export async function answerFromClips(query, clips) {
  const fmtTs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
  const context = clips.map((c, i) =>
    `[${i + 1}] ${c.meta.authorName} at ${fmtTs(c.start)}–${fmtTs(c.end)}: "${(c.meta.tweetText ?? '').slice(0, 300)}"`
  ).join('\n\n');

  const result = await model.generateContent(`
You are an AI video analyst for a social media discourse platform.

User question: "${query}"

For each of the following video clips, write exactly one punchy sentence (max 20 words) that directly answers or relates to the question based on that clip's content. Do not invent facts.

Clips:
${context}

Respond with valid JSON only:
{ "answers": ["one sentence for clip 1", "one sentence for clip 2", ...] }

The array must have exactly ${clips.length} entries, one per clip, in the same order.
`);
  const { answers } = JSON.parse(result.response.text());
  return Array.isArray(answers) ? answers : clips.map(() => null);
}

export async function extractVideoTimestamp(videoUrl, query) {
  try {
    const resp = await fetch(videoUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://twitter.com/', 'Origin': 'https://twitter.com' },
    });
    if (!resp.ok) return 0;
    const buffer = Buffer.from(await resp.arrayBuffer());

    const uploadResp = await fileManager.uploadFile(buffer, { mimeType: 'video/mp4', displayName: 'clip.mp4' });
    let file = uploadResp.file;

    // Poll until ACTIVE
    while (file.state === FileState.PROCESSING) {
      await new Promise(r => setTimeout(r, 1000));
      file = await fileManager.getFile(file.name);
    }
    if (file.state !== FileState.ACTIVE) return 0;

    const result = await textModel.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
          { text: `At approximately what second in this video does the content most relate to: "${query}"? Reply with just an integer number of seconds. If the whole video is relevant or you are unsure, reply 0.` },
        ],
      }],
    });

    // Clean up uploaded file (fire and forget)
    fileManager.deleteFile(file.name).catch(() => {});

    const seconds = parseInt(result.response.text().trim(), 10);
    return isNaN(seconds) ? 0 : seconds;
  } catch {
    return 0;
  }
}

export async function searchTweets(query, videos) {
  const videoList = videos.map((v, i) =>
    `[${i}] @${v.authorUsername ?? v.authorName} (side:${v.side ?? 'a'}): "${(v.tweetText ?? '').slice(0, 250)}"`
  ).join('\n');

  const result = await fastModel.generateContent(`
You are analyzing tweets for a social media discourse platform.

User question: "${query}"

Tweets from debate participants:
${videoList}

Find the 3-4 most relevant tweets. For each write exactly one punchy sentence (max 20 words) answering the question based on that tweet.

Respond with JSON only:
{ "results": [{ "index": 0, "answer": "one sentence", "score": 85 }, ...] }

Max 4 results, sorted by relevance. Score 0-100.
`);
  const { results } = JSON.parse(result.response.text());
  return results ?? [];
}

export async function generateAnswer(viewpointLabel, context, question) {
  const result = await textModel.generateContent(`
You are a TV debate pundit defending: "${viewpointLabel}"

Context from your past arguments:
${context || '(no context)'}

A viewer just asked: "${question}"

Write exactly 3 short spoken lines (under 15 words each) answering directly in character.
No filler openers. Last line feels conclusive. Plain text only, no labels or JSON.
`);
  return result.response.text().trim();
}

export async function matchUserTweets(userPrompt, tweets) {
  const tweetList = tweets
    .map(t => `ID:${t.id} TEXT:${t.text.slice(0, 200)}`)
    .join('\n');

  return ask(`
You are a semantic relevance engine.

Topic: "${userPrompt}"

User's tweets:
${tweetList}

Identify which tweets are semantically related to the topic. Return at most 5 tweet IDs.
If none are relevant, return an empty array.

Respond with valid JSON only:
{ "matched_ids": ["id1", "id2"] }
`);
}
