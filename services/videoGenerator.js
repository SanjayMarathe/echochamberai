// services/videoGenerator.js
// CNN-style debate video pipeline extracted from echochamberai-vidgenerator
// Converts oracle viewpoint data → Gemini script → Veo clips → FFmpeg stitch

import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS_DIR = path.join(__dirname, '..', 'clips');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Fixed TV anchor characters — names stay constant, stance changes per debate
const SPEAKERS = [
  { name: 'Alex Rivera', title: 'Political Analyst' },
  { name: 'Jordan Chen', title: 'Policy Strategist' },
];

const CHARACTER_PROMPTS = [
  'Professional headshot of a person in their 30s, South Asian appearance, short dark hair, androgynous features, wearing a teal blazer, sitting at a modern TV news studio desk, bright broadcast lighting, looking directly at camera, photorealistic',
  'Professional headshot of a person in their 40s, East Asian appearance, short light-brown hair, androgynous features, wearing a burgundy blazer, sitting at a modern TV news studio desk, bright broadcast lighting, looking directly at camera, photorealistic',
];

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function gemini(prompt, temperature = 0.7, maxTokens = 500) {
  const res = await fetch(
    `${GEMINI_URL}/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    }
  );
  const rawText = await res.text();
  let data;
  try { data = JSON.parse(rawText); } catch {
    throw new Error('Gemini non-JSON response: ' + rawText.slice(0, 300));
  }
  if (!res.ok) throw new Error(data.error?.message || 'Gemini error');
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini empty response: ' + JSON.stringify(data).slice(0, 300));
  return content.trim();
}

// ─── Script generation ────────────────────────────────────────────────────────

export async function buildDebateScript(tweetData) {
  const sideA = tweetData.postsA
    .map(p => `"${p.text}" — @${p.author?.username ?? 'unknown'} (${p.public_metrics?.like_count ?? 0} likes)`)
    .join('\n');
  const sideB = tweetData.postsB
    .map(p => `"${p.text}" — @${p.author?.username ?? 'unknown'} (${p.public_metrics?.like_count ?? 0} likes)`)
    .join('\n');

  const prompt = `You are a CNN debate producer. Two pundits are debating live on air.

SIDE A — "${tweetData.viewpoint_a.label}":
${sideA}

SIDE B — "${tweetData.viewpoint_b.label}":
${sideB}

Rules:
- Exactly 2 speakers. Speaker A is "${SPEAKERS[0].name}" and defends: "${tweetData.viewpoint_a.label}". Speaker B is "${SPEAKERS[1].name}" and defends: "${tweetData.viewpoint_b.label}".
- Always use exactly these names in the script — do not invent new names
- 5 back-and-forth exchanges, strictly alternating, ${SPEAKERS[0].name} goes first
- Each line must be under 15 words — one punchy sentence, natural spoken TV debate style
- STRICT: count the words, do not exceed 15 words per line
- Each line must directly respond to the previous point — build the argument step by step
- Use plain language anyone can understand, no jargon
- Pull the actual arguments and facts from the tweets — don't invent positions
- Tone: confident and pointed, not shouting — like two smart people who genuinely disagree
- No filler openers — don't start lines with "Well,", "Look,", "I think", "The fact is"

Respond in this exact JSON format:
{
  "povs": [
    { "name": "${SPEAKERS[0].name}", "stance": "one sentence summary of their position on this topic", "color": "blue" },
    { "name": "${SPEAKERS[1].name}", "stance": "one sentence summary of their position on this topic", "color": "red" }
  ],
  "script": [
    { "speaker": "${SPEAKERS[0].name}", "line": "what they say" }
  ]
}

Output ONLY valid JSON, nothing else.`;

  const text = (await gemini(prompt, 0.8, 4000)).replace(/```json\n?|```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini returned invalid JSON: ' + text.slice(0, 200));
  }
}

// ─── Character image generation (Nano Banana) ─────────────────────────────────

async function generateCharacterImage(characterIndex) {
  const res = await fetch(
    `${GEMINI_URL}/models/nano-banana-pro-preview:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: CHARACTER_PROMPTS[characterIndex % 2] }] }],
        generationConfig: { responseModalities: ['IMAGE'], temperature: 1 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Nano Banana error');
  const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error('Nano Banana returned no image');
  return part.inlineData; // { mimeType, data (base64) }
}

// ─── Veo clip helpers ─────────────────────────────────────────────────────────

