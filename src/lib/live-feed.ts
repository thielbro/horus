import { NextResponse } from 'next/server';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

const LIVE_FEED_TIMEOUT_MS = 15_000;
const ACTIVITY_TIMEOUT_MS = 5_000;

function liveFeedBaseUrl(): string | null {
  const raw = process.env.LIVE_FEED_URL?.trim();
  return raw || null;
}

function unavailable(message: string, status = 503) {
  return NextResponse.json(
    {
      ports: [],
      chokepoints: [],
      ships: [],
      total_ports: 0,
      total_chokepoints: 0,
      total_ships: 0,
      returned_ships: 0,
      status: 'unavailable',
      error: message,
      backend: 'live-feed',
      backendUnavailable: true,
      timestamp: new Date().toISOString(),
    },
    { status },
  );
}

async function readJsonOrNull(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    await releaseResponseBody(res);
    return null;
  }
}

export async function proxyMaritimeSnapshot() {
  const base = liveFeedBaseUrl();
  if (!base) return unavailable('Live feed backend is not configured. Set LIVE_FEED_URL.');

  const url = new URL('/v1/feeds/maritime/snapshot', base.endsWith('/') ? base : `${base}/`);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: safeAbortTimeout(LIVE_FEED_TIMEOUT_MS),
    });
    const json = await readJsonOrNull(res);
    if (!res.ok) {
      return unavailable(json?.error || `Live feed returned HTTP ${res.status}`, res.status >= 500 ? 503 : res.status);
    }
    return NextResponse.json(
      {
        ports: Array.isArray(json?.ports) ? json.ports : [],
        chokepoints: Array.isArray(json?.chokepoints) ? json.chokepoints : [],
        ships: Array.isArray(json?.ships) ? json.ships : [],
        total_ports: Number(json?.total_ports) || 0,
        total_chokepoints: Number(json?.total_chokepoints) || 0,
        total_ships: Number(json?.total_ships) || 0,
        returned_ships: Number(json?.returned_ships) || 0,
        status: json?.status || 'unknown',
        active: !!json?.active,
        source: json?.source || 'live-feed',
        poll_interval_ms: json?.poll_interval_ms,
        sample_duration_ms: json?.sample_duration_ms,
        ship_ttl_ms: json?.ship_ttl_ms,
        last_sample_at: json?.last_sample_at,
        next_sample_at: json?.next_sample_at,
        error: json?.error || null,
        backend: 'live-feed',
        timestamp: json?.timestamp || new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.warn('[HORUS] Live feed maritime proxy failed:', error instanceof Error ? error.message : error);
    return unavailable('Live feed backend unavailable');
  }
}

export async function proxyLiveFeedActivity(request: Request) {
  const base = liveFeedBaseUrl();
  if (!base) {
    return NextResponse.json(
      { error: 'Live feed backend is not configured. Set LIVE_FEED_URL.', backend: 'live-feed' },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const url = new URL('/v1/activity', base.endsWith('/') ? base : `${base}/`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: safeAbortTimeout(ACTIVITY_TIMEOUT_MS),
    });
    const json = await readJsonOrNull(res);
    if (!res.ok) {
      return NextResponse.json(
        { error: json?.error || `Live feed returned HTTP ${res.status}`, backend: 'live-feed' },
        { status: res.status >= 500 ? 503 : res.status },
      );
    }
    return NextResponse.json({ ...(json || {}), backend: 'live-feed' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.warn('[HORUS] Live feed activity proxy failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Live feed backend unavailable', backend: 'live-feed' }, { status: 503 });
  }
}
