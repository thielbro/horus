import { runOverpassLayer, type BBox } from '@/lib/overpass';

/**
 * HORUS — Flock / ALPR Camera Locations (OpenStreetMap / DeFlock)
 *
 * Maps automated license-plate reader (ALPR) cameras — Flock Safety and similar — tagged in
 * OSM with the DeFlock convention (`man_made=surveillance` + `surveillance:type=ALPR`).
 * Positions only — community-sourced, ODbL. Pass ?bbox=s,w,n,e to override.
 */

// [south, west, north, east] — DeFlock coverage is North-America-heavy; Europe included.
const DEFAULTS: BBox[] = [
  [15, -170, 72, -52], // North America
  [35, -11, 72, 40],   // Europe
];

export function GET(request: Request) {
  return runOverpassLayer({
    request,
    bucket: 'flock',
    defaults: DEFAULTS,
    userAgent: 'HORUS-map/1.0 (ALPR/Flock location layer; OpenStreetMap/DeFlock data)',
    clausesFor: (bbox) =>
      `node["man_made"="surveillance"]["surveillance:type"="ALPR"](${bbox});\n  node["man_made"="surveillance"]["camera:type"="ALPR"](${bbox});`,
    mapNode: (el) => {
      const t = el.tags || {};
      return {
        id: `osm-flock-${el.id}`,
        lat: el.lat as number,
        lng: el.lon as number,
        name: t.name || t.operator || 'ALPR Camera',
        operator: t.operator || null,
        surveillance_type: t['surveillance:type'] || 'ALPR',
        direction: t.direction || null,
        source: 'OpenStreetMap / DeFlock',
        osm_url: `https://www.openstreetmap.org/node/${el.id}`,
      };
    },
  });
}
