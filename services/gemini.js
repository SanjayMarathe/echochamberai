import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'application/json' },
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
- Each query MUST end with: min_retweets:5 ("1/" OR "🧵") -is:retweet -is:reply
- IMPORTANT: use min_retweets (NOT min_faves — that operator is not supported)
- Use 2-4 targeted keywords for the core topic
- Do NOT include people's names unless they are central to the debate
- Make the viewpoints genuinely opposing, not just slightly different

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
