import { runOverpassLayer, type BBox } from '@/lib/overpass';
import { curatedPoliceWithin, isWithinCuratedCoverage } from '@/lib/police/curated';

/**
 * OSIRIS — Police Station Locations
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
  return runOverpassLayer({
    request,
    bucket: 'police',
    defaults: DEFAULTS,
    userAgent: 'OSIRIS-map/1.0 (police-station location layer; OpenStreetMap data)',
    clausesFor: (bbox) => `node["amenity"="police"](${bbox});`,
    mapNode: (el) => {
      const lat = el.lat as number;
      const lng = el.lon as number;
      // Curated data is authoritative inside its coverage — drop the OSM node so
      // it isn't duplicated by (or conflicting with) the injected curated row.
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
    extraRecords: (boxes) => curatedPoliceWithin(boxes),
  });
}
