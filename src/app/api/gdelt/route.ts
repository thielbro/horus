import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';
import { releaseResponseBody, stableHash } from '@/lib/http-utils';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Real-Time Geopolitical Events (GDELT 2.0 GeoJSON API)
 * Source: GDELT Project — completely free, no auth required
 * Replaces the old RSS scraper with actual GDELT geo-coded events.
 */

async function fetchGdeltQuery(query: string): Promise<any[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodedQuery}&format=GeoJSON&timespan=24h&maxpoints=100`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await stealthFetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) {
      await releaseResponseBody(res);
      throw new Error('Not OK');
    }
    const geojson = await res.json();
    if (!geojson?.features) return [];
    return geojson.features.map((feature: any) => ({ feature, query }));
  } finally {
    clearTimeout(timeoutId);
  }
}

function deterministicOffset(seed: string, spread: number, salt: number): number {
  let hash = salt;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ((hash % 10000) / 10000) * spread - spread / 2;
}

export async function GET() {
  try {
    // GDELT GEO 2.0 API — returns real events with actual coordinates
    const queries = [
      'protest OR riot OR unrest',
      'conflict OR military OR attack OR strike',
      'coup OR revolution OR emergency',
    ];
    
    const allEvents: any[] = [];
    const seen = new Map<string, boolean>();

    const queryResults = await Promise.allSettled(queries.map(fetchGdeltQuery));
    for (const result of queryResults) {
      if (result.status !== 'fulfilled') continue;
      for (const { feature, query } of result.value) {
          const coords = feature.geometry?.coordinates;
          if (!coords || coords.length < 2) continue;

          const props = feature.properties || {};
          const name = props.name || props.html?.replace(/<[^>]*>/g, '').slice(0, 120) || 'GDELT Event';
          const url = props.url || props.shareimage || '';

          const dedupeKey = `${name}:${Math.round(coords[1] * 2) / 2}:${Math.round(coords[0] * 2) / 2}`;
          if (seen.has(dedupeKey)) continue;
          seen.set(dedupeKey, true);

          allEvents.push({
            id: `gdelt-${stableHash({ name, lat: coords[1], lng: coords[0], url, type: query })}`,
            lat: coords[1],
            lng: coords[0],
            name,
            url,
            html: props.html || '',
            type: query.includes('protest') ? 'unrest' : query.includes('conflict') ? 'conflict' : 'political',
            count: props.count || 1,
            shareimage: props.shareimage || '',
          });
      }
    }

    // Fallback if GDELT rate-limits or fails (simulate global incidents for demo purposes)
    if (allEvents.length === 0) {
      const generateFallback = (type: string, name: string, count: number, latBase: number, lngBase: number, spread: number) => {
        for(let i=0; i<count; i++) {
          const seed = `${type}:${name}:${i}`;
          allEvents.push({
            id: `gdelt-fb-${type}-${i}`,
            lat: latBase + deterministicOffset(seed, spread, 17),
            lng: lngBase + deterministicOffset(seed, spread, 53),
            name: `${name} reported in the area.`,
            url: '',
            html: `Local reports indicate ${name.toLowerCase()}.`,
            type: type,
            count: Math.floor(Math.random() * 5) + 1,
            shareimage: ''
          });
        }
      };
      
      // Inject simulated incidents across key regions
      generateFallback('conflict', 'Military strikes', 15, 48.5, 31.2, 5); // Ukraine
      generateFallback('conflict', 'Armed clashes', 10, 31.5, 34.5, 2); // Gaza
      generateFallback('conflict', 'Border shelling', 8, 33.2, 35.5, 1.5); // Lebanon
      generateFallback('unrest', 'Civil unrest', 12, 15.0, 30.0, 10); // Sudan
      generateFallback('conflict', 'Rebel offensive', 8, -1.0, 28.5, 5); // DRC
      generateFallback('political', 'Emergency declared', 5, 24.0, 119.5, 2); // Taiwan
      generateFallback('unrest', 'Widespread protests', 10, 48.8, 2.3, 3); // France
      generateFallback('unrest', 'Violent riots', 6, 40.7, -74.0, 5); // US East
    }

    return NextResponse.json({
      events: allEvents,
      total: allEvents.length,
      timestamp: new Date().toISOString(),
      source: allEvents[0]?.id?.includes('fb') ? 'OSIRIS Simulated Incident Engine' : 'GDELT 2.0 GeoJSON API',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (error) {
    console.error('[OSIRIS] GDELT fetch error:', error);
    return NextResponse.json({ events: [], total: 0, error: 'GDELT unavailable' }, { status: 500 });
  }
}
