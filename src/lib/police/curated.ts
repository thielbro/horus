import type { BBox } from '@/lib/overpass';
import type { CuratedPoliceDataset, PoliceStation } from './types';
import { NZ_POLICE } from './newzealand';

/**
 * HORUS — curated police-station database.
 *
 * Authoritative, owned datasets that replace live OpenStreetMap results inside
 * their coverage. Add a country by appending its dataset here. The `/api/police`
 * layer (and, later, the address/route intel providers) call into these helpers
 * so curated data wins wherever we have it and OSM fills the gaps elsewhere.
 */
const DATASETS: CuratedPoliceDataset[] = [
  NZ_POLICE,
];

function lngInBox(lng: number, w: number, e: number): boolean {
  return w <= e ? lng >= w && lng <= e : lng >= w || lng <= e;
}

function splitAntimeridianBox(box: BBox): BBox[] {
  const [s, w, n, e] = box;
  if (w <= e) return [box];
  return [
    [s, w, n, 180],
    [s, -180, n, e],
  ];
}

function boxesIntersect(a: BBox, b: BBox): boolean {
  for (const [as_, aw, an, ae] of splitAntimeridianBox(a)) {
    for (const [bs, bw, bn, be] of splitAntimeridianBox(b)) {
      if (as_ <= bn && bs <= an && aw <= be && bw <= ae) return true;
    }
  }
  return false;
}

function pointInBox(lat: number, lng: number, box: BBox): boolean {
  const [s, w, n, e] = box;
  return lat >= s && lat <= n && lngInBox(lng, w, e);
}

/**
 * Curated stations to inject for a request covering `boxes`. A dataset is
 * included whole when any of its coverage boxes intersects any requested box —
 * so a viewport touching New Zealand returns the complete national set, not a
 * viewport-clipped slice. Cheap: a few hundred rows per country.
 */
export function curatedPoliceWithin(boxes: BBox[]): PoliceStation[] {
  const out: PoliceStation[] = [];
  for (const ds of DATASETS) {
    if (ds.coverage.some((cb) => boxes.some((rb) => boxesIntersect(cb, rb)))) {
      out.push(...ds.stations);
    }
  }
  return out;
}

/**
 * Curated stations whose coordinates physically fall inside `boxes`. Unlike
 * {@link curatedPoliceWithin} (which injects a whole country for the map layer),
 * this returns only stations actually in the query area — what the address/route
 * intel providers need before applying their own radius / corridor distance
 * filter. Deduped by id across overlapping boxes.
 */
export function curatedPoliceInBoxes(boxes: BBox[]): PoliceStation[] {
  const out: PoliceStation[] = [];
  const seen = new Set<string>();
  for (const ds of DATASETS) {
    if (!ds.coverage.some((cb) => boxes.some((rb) => boxesIntersect(cb, rb)))) continue;
    for (const st of ds.stations) {
      if (seen.has(st.id)) continue;
      if (boxes.some((b) => pointInBox(st.lat, st.lng, b))) {
        seen.add(st.id);
        out.push(st);
      }
    }
  }
  return out;
}

/**
 * True if a point falls inside any curated dataset's coverage. Live OSM nodes
 * that match are dropped so curated data is the single source of truth there
 * (no duplicate pins, no stale community edits).
 */
export function isWithinCuratedCoverage(lat: number, lng: number): boolean {
  return DATASETS.some((ds) => ds.coverage.some((cb) => pointInBox(lat, lng, cb)));
}
