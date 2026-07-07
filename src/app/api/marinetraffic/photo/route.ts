import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { ensureMtSidecar, MT_BASE } from '@/lib/mt-sidecar';

export const dynamic = 'force-dynamic';

/**
 * HORUS — MarineTraffic photo proxy
 *
 * MT photo URLs are hotlink-protected, so the browser can't load them
 * directly. This route relays them through the sidecar's authenticated
 * Playwright session.
 *
 * GET /api/marinetraffic/photo?url=https://photos.marinetraffic.com/...
 */

const ALLOWED_HOSTS = new Set(['photos.marinetraffic.com', 'www.marinetraffic.com', 'marinetraffic.com']);

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 120);
  if (limited) return limited;

  const url = new URL(request.url).searchParams.get('url') || '';
  let host = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') host = parsed.hostname;
  } catch {
    /* invalid url → rejected below */
  }
  if (!ALLOWED_HOSTS.has(host)) {
    return NextResponse.json({ error: 'url must be a marinetraffic.com photo' }, { status: 400 });
  }

  const up = await ensureMtSidecar();
  if (!up) {
    return NextResponse.json({ error: 'MarineTraffic sidecar unavailable' }, { status: 503 });
  }

  try {
    const res = await fetch(`${MT_BASE}/photo?url=${encodeURIComponent(url)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `sidecar HTTP ${res.status}` }, { status: 502 });
    }
    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      headers: {
        'Content-Type': res.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
