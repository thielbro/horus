import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { stealthFetch } from '@/lib/stealthFetch';
import { safeAbortTimeout, releaseResponseBody } from '@/lib/http-utils';
import { findPanorama, streetViewThumbUrl } from '@/lib/streetview/scrape';

/**
 * HORUS — keyless Google Street View image proxy.
 *
 * Streams a Street View still (scraped from Google's internal, keyless panorama endpoints —
 * see src/lib/streetview/scrape.ts) so the browser loads same-origin, cached images. The
 * address intel provider resolves the panorama once and points its photo URLs here.
 *
 * GET /api/streetview?panoid=&yaw=&pitch=&fov=&w=&h=
 *   (or ?lat=&lng=&yaw=… — resolves the nearest panorama first)
 */

export const dynamic = 'force-dynamic';

const FETCH_TIMEOUT_MS = 12_000;

function num(v: string | null): number | undefined {
  const n = parseFloat(v || '');
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 120);
  if (limited) return limited;

  const { searchParams } = new URL(request.url);
  const yaw = num(searchParams.get('yaw')) ?? num(searchParams.get('heading')) ?? 0;
  const pitch = num(searchParams.get('pitch')) ?? 0;
  const fov = num(searchParams.get('fov')) ?? 80;
  const w = num(searchParams.get('w')) ?? 640;
  const h = num(searchParams.get('h')) ?? 480;

  let panoid = (searchParams.get('panoid') || '').trim();
  if (!panoid) {
    const lat = num(searchParams.get('lat'));
    const lng = num(searchParams.get('lng'));
    if (lat === undefined || lng === undefined) {
      return new Response('Provide panoid or lat & lng', { status: 400 });
    }
    const pano = await findPanorama(lat, lng);
    if (!pano) return new Response('No Street View coverage', { status: 404 });
    panoid = pano.panoid;
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(panoid)) {
    return new Response('Invalid panoid', { status: 400 });
  }

  try {
    const res = await stealthFetch(streetViewThumbUrl(panoid, { yaw, pitch, fov, w, h }), {
      signal: safeAbortTimeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return new Response('Street View unavailable', { status: res.status });
    }
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      headers: {
        'Content-Type': res.headers.get('content-type') || 'image/jpeg',
        // A panorama is immutable for a given panoid — cache hard.
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  } catch {
    return new Response('Street View fetch failed', { status: 502 });
  }
}
