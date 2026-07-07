import express from 'express';
import { TwitterClient, TwitterApiError } from './twitter.js';
import type { Tweet, TwitterApiErrorType } from './twitter.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? '60000', 10);
const TIMELINE_COUNT = parseInt(process.env.TIMELINE_COUNT ?? '40', 10);
const TIMELINE_INCREMENTAL_COUNT = parseInt(process.env.TIMELINE_INCREMENTAL_COUNT ?? '20', 10);
const MAX_POOL_SIZE = parseInt(process.env.MAX_POOL_SIZE ?? '200', 10);

const authToken = process.env.TWITTER_AUTH_TOKEN;
const ct0 = process.env.TWITTER_CT0;

if (!authToken || !ct0) {
  console.error('[startup] TWITTER_AUTH_TOKEN and TWITTER_CT0 are required');
  process.exit(1);
}

const client = new TwitterClient(authToken, ct0);

const likedTweetIds = new Set<string>();

let cache: { tweets: Tweet[]; fetchedAt: number; cursorTop: string | null } = {
  tweets: [],
  fetchedAt: 0,
  cursorTop: null,
};


let status: {
  consecutiveErrors: number;
  lastError: { type: TwitterApiErrorType; message: string; at: string } | null;
  lastSuccessAt: string | null;
  lastFetchAt: string | null;
} = {
  consecutiveErrors: 0,
  lastError: null,
  lastSuccessAt: null,
  lastFetchAt: null,
};

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/status', (_req, res) => {
  res.json({
    ok: status.consecutiveErrors === 0,
    poolSize: cache.tweets.length,
    consecutiveErrors: status.consecutiveErrors,
    lastError: status.lastError,
    lastSuccessAt: status.lastSuccessAt,
    lastFetchAt: status.lastFetchAt,
  });
});

app.get('/timeline', async (_req, res) => {
  const now = Date.now();
  if (now - cache.fetchedAt < CACHE_TTL_MS) {
    const age = Math.round((now - cache.fetchedAt) / 1000);
    console.log(`[timeline] cache hit (age: ${age}s, pool: ${cache.tweets.length})`);
    res.json(cache.tweets);
    return;
  }

  const isIncremental = cache.cursorTop !== null;
  const count = isIncremental ? TIMELINE_INCREMENTAL_COUNT : TIMELINE_COUNT;
  console.log(`[timeline] ${isIncremental ? 'incremental' : 'initial'} fetch (count: ${count})...`);

  try {
    const result = await client.fetchHomeTimeline(count, cache.cursorTop ?? undefined);

    let tweets: Tweet[];
    if (isIncremental) {
      if (result.tweets.length > 0) {
        // 新着を先頭にマージ、重複除去、ID降順ソート、上限カット
        const seen = new Set<string>(cache.tweets.map(t => t.id));
        const newTweets = result.tweets.filter(t => !seen.has(t.id));
        tweets = [...newTweets, ...cache.tweets].slice(0, MAX_POOL_SIZE);
        console.log(`[timeline] +${newTweets.length} new tweets, pool: ${tweets.length}`);
      } else {
        tweets = cache.tweets;
        console.log('[timeline] no new tweets, pool unchanged');
      }
    } else {
      tweets = result.tweets;
      console.log(`[timeline] initial: ${tweets.length} tweets`);
    }

    cache = {
      tweets,
      fetchedAt: now,
      cursorTop: result.cursorTop ?? cache.cursorTop,
    };

    const nowIso = new Date(now).toISOString();
    status = { ...status, consecutiveErrors: 0, lastSuccessAt: nowIso, lastFetchAt: nowIso };

    res.json(tweets);
  } catch (err) {
    const nowIso = new Date().toISOString();
    const errorType = err instanceof TwitterApiError ? err.type : 'UNKNOWN';
    const errorMessage = err instanceof Error ? err.message : String(err);

    status = {
      consecutiveErrors: status.consecutiveErrors + 1,
      lastError: { type: errorType, message: errorMessage, at: nowIso },
      lastSuccessAt: status.lastSuccessAt,
      lastFetchAt: nowIso,
    };

    if (status.consecutiveErrors >= 3) {
      console.error(`[ALERT] ${status.consecutiveErrors} consecutive errors! type=${errorType}`);
    }
    console.error(`[timeline] fetch failed (${errorType}):`, err);

    if (cache.tweets.length > 0) {
      console.log(`[timeline] returning stale cache (${cache.tweets.length} tweets)`);
      res.json(cache.tweets);
    } else {
      res.status(502).json({ errorType, error: errorMessage });
    }
  }
});

app.get('/liked', (_req, res) => {
  res.json([...likedTweetIds]);
});

app.post('/like', async (req, res) => {
  const id = req.body?.id as string | undefined;
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  console.log(`[like] tweet ${id}`);
  try {
    await client.likeTweet(id);
    likedTweetIds.add(id);
    console.log(`[like] ok: ${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[like] failed (${id}):`, err);
    res.status(502).json({ error: String(err) });
  }
});

app.post('/unlike', async (req, res) => {
  const id = req.body?.id as string | undefined;
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  console.log(`[unlike] tweet ${id}`);
  try {
    await client.unlikeTweet(id);
    likedTweetIds.delete(id);
    console.log(`[unlike] ok: ${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[unlike] failed (${id}):`, err);
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on port ${PORT} (cache TTL: ${CACHE_TTL_MS}ms, initial: ${TIMELINE_COUNT}, incremental: ${TIMELINE_INCREMENTAL_COUNT}, max pool: ${MAX_POOL_SIZE})`);
});
