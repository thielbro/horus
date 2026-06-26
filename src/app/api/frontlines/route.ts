
import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

/**
 * HORUS — Ukraine Frontline API
 * Fetches live warfront GeoJSON from DeepState Map
 */

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 60); if (limited) return limited;
  try {
    const url = 'https://deepstatemap.live/api/history/last';
    const res = await fetch(url, {
      signal: safeAbortTimeout(10000), // Cache 30 min
    });

    if (!res.ok) {
      await releaseResponseBody(res);
      return NextResponse.json({ frontlines: null, error: 'DeepState unavailable' });
    }

    const data = await res.json();

    return NextResponse.json({
      frontlines: data,
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    });
  } catch (error) {
    console.error('Frontlines fetch error:', error);
    return NextResponse.json({ frontlines: null, error: 'Failed to fetch frontline data' }, { status: 500 });
  }
}

