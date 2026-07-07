import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { ensureMtSidecar, MT_BASE } from '@/lib/mt-sidecar';

export const dynamic = 'force-dynamic';

/**
 * HORUS — MarineTraffic Pro vessel dossier
 *
 * Proxies the local mt_server.py sidecar (persistent logged-in Playwright
 * session) to enrich a clicked vessel with Pro-level data: full particulars,
 * voyage info, weather at position, and the complete photo gallery.
 *
 * GET /api/marinetraffic?mmsi=...  (or imo= / shipid=)
 * → { vessel: {...}, source: 'marinetraffic', cached: boolean }
 *
 * First query after a cold start can take 30-90s (browser launch + login);
 * subsequent queries are a few seconds. Results are cached for 10 minutes.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; vessel: any }>();
const inflight = new Map<string, Promise<any>>();

async function queryVessel(qs: string): Promise<any> {
  const res = await fetch(`${MT_BASE}/vessel?${qs}&photos=1`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(240_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.vessel) {
    throw new Error(json?.error || `sidecar HTTP ${res.status}`);
  }
  return json.vessel;
}

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 20);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const mmsi = params.get('mmsi')?.replace(/\D/g, '') || '';
  const imo = params.get('imo')?.replace(/\D/g, '') || '';
  const shipid = params.get('shipid')?.replace(/\D/g, '') || '';
  if (!mmsi && !imo && !shipid) {
    return NextResponse.json({ vessel: null, error: 'mmsi, imo or shipid required' }, { status: 400 });
  }

  const key = `${shipid}|${mmsi}|${imo}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(
      { vessel: cached.vessel, source: 'marinetraffic', cached: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const up = await ensureMtSidecar();
  if (!up) {
    return NextResponse.json(
      { vessel: null, error: 'MarineTraffic sidecar unavailable (python + playwright required)' },
      { status: 503 },
    );
  }

  const qs = new URLSearchParams();
  if (shipid) qs.set('shipid', shipid);
  if (mmsi) qs.set('mmsi', mmsi);
  if (imo) qs.set('imo', imo);

  // Dedupe concurrent identical clicks — the scrape is expensive.
  let promise = inflight.get(key);
  if (!promise) {
    promise = queryVessel(qs.toString()).finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }

  try {
    const vessel = await promise;
    cache.set(key, { at: Date.now(), vessel });
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first == null) break;
      cache.delete(first);
    }
    return NextResponse.json(
      { vessel, source: 'marinetraffic', cached: false },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[HORUS] MarineTraffic lookup failed:', message);
    return NextResponse.json({ vessel: null, error: message }, { status: 502 });
  }
}
