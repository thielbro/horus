import { NextResponse } from 'next/server';
import { safeAbortTimeout } from '@/lib/http-utils';

type NextFetchInit = RequestInit & { next?: { revalidate?: number } };

function fetchWithDeadline(url: string, init: NextFetchInit, timeoutMs = 12_000) {
  return fetch(url, {
    ...init,
    signal: safeAbortTimeout(timeoutMs),
  });
}

async function readJsonOrNull<T = any>(res: Response): Promise<T | null> {
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * HORUS — Global Stats API
 * Lightweight aggregation endpoint.
 * Fetches metrics from all local APIs and returns ONLY the counts.
 * 
 * ARCHITECTURE NOTE (10k+ Concurrent Users):
 * This endpoint ensures the Next.js server serves ~100 bytes instead of 10MB+ 
 * of raw GeoJSON mapping data when 10,000 users boot the dashboard simultaneously.
 * The underlying API routes utilize their own 45-60s TTL caching, meaning the 
 * heavy external APIs (adsb.lol, USGS) are only hit once per minute, while this 
 * lightweight stats route safely serves 10k concurrent users instantly.
 */

export async function GET(req: Request) {
  try {
    const origin = new URL(req.url).origin;

    // Fetch all internal APIs in parallel (they have their own Cache-Control TTLs)
    const [flightsRes, satsRes, cctvRes, weatherRes, infraRes, gdeltRes] = await Promise.allSettled([
      fetchWithDeadline(`${origin}/api/flights`, { next: { revalidate: 45 } }),
      fetchWithDeadline(`${origin}/api/satellites`, { next: { revalidate: 3600 } }, 15_000),
      // Keep the boot-time stats route bounded; the full camera catalog is loaded
      // only when the CCTV layer is explicitly enabled.
      fetchWithDeadline(`${origin}/api/cctv?region=uk`, { next: { revalidate: 3600 } }, 12_000),
      fetchWithDeadline(`${origin}/api/weather`, { next: { revalidate: 300 } }),
      fetchWithDeadline(`${origin}/api/infrastructure`, { next: { revalidate: 86400 } }),
      fetchWithDeadline(`${origin}/api/gdelt`, { next: { revalidate: 300 } })
    ]);

    let flights = 0;
    let sats = 0;
    let cctv = 0;
    let weather = 0;
    let nuclear = 0;
    let incidents = 0;

    // Safely parse counts
    if (flightsRes.status === 'fulfilled') {
      const data = await readJsonOrNull(flightsRes.value);
      if (data) {
        flights = (data.commercial_flights?.length || 0) +
                  (data.private_flights?.length || 0) +
                  (data.private_jets?.length || 0) +
                  (data.military_flights?.length || 0);
      }
    }

    if (satsRes.status === 'fulfilled') {
      const data = await readJsonOrNull(satsRes.value);
      sats = data?.satellites?.length || 0;
    }

    if (cctvRes.status === 'fulfilled') {
      const data = await readJsonOrNull(cctvRes.value);
      cctv = data?.cameras?.length || 0;
    }

    if (weatherRes.status === 'fulfilled') {
      const data = await readJsonOrNull(weatherRes.value);
      weather = data?.weather_events?.length || 0;
    }

    if (infraRes.status === 'fulfilled') {
      const data = await readJsonOrNull(infraRes.value);
      nuclear = data?.infrastructure?.length || 0;
    }

    if (gdeltRes.status === 'fulfilled') {
        const data = await readJsonOrNull(gdeltRes.value);
        if (data) incidents = data.events?.length || data.total || 0;
    }

    return NextResponse.json({
      stats: {
        flights,
        sats,
        cctv,
        weather,
        nuclear,
        incidents
      },
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      }
    });

  } catch (error) {
    console.error('Stats aggregation failed:', error);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
