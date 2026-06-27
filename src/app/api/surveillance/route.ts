import { runOverpassLayer, titleCase, type BBox } from '@/lib/overpass';

/**
 * HORUS — Surveillance Camera Locations (OpenStreetMap)
 *
 * Counter-surveillance intel layer: maps the LOCATIONS of fixed surveillance
 * cameras (`man_made=surveillance`) and speed/enforcement cameras
 * (`highway=speed_camera`) in OpenStreetMap. Positions only — no live video.
 * Data is community-sourced and licensed ODbL.
 *
 * Default coverage: New Zealand + Australia. Pass ?bbox=s,w,n,e to override.
 * Shares the resilient Overpass helper (concurrency gate, mirror fallback,
 * caching) with the police / Flock / mass-surveillance layers.
 */

// [south, west, north, east]
const NZ: BBox = [-47.5, 166, -34, 179.5];
const AU: BBox = [-44, 112, -10, 154];
const DEFAULTS: BBox[] = [NZ, AU];

function countryFor(lat: number, lng: number): string {
  const [s, w, n, e] = NZ;
  if (lat >= s && lat <= n && lng >= w && lng <= e) return 'New Zealand';
  return 'Australia';
}

export function GET(request: Request) {
  return runOverpassLayer({
    request,
    bucket: 'surveillance',
    defaults: DEFAULTS,
    userAgent: 'HORUS-map/1.0 (surveillance-location layer; OpenStreetMap data)',
    clausesFor: (bbox) => `node["man_made"="surveillance"](${bbox});\n  node["highway"="speed_camera"](${bbox});`,
    mapNode: (el) => {
      const lat = el.lat as number;
      const lng = el.lon as number;
      const t = el.tags || {};
      const isSpeed = t.highway === 'speed_camera';
      const kind = isSpeed ? 'speed_camera' : t['surveillance:type'] || t['camera:type'] || 'camera';
      return {
        id: `osm-surv-${el.id}`,
        lat,
        lng,
        name: t.name || t.description || t.operator || titleCase(kind),
        country: countryFor(lat, lng),
        surveillance_type: isSpeed ? 'speed_camera' : t['surveillance:type'] || null,
        camera_type: t['camera:type'] || null,
        zone: t['surveillance:zone'] || t.enforcement || null,
        operator: t.operator || null,
        source: 'OpenStreetMap',
        osm_url: `https://www.openstreetmap.org/node/${el.id}`,
      };
    },
  });
}
