import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { scrapeWazePoliceCameraAlerts, type WazeTransportMode } from '@/lib/traffic-alerts';

/**
 * HORUS — Waze live police / speed-camera alerts.
 *
 * Counter-surveillance intel: surfaces crowd-sourced Waze "police" and "camera"
 * reports for the requested viewport. Unlike the OSM point layers (police stations,
 * surveillance cameras — fixed infrastructure), these are *live, ephemeral* sightings
 * reported by Waze drivers, so they are kept in their own bucket/layer and never mixed
 * with the static OSM data.
 *
 * Pass ?bbox=s,w,n,e (required — there is no global default; scraping Waze is expensive).
 *
 * Transport caveat: Waze blocks plain server-side fetches (403) and headless browsers.
 * `transport=auto` (default) tries HTTP first, then falls back to a headed Chromium
 * session via Playwright, which briefly opens a visible browser window. Playwright is a
 * devDependency, so the browser fallback only works in development; in a packaged build
 * only the (usually 403-ing) HTTP path is available. See WAZE_SCRAPER_HANDOFF.md.
 */

// Playwright drives a real Chromium process — force the Node runtime, never edge,
// and opt out of static optimization since every response depends on ?bbox.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A headed-browser scrape of several tiles can take a while; give it headroom.
export const maxDuration = 60;

// Each request can spawn a browser and several GeoRSS tile fetches, so this is far
// more expensive than the OSM layers — rate limit it hard.
const RATE_LIMIT_PER_MIN = 6;
// Cap the requested area. The scraper tiles at 1°, so 4 deg² ⇒ at most ~4 tile
// fetches per request. A live map viewport at street/city zoom is well under this.
const MAX_BBOX_AREA_DEGREES = 4;

function parseTransport(value: string | null): WazeTransportMode {
  return value === 'http' || value === 'browser' ? value : 'auto';
}

export async function GET(request: Request) {
  try {
    const clientIp = getClientIp(request);
    if (isRateLimited(clientIp, RATE_LIMIT_PER_MIN, 60_000, 'waze-alerts')) {
      return NextResponse.json({ alerts: [], total: 0, error: 'Rate limit exceeded' }, { status: 429 });
    }

    const { searchParams } = new URL(request.url);
    const bboxParam = searchParams.get('bbox');
    if (!bboxParam) {
      return NextResponse.json({ alerts: [], total: 0, error: 'bbox is required; expected south,west,north,east' }, { status: 400 });
    }

    const parts = bboxParam.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return NextResponse.json({ alerts: [], total: 0, error: 'invalid bbox format; expected south,west,north,east' }, { status: 400 });
    }
    const [s, w, n, e] = parts;
    // w > e is a valid antimeridian-crossing box (the scraper splits it); only w === e is degenerate.
    if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w === e) {
      return NextResponse.json({ alerts: [], total: 0, error: 'invalid bbox coordinates' }, { status: 400 });
    }
    // Longitude width accounts for the antimeridian wrap so a crossing box isn't mis-sized.
    const lngWidth = w < e ? e - w : 360 - (w - e);
    if ((n - s) * lngWidth > MAX_BBOX_AREA_DEGREES) {
      return NextResponse.json({ alerts: [], total: 0, error: 'bbox area too large' }, { status: 400 });
    }

    const result = await scrapeWazePoliceCameraAlerts({
      bbox: [s, w, n, e],
      transport: parseTransport(searchParams.get('transport')),
      signal: request.signal,
    });

    return NextResponse.json(
      {
        alerts: result.alerts,
        total: result.alerts.length,
        timestamp: result.timestamp,
        errors: result.errors,
      },
      // Live, ephemeral data — short cache so a panning/refreshing client doesn't
      // re-launch the browser on every viewport nudge, but it stays reasonably fresh.
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } },
    );
  } catch (error) {
    // Surface a real scrape failure as an error status so the client shows it rather than
    // silently treating an exception as "0 alerts found". Log the cause server-side.
    console.error('Waze alerts fetch error:', error);
    return NextResponse.json({ alerts: [], total: 0, error: 'Failed to fetch Waze alerts' }, { status: 502 });
  }
}
