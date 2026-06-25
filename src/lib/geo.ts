// Small geo primitives for the intel framework (address radius, route corridor).
// Hand-rolled to avoid a Turf dependency — only a few operations are needed.

import type { BBox } from '@/lib/overpass';

const EARTH_R = 6_371_000; // metres
const D2R = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

function normalizeLng(lng: number): number {
  const normalized = ((((lng + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

/** Great-circle distance in metres between two lat/lng points. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * D2R;
  const dLng = (bLng - aLng) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Axis-aligned bbox [south, west, north, east] covering a circle of radius `radiusM`. */
export function pointBbox(lat: number, lng: number, radiusM: number): BBox {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(lat * D2R)));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng];
}

/** bbox [s,w,n,e] of a set of [lng,lat] points, padded by `padM` metres. */
export function bboxOfPoints(points: Array<[number, number]>, padM = 0): BBox | null {
  if (points.length === 0) return null;

  let s = 90, n = -90;
  const lngs: number[] = [];
  for (const [lng, lat] of points) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    lngs.push(normalizeLng(lng));
  }

  const sortedLngs = lngs.sort((a, b) => a - b);
  let w = sortedLngs[0];
  let e = sortedLngs[sortedLngs.length - 1];
  if (sortedLngs.length > 1 && e - w > 180) {
    let largestGap = -1;
    let gapStartIndex = 0;
    for (let i = 0; i < sortedLngs.length; i++) {
      const current = sortedLngs[i];
      const next = i === sortedLngs.length - 1 ? sortedLngs[0] + 360 : sortedLngs[i + 1];
      const gap = next - current;
      if (gap > largestGap) {
        largestGap = gap;
        gapStartIndex = i;
      }
    }
    w = sortedLngs[(gapStartIndex + 1) % sortedLngs.length];
    e = sortedLngs[gapStartIndex];
  }

  if (padM > 0) {
    const midLat = (s + n) / 2;
    const dLat = padM / M_PER_DEG_LAT;
    const dLng = padM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(midLat * D2R)));
    s -= dLat; n += dLat; w = normalizeLng(w - dLng); e = normalizeLng(e + dLng);
  }
  return [s, w, n, e];
}

/** Closed ring of [lng,lat] approximating a circle of `radiusM` around a point (for map fills). */
export function circlePolygon(lat: number, lng: number, radiusM: number, steps = 64): Array<[number, number]> {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(lat * D2R)));
  const ring: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

// Local equirectangular projection (metres) around an origin latitude — good enough for the
// short distances involved in "near this point / along this segment" filtering.
function toLocal(lat: number, lng: number, lat0: number): [number, number] {
  const x = lng * D2R * EARTH_R * Math.cos(lat0 * D2R);
  const y = lat * D2R * EARTH_R;
  return [x, y];
}

/** Shortest distance in metres from a point to the segment a→b. */
export function pointToSegmentMeters(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const lat0 = (aLat + bLat) / 2;
  const [px, py] = toLocal(pLat, pLng, lat0);
  const [ax, ay] = toLocal(aLat, aLng, lat0);
  const [bx, by] = toLocal(bLat, bLng, lat0);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Shortest distance in metres from a point to a polyline (array of [lng,lat]). */
export function pointToLineMeters(pLat: number, pLng: number, line: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [aLng, aLat] = line[i - 1];
    const [bLng, bLat] = line[i];
    const d = pointToSegmentMeters(pLat, pLng, aLat, aLng, bLat, bLng);
    if (d < best) best = d;
  }
  return best;
}
