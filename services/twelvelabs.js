import { TwelveLabs } from 'twelvelabs-js';

const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });

const INDEX_NAME = 'echochamberai';
let indexId = null;

// videoUrl → videoId cache (in-memory, fast for repeat queries)
const urlToVideoId = new Map();

export async function initIndex() {
  try {
    const list = await client.indexes.list();
    const existing = list?.data?.find(i => i.indexName === INDEX_NAME);
    if (existing) {
      indexId = existing.id;
      console.log(`[TwelveLabs] Using existing index: ${indexId}`);
    } else {
      const created = await client.indexes.create({
        indexName: INDEX_NAME,
        models: [{ modelName: 'marengo2.7', modelOptions: ['visual', 'audio'] }],
      });
      indexId = created.id;
      console.log(`[TwelveLabs] Created new index: ${indexId}`);
    }
    return indexId;
  } catch (err) {
    console.error('[TwelveLabs] initIndex failed:', err?.message);
  }
}

export async function ensureIndexed(videoUrl) {
  if (!indexId) throw new Error('TwelveLabs index not initialised');

  if (urlToVideoId.has(videoUrl)) {
    console.log(`[TwelveLabs] Cache hit: ${videoUrl.slice(0, 60)}`);
    return { videoId: urlToVideoId.get(videoUrl) };
  }

  // Download video server-side first (Twitter CDN blocks TwelveLabs directly)
  console.log(`[TwelveLabs] Downloading: ${videoUrl.slice(0, 60)}…`);
  const resp = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' } });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  console.log(`[TwelveLabs] Downloaded ${(buffer.length / 1024).toFixed(0)} KB — indexing…`);

  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);
  stream.path = 'video.mp4'; // SDK uses .path for filename

  const task = await client.tasks.create({
    indexId,
    videoFile: stream,
  });

  const done = await client.tasks.waitForDone(task.id, {
    callback: (t) => console.log(`[TwelveLabs] Task ${task.id}: ${t.status}`),
  });

  if (done.status !== 'ready') {
    throw new Error(`Indexing failed: ${done.status}`);
  }

  urlToVideoId.set(videoUrl, done.videoId);
  console.log(`[TwelveLabs] Ready → videoId: ${done.videoId}`);
  return { videoId: done.videoId };
}

export async function queryVideos(queryText, videoIds) {
  if (!indexId) throw new Error('TwelveLabs index not initialised');

  const videoIdSet = new Set(videoIds);
  const clips = [];

  const results = await client.search.query({
    indexId,
    queryText,
    searchOptions: ['visual', 'audio'],
  });

  for await (const clip of results) {
    if (videoIdSet.has(clip.videoId)) {
      clips.push({
        videoId: clip.videoId,
        start: clip.start,
        end: clip.end,
        score: clip.score,
        confidence: clip.confidence,
      });
    }
    if (clips.length >= 8) break;
  }

  return clips.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
