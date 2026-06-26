import { NextResponse } from 'next/server';
import { runOverpassLayer, type BBox } from '@/lib/overpass';
import { curatedPoliceAll, isWithinCuratedCoverage } from '@/lib/police/curated';

/**
 * HORUS — Police Station Locations
 *
 * Counter-surveillance intel: maps the locations of police stations. Curated,
 * authoritative datasets (see src/lib/police/) are served wherever we have them
 * and replace live OpenStreetMap (`amenity=police`) inside their coverage; OSM
 * fills the gaps everywhere else. Positions only — OSM rows are community-sourced,
 * ODbL. Pass ?bbox=s,w,n,e to override the default (continent-scale) coverage.
 */

// [south, west, north, east] — dense-coverage regions.
const DEFAULTS: BBox[] = [
  [15, -170, 72, -52],  // North America
  [35, -11, 72, 40],    // Europe
  [-48, 112, -10, 180], // Oceania
];

export function GET(request: Request) {
  // Curated-only mode (?curated=1): return every owned station with no Overpass
  // call. The map loads this once on toggle so curated data is always visible at
  // any zoom, while the viewport (?bbox) path below fills in live OSM on top.
  const { searchParams } = new URL(request.url);
  if (searchParams.get('curated') != null) {
    const police = curatedPoliceAll();
    return NextResponse.json(
      { police, total: police.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } },
    );
  }

  return runOverpassLayer({
    request,
    bucket: 'police',
    defaults: DEFAULTS,
    userAgent: 'HORUS-map/1.0 (police-station location layer; OpenStreetMap data)',
    clausesFor: (bbox) => `node["amenity"="police"](${bbox});`,
    // Curated comes from the dedicated ?curated=1 bucket (always-on), so this OSM
    // path only returns live nodes OUTSIDE curated coverage — the drop below keeps
    // the two buckets disjoint (no duplicate pins where curated data exists).
    mapNode: (el) => {
      const lat = el.lat as number;
      const lng = el.lon as number;
      if (isWithinCuratedCoverage(lat, lng)) return null;
      const t = el.tags || {};
      return {
        id: `osm-police-${el.id}`,
        lat,
        lng,
        name: t.name || t.operator || 'Police Station',
        operator: t.operator || null,
        source: 'OpenStreetMap',
        osm_url: `https://www.openstreetmap.org/node/${el.id}`,
      };
    },
  });
}
