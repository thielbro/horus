// Small geo primitives for the intel framework (address radius, route corridor).
// Scalar arguments use (lat, lng); coordinate tuples use GeoJSON order [lng, lat].
// Hand-rolled to avoid a Turf dependency — only a few operations are needed.

import type { BBox } from '@/lib/overpass';

const EARTH_R = 6_371_000; // metres
const D2R = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

function normalizeLng(lng: number): number {
  if (!Number.isFinite(lng)) return NaN;
  const normalized = ((((lng + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) return NaN;
  return Math.max(-90, Math.min(90, lat));
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
  const centerLat = clampLat(lat);
  const centerLng = normalizeLng(lng);
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(centerLat * D2R)));
  const s = clampLat(centerLat - dLat);
  const n = clampLat(centerLat + dLat);
  if (dLng >= 180) return [s, -180, n, 180];
  return [s, normalizeLng(centerLng - dLng), n, normalizeLng(centerLng + dLng)];
}

/** bbox [s,w,n,e] of a set of [lng,lat] points, padded by `padM` metres. */
export function bboxOfPoints(points: Array<[number, number]>, padM = 0): BBox | null {
  if (points.length === 0) return null;

  let s = 90, n = -90;
  const lngs: number[] = [];
  for (const [lng, lat] of points) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const safeLat = clampLat(lat);
    if (safeLat < s) s = safeLat;
    if (safeLat > n) n = safeLat;
    lngs.push(normalizeLng(lng));
  }
  if (lngs.length === 0) return null;

  const sortedLngs = lngs.sort((a, b) => a - b);
  let w = sortedLngs[0];
  let e = sortedLngs[sortedLngs.length - 1];
  let crossesAntimeridian = false;
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
    crossesAntimeridian = true;
  }

  if (padM > 0) {
    const midLat = (s + n) / 2;
    const dLat = padM / M_PER_DEG_LAT;
    const dLng = padM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(midLat * D2R)));
    s = clampLat(s - dLat);
    n = clampLat(n + dLat);

    const span = crossesAntimeridian ? (e + 360 - w) : (e - w);
    if (span + 2 * dLng >= 360) {
      w = -180;
      e = 180;
      crossesAntimeridian = false;
    } else if (crossesAntimeridian) {
      w = normalizeLng(w - dLng);
      e = normalizeLng(e + dLng);
    } else {
      w = Math.max(-180, w - dLng);
      e = Math.min(180, e + dLng);
    }
  }
  return [s, w, n, e];
}

/**
 * Closed ring of [lng,lat] approximating a circle of `radiusM` around a point.
 * Uses a local equirectangular approximation; accurate for small radii and low/mid latitudes.
 */
export function circlePolygon(lat: number, lng: number, radiusM: number, steps = 64): Array<[number, number]> {
  const centerLat = clampLat(lat);
  const centerLng = normalizeLng(lng);
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(centerLat * D2R)));
  const ring: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([normalizeLng(centerLng + dLng * Math.cos(a)), clampLat(centerLat + dLat * Math.sin(a))]);
  }
  return ring;
}

// Local equirectangular projection (metres) around an origin latitude — good enough for the
// short distances involved in "near this point / along this segment" filtering.
function toLocal(lat: number, lng: number, lat0: number, refLng: number): [number, number] {
  const x = normalizeLng(lng - refLng) * D2R * EARTH_R * Math.cos(lat0 * D2R);
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
  const [px, py] = toLocal(pLat, pLng, lat0, aLng);
  const [ax, ay] = toLocal(aLat, aLng, lat0, aLng);
  const [bx, by] = toLocal(bLat, bLng, lat0, aLng);
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

/**
 * Project a point onto a polyline (array of [lng,lat]). Returns the perpendicular distance to
 * the nearest segment and the distance travelled *along* the line to that projection — used to
 * filter route-corridor candidates (`perpM`) and order them start→end (`alongM`).
 */
export function projectPointOnLine(pLat: number, pLng: number, line: Array<[number, number]>): { perpM: number; alongM: number } {
  let best = { perpM: Infinity, alongM: 0 };
  let cum = 0;
  for (let i = 1; i < line.length; i++) {
    const [aLng, aLat] = line[i - 1];
    const [bLng, bLat] = line[i];
    const lat0 = (aLat + bLat) / 2;
    const [ax, ay] = toLocal(aLat, aLng, lat0, aLng);
    const [bx, by] = toLocal(bLat, bLng, lat0, aLng);
    const [px, py] = toLocal(pLat, pLng, lat0, aLng);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const perp = Math.hypot(px - cx, py - cy);
    if (perp < best.perpM) best = { perpM: perp, alongM: cum + t * segLen };
    cum += segLen;
  }
  return best;
}

/**
 * Closed ring of [lng,lat] approximating a `halfWidthM` buffer around a polyline (a route
 * corridor). Offsets each vertex along the segment normal, going forward on one side and back
 * on the other. May self-intersect on hairpin turns, but reads fine as a translucent fill.
 * Intended for a continuous local route; antimeridian-spanning corridors can render split or
 * wrapped depending on the map engine's GeoJSON line handling.
 */
export function bufferPolygon(line: Array<[number, number]>, halfWidthM: number): Array<[number, number]> | null {
  const pts = line.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (pts.length < 2 || !(halfWidthM > 0)) return null;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const [lng, lat] = pts[i];
    const prev = pts[i - 1] ?? pts[i];
    const next = pts[i + 1] ?? pts[i];
    const cos = Math.max(0.01, Math.cos(lat * D2R));
    // Tangent of the line at this vertex, in metres.
    const dxM = normalizeLng(next[0] - prev[0]) * M_PER_DEG_LAT * cos;
    const dyM = (next[1] - prev[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dxM, dyM) || 1;
    const nxM = -dyM / len, nyM = dxM / len; // unit normal
    const dLng = (nxM * halfWidthM) / (M_PER_DEG_LAT * cos);
    const dLat = (nyM * halfWidthM) / M_PER_DEG_LAT;
    left.push([normalizeLng(lng + dLng), clampLat(lat + dLat)]);
    right.push([normalizeLng(lng - dLng), clampLat(lat - dLat)]);
  }
  return [...left, ...right.reverse(), left[0]];
}

/**
 * Split a bbox [s,w,n,e] into a grid of sub-boxes each under `maxAreaDeg` (degrees²), so a long
 * route corridor can be queried within the Overpass area cap. Antimeridian-crossing boxes
 * (w >= e) and degenerate boxes are returned as-is. Total tiles are capped at `maxTiles`.
 */
export function tileBbox(bbox: BBox, maxAreaDeg: number, maxTiles = 24): BBox[] {
  const [s, w, n, e] = bbox;
  const height = n - s;
  const width = e - w;
  if (!(height > 0) || !(width > 0)) return [bbox];
  if (height * width <= maxAreaDeg) return [bbox];
  const side = Math.sqrt(maxAreaDeg) * 0.95;
  let nx = Math.max(1, Math.ceil(width / side));
  let ny = Math.max(1, Math.ceil(height / side));
  while (nx * ny > maxTiles) {
    if (nx >= ny && nx > 1) nx--;
    else if (ny > 1) ny--;
    else break;
  }
  const tiles: BBox[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      tiles.push([
        s + (height * iy) / ny,
        w + (width * ix) / nx,
        s + (height * (iy + 1)) / ny,
        w + (width * (ix + 1)) / nx,
      ]);
    }
  }
  return tiles;
}
