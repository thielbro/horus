import { runOverpassLayer, type BBox } from '@/lib/overpass';

/**
 * OSIRIS — Known Mass-Surveillance Technology (OpenStreetMap)
 *
 * Maps fixed surveillance cameras covering public space / whole areas — the markers most
 * associated with mass monitoring (`man_made=surveillance` with `surveillance=public` or a
 * town/area `surveillance:zone`). Positions only — community-sourced, ODbL. Pass
 * ?bbox=s,w,n,e to override.
 */

// [south, west, north, east] — regions with the densest OSM surveillance tagging.
const DEFAULTS: BBox[] = [
  [35, -11, 72, 40],   // Europe
  [15, -170, 72, -52], // North America
];

export function GET(request: Request) {
  return runOverpassLayer({
    request,
    bucket: 'mass_surveil',
    defaults: DEFAULTS,
    userAgent: 'OSIRIS-map/1.0 (mass-surveillance location layer; OpenStreetMap data)',
    clausesFor: (bbox) =>
      `node["man_made"="surveillance"]["surveillance"="public"](${bbox});\n  node["man_made"="surveillance"]["surveillance:zone"="town"](${bbox});\n  node["man_made"="surveillance"]["surveillance:zone"="area"](${bbox});`,
    mapNode: (el) => {
      const t = el.tags || {};
      return {
        id: `osm-mass-${el.id}`,
        lat: el.lat as number,
        lng: el.lon as number,
        name: t.name || t.operator || 'Surveillance',
        operator: t.operator || null,
        surveillance_type: t['surveillance:type'] || null,
        zone: t['surveillance:zone'] || t.surveillance || null,
        source: 'OpenStreetMap',
        osm_url: `https://www.openstreetmap.org/node/${el.id}`,
      };
    },
  });
}
