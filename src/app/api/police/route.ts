import { NextResponse } from 'next/server';
import { curatedPoliceAll } from '@/lib/police/curated';
import { proxySurveillanceLayer } from '@/lib/surveillance-feed';

/**
 * HORUS — Police Station Locations
 *
 * The viewport-fed fixed layer comes from the SQLite surveillance-feed sidecar.
 * Curated NZ data remains available locally through ?curated=1 so backend
 * outages do not remove the owned police station fallback.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('curated') != null) {
    const police = curatedPoliceAll();
    return NextResponse.json(
      { police, total: police.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } },
    );
  }

  return proxySurveillanceLayer({ request, layer: 'police', bucket: 'police' });
}
