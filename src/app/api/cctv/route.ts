import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { fetchCctvCamerasForRequest } from '@/lib/cctv/sources';

/**
 * HORUS — Worldwide CCTV Camera API v2.
 *
 * Source/fanout logic lives in src/lib/cctv/sources.ts so route exposure dossiers and
 * this API use the same fixed-CCTV inventory.
 */

// Fanning out to many regional sources can take a while; allow the platform up to 60s.
export const maxDuration = 60;

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 30); if (limited) return limited;
  try {
    const { searchParams } = new URL(request.url);
    const continent = searchParams.get('continent');
    const region = searchParams.get('region');
    const hasCoordinateQuery = searchParams.has('lat') || searchParams.has('lng');
    const lat = parseFloat(searchParams.get('lat') || '0');
    const lng = parseFloat(searchParams.get('lng') || '0');
    const radius = parseFloat(searchParams.get('radius') || '10');

    const result = await fetchCctvCamerasForRequest({
      continent,
      region,
      hasCoordinateQuery,
      lat,
      lng,
      radius,
    });

    const cacheControl = hasCoordinateQuery
      ? 'no-store, max-age=0'
      : 'public, s-maxage=300, stale-while-revalidate=600';

    return NextResponse.json({
      cameras: result.cameras,
      total: result.total,
      sources: result.sources,
      regions: result.regions,
      timestamp: result.timestamp,
    }, {
      headers: { 'Cache-Control': cacheControl },
    });
  } catch (error) {
    console.error('CCTV fetch error:', error);
    return NextResponse.json({ cameras: [], error: 'Failed' }, { status: 500 });
  }
}