function chunkLine(line, maxWords = 20) {
  const words = line.split(' ');
  if (words.length <= maxWords) return [line];
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

function buildLinePrompt(speakerIndex, line) {
  const descriptions = [
    'a person with short dark hair, androgynous features, teal blazer',
    'a person with short light-brown hair, androgynous features, burgundy blazer',
  ];
  return `Professional TV news broadcast studio, bright lighting, blurred cityscape background. ${descriptions[speakerIndex % 2]} sits at the news desk, looks directly at camera, and says: "${line}". Broadcast quality, cinematic news panel framing, no text overlays.`;
}

async function startClip(prompt, imageData) {
  const instance = imageData
    ? { prompt, image: { bytesBase64Encoded: imageData.data, mimeType: imageData.mimeType } }
    : { prompt };
  const res = await fetch(
    `${GEMINI_URL}/models/veo-3.0-generate-001:predictLongRunning?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [instance],
        parameters: { aspectRatio: '16:9', durationSeconds: 8 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Veo start error');
  console.log(`[veo] started: ${data.name}`);
  return data.name;
}

async function pollClip(opName) {
  for (let i = 0; i < 36; i++) {
    await sleep(10_000);
    const pollRes = await fetch(`${GEMINI_URL}/${opName}?key=${GEMINI_KEY}`);
    const pollData = await pollRes.json();
    console.log(`[veo] poll ${opName} done=${pollData.done}`, JSON.stringify(pollData).slice(0, 200));
    if (pollData.done) {
      const response = pollData.response?.generateVideoResponse;
      if (response?.raiMediaFilteredCount > 0) {
        console.warn(`[veo] clip filtered, skipping: ${opName}`);
        return null;
      }
      const uri = response?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error('Veo no URL: ' + JSON.stringify(pollData).slice(0, 500));
      return `${uri}&key=${GEMINI_KEY}`;
    }
  }
  throw new Error(`Veo timed out: ${opName}`);
}

async function downloadClip(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  await writeFile(dest, Buffer.from(buf));
}

async function burnCaption(inputPath, chyronText, outputPath) {
  try {
    const safeText = chyronText.replace(/'/g, "\\'").replace(/:/g, '\\:');
    await exec('ffmpeg', [
      '-i', inputPath,
      '-vf', `drawbox=x=0:y=ih-90:w=iw:h=90:color=black@0.75:t=fill,drawtext=fontsize=28:fontcolor=white:x=30:y=h-62:text='${safeText}'`,
      '-codec:a', 'copy',
      '-y', outputPath,
    ]);
  } catch (err) {
    // drawtext requires libfreetype — if unavailable, copy raw clip without captions
    if (err.message?.includes('drawtext') || err.message?.includes('Filter not found')) {
      console.warn('[ffmpeg] drawtext unavailable, copying without captions');
      await exec('ffmpeg', ['-i', inputPath, '-c', 'copy', '-y', outputPath]);
    } else {
      throw err;
    }
  }
}

// ─── Full pipeline ────────────────────────────────────────────────────────────

export async function generateFullVideo(script, povs, onProgress = () => {}) {
  mkdirSync(CLIPS_DIR, { recursive: true });
  const id = randomUUID();

  // Map speaker name → { index, chyron }
  const speakerMap = {};
  povs.forEach((pov, i) => {
    const name = SPEAKERS[i]?.name ?? pov.name;
    speakerMap[pov.name] = { index: i, chyron: `${name}  |  ${pov.stance}` };
  });

  // Build job list from script lines
  const jobs = [];
  for (const { speaker, line } of script) {
    const info = speakerMap[speaker] ?? { index: 0, chyron: speaker };
    for (const chunk of chunkLine(line)) {
      jobs.push({ speakerIndex: info.index, chyron: info.chyron, chunk });
    }
  }
  if (jobs.length > 10) {
    console.warn(`[veo] trimming ${jobs.length} clips to 10`);
    jobs.splice(10);
  }
  console.log(`[veo] ${jobs.length} clips to generate`);

  // Generate both character images concurrently
  onProgress(30, 'Creating character profiles…');
  const characterImages = await Promise.all([
    generateCharacterImage(0).catch(e => { console.warn('[nano-banana] char 0 failed:', e.message); return null; }),
    generateCharacterImage(1).catch(e => { console.warn('[nano-banana] char 1 failed:', e.message); return null; }),
  ]);
  console.log(`[nano-banana] ${characterImages.filter(Boolean).length}/2 images ready`);

  // Start all Veo jobs concurrently (in batches of 10, 61s between batches)
  onProgress(45, 'Starting video clip generation…');
  const opNames = [];
  for (let i = 0; i < jobs.length; i += 10) {
    const batch = jobs.slice(i, i + 10);
    if (i > 0) {
      console.log('[veo] waiting 61s before next batch…');
      await sleep(61_000);
    }
    const names = await Promise.all(
      batch.map(({ speakerIndex, chunk }) =>
        startClip(buildLinePrompt(speakerIndex, chunk), characterImages[speakerIndex % 2])
      )
    );
    opNames.push(...names);
  }

  // Poll all jobs concurrently
  onProgress(60, 'Generating clips (may take ~2 min)…');
  const remoteUrls = await Promise.all(opNames.map(pollClip));

  // Download + burn captions concurrently
  onProgress(80, 'Burning captions…');
  const validJobs = jobs.filter((_, i) => remoteUrls[i] !== null);
  const validUrls = remoteUrls.filter(Boolean);
  if (validUrls.length === 0) throw new Error('All clips were filtered by safety checks');

  const clipPaths = await Promise.all(
    validUrls.map(async (url, i) => {
      const raw = path.join(CLIPS_DIR, `${id}_${i}_raw.mp4`);
      const captioned = path.join(CLIPS_DIR, `${id}_${i}.mp4`);
      await downloadClip(url, raw);
      await burnCaption(raw, validJobs[i].chyron, captioned);
      return captioned;
    })
  );
  console.log(`[veo] ${clipPaths.length} clips captioned`);

  // Stitch all clips
  onProgress(92, 'Stitching final video…');
  const concatFile = path.join(CLIPS_DIR, `${id}_concat.txt`);
  writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));
  const outputPath = path.join(CLIPS_DIR, `${id}_final.mp4`);
  await exec('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', outputPath]);
  console.log(`[veo] stitched → ${id}_final.mp4`);

  return `/clips/${id}_final.mp4`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
