import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export async function getCachedAnalysis(tweetId) {
  const { data, error } = await supabase
    .from('tweet_analyses')
    .select('analysis')
    .eq('tweet_id', tweetId)
    .single();
  if (error || !data) return null;
  return data.analysis;
}

export async function cacheAnalysis(tweetId, analysis) {
  await supabase
    .from('tweet_analyses')
    .upsert({ tweet_id: tweetId, analysis }, { onConflict: 'tweet_id' });
}

export async function getVideoJob(tweetId) {
  const { data } = await supabase
    .from('video_jobs')
    .select('status, video_url, tweet_url, error_msg')
    .eq('tweet_id', tweetId)
    .single();
  return data ?? null;
}

export async function upsertVideoJob(tweetId, fields) {
  await supabase
    .from('video_jobs')
    .upsert({ tweet_id: tweetId, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'tweet_id' });
}
