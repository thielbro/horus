import { safeAbortTimeout, releaseResponseBody } from '@/lib/http-utils';
import type { CctvCamera } from '@/app/api/cctv/types';

type HealthState = { ok: boolean; checkedAt: number; failures: number; lastGoodAt?: number };

const cache = new Map<string, HealthState>();
const HEALTHY_TTL = 15 * 60_000;
const FAILED_TTL = 5 * 60_000;
const MAX_ENTRIES = 20_000;

const keyFor = (camera: CctvCamera) => `${camera.id}|${camera.stream_url || camera.feed_url || ''}`;

export function getCameraHealth(camera: CctvCamera): HealthState | undefined {
  return cache.get(keyFor(camera));
}

export function shouldServeCamera(camera: CctvCamera): boolean {
  const state = getCameraHealth(camera);
  return !state || state.ok || Boolean(state.lastGoodAt);
}

export async function probeCamera(camera: CctvCamera): Promise<boolean> {
  const url = camera.stream_url || camera.feed_url;
  if (!url) return Boolean(camera.external_url);
  const key = keyFor(camera);
  const now = Date.now();
  const cached = cache.get(key);
  const ttl = cached?.ok ? HEALTHY_TTL : FAILED_TTL;
  if (cached && now - cached.checkedAt < ttl) return cached.ok;

  try {
    const response = await fetch(url, {
      method: camera.stream_type === 'hls' ? 'GET' : 'GET',
      headers: { Range: 'bytes=0-2047', Accept: 'image/*,video/*,application/vnd.apple.mpegurl,*/*;q=0.1' },
      signal: safeAbortTimeout(4_000),
      cache: 'no-store',
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    const ok = response.ok && (
      contentType.startsWith('image/') || contentType.startsWith('video/') ||
      contentType.includes('mpegurl') || camera.stream_type === 'iframe'
    );
    await releaseResponseBody(response);
    cache.set(key, { ok, checkedAt: now, failures: ok ? 0 : (cached?.failures || 0) + 1, lastGoodAt: ok ? now : cached?.lastGoodAt });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return ok;
  } catch {
    cache.set(key, { ok: false, checkedAt: now, failures: (cached?.failures || 0) + 1, lastGoodAt: cached?.lastGoodAt });
    return false;
  }
}

/** Probe a bounded fair sample without turning a CCTV listing request into thousands of requests. */
export async function refreshCameraHealth(cameras: CctvCamera[], limit = 24): Promise<void> {
  const candidates = cameras.filter((camera) => camera.feed_url || camera.stream_url).slice(0, limit);
  for (let i = 0; i < candidates.length; i += 6) {
    await Promise.allSettled(candidates.slice(i, i + 6).map(probeCamera));
  }
}

export function clearCameraHealthForTests(): void { cache.clear(); }

