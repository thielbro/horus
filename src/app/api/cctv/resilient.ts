import type { CctvCamera } from './types';

/**
 * Module-level "last known good" cache, keyed by source id. Survives for the
 * lifetime of the server process. Lets a flaky upstream (cold start, transient
 * timeout) fall back to the previous successful result instead of vanishing
 * from the map — the root cause of NZ cameras intermittently disappearing.
 */
const LAST_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LAST_GOOD_ENTRIES = 100;
const lastGood = new Map<string, { data: CctvCamera[]; timestamp: number }>();

function pruneLastGood(now = Date.now()) {
  for (const [key, entry] of lastGood.entries()) {
    if (now - entry.timestamp > LAST_GOOD_TTL_MS || lastGood.size > MAX_LAST_GOOD_ENTRIES) {
      lastGood.delete(key);
    }
  }
}

/** Fetch with a hard timeout and N retries. Throws if every attempt fails. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { retries = 2, timeoutMs = 18000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': 'OSIRIS-map/1.0 (CCTV layer)',
          ...(init.headers || {}),
        },
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      // brief backoff before retrying (200ms, 600ms, ...)
      if (attempt < retries) await new Promise((r) => setTimeout(r, 200 + attempt * 400));
    }
  }
  throw lastErr;
}

/**
 * Run a source fetcher with retries; on a non-empty result, cache it and return
 * it. If the fetcher throws or returns empty, serve the last good result for
 * this key (if any) so a single bad poll never blanks the layer.
 */
export async function withFallback(
  key: string,
  produce: () => Promise<CctvCamera[]>,
): Promise<CctvCamera[]> {
  try {
    const data = await produce();
    if (data.length > 0) {
      lastGood.set(key, { data, timestamp: Date.now() });
      pruneLastGood();
      return data;
    }
  } catch {
    /* fall through to cached */
  }
  pruneLastGood();
  return lastGood.get(key)?.data ?? [];
}
