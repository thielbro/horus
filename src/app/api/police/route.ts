import { runOverpassLayer, type BBox } from '@/lib/overpass';

/**
 * OSIRIS — Police Station Locations (OpenStreetMap)
 *
 * Counter-surveillance intel: maps the locations of police stations (`amenity=police`).
 * Positions only — community-sourced, ODbL. Pass ?bbox=s,w,n,e to override the default
 * (continent-scale) coverage.
 */

// [south, west, north, east] — dense-coverage regions.
const DEFAULTS: BBox[] = [
  [15, -170, 72, -52],  // North America
  [35, -11, 72, 40],    // Europe
  [-48, 112, -10, 180], // Oceania
];

export function GET(request: Request) {
  return runOverpassLayer({
    request,
    bucket: 'police',
    defaults: DEFAULTS,
    userAgent: 'OSIRIS-map/1.0 (police-station location layer; OpenStreetMap data)',
    clausesFor: (bbox) => `node["amenity"="police"](${bbox});`,
    mapNode: (el) => {
      const t = el.tags || {};
      return {
        id: `osm-police-${el.id}`,
        lat: el.lat as number,
        lng: el.lon as number,
        name: t.name || t.operator || 'Police Station',
        operator: t.operator || null,
        source: 'OpenStreetMap',
        osm_url: `https://www.openstreetmap.org/node/${el.id}`,
      };
    },
  });
}
