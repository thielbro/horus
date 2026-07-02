// Keyless Google Street View scraper. Uses the same internal endpoints the Maps JS client
// uses — no API key, no billing:
//   1. GeoPhotoService.SingleImageSearch → nearest panorama id + its precise lat/lng (JSONP).
//   2. streetviewpixels-pa.googleapis.com/v1/thumbnail → a single JPEG at a chosen yaw/pitch/fov.
// The address provider resolves the panorama once, aims the camera FROM the panorama AT the
// building, and points its photo URLs at /api/streetview (which fetches the thumbnails).
// Server-side only.

import { stealthFetch } from '@/lib/stealthFetch';
import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';

const SEARCH_URL = 'https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch';
export const STREETVIEW_THUMB_URL = 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail';
const SEARCH_TIMEOUT_MS = 8_000;

export interface StreetViewPano {
  panoid: string;
  lat: number;
  lng: number;
  /** Capture date as "YYYY-MM", if present. */
  date?: string;
}

// The `pb` protobuf-ish query the internal endpoint expects. `3d`/`4d` carry the lat/lng and
// `2d` the search radius (metres). A `callback` param is REQUIRED — without it Google 404s.
function searchUrl(lat: number, lng: number, radiusM: number): string {
  const pb =
    `!1m5!1sapiv3!5sUS!11m2!1m1!1b0!2m4!1m2!3d${lat}!4d${lng}!2d${radiusM}` +
    `!3m10!2m2!1sen!2sUS!9m1!1e2!11m4!1m3!1e2!2b1!3e2!4m10!1e1!1e2!1e3!1e4!1e8!1e6!5m1!1e2!6m1!1e2`;
  return `${SEARCH_URL}?pb=${pb}&callback=cb`;
}

function parseJsonp(text: string): any | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  const body = text.slice(start).trim().replace(/\)\s*;?\s*$/, '');
  try {
    return JSON.parse(body);
  } catch {
    const end = body.lastIndexOf(']');
    if (end < 0) return null;
    try {
      return JSON.parse(body.slice(0, end + 1));
    } catch {
      return null;
    }
  }
}

function isPanoId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(v);
}

// Closest lat/lng to the query — a structure-independent fallback if the index path shifts.
// The chosen panorama is within the search radius, so its coords are the closest to the query.
function closestCoord(data: unknown, qLat: number, qLng: number): { lat: number; lng: number } | null {
  let bestLat: number | undefined;
  let bestLng: number | undefined;
  let dLat = Infinity;
  let dLng = Infinity;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
    } else if (typeof x === 'number') {
      const aLat = Math.abs(x - qLat);
      if (aLat < 0.01 && aLat < dLat) { dLat = aLat; bestLat = x; }
      const aLng = Math.abs(x - qLng);
      if (aLng < 0.01 && aLng < dLng) { dLng = aLng; bestLng = x; }
    }
  };
  walk(data);
  return typeof bestLat === 'number' && typeof bestLng === 'number' ? { lat: bestLat, lng: bestLng } : null;
}

function extractDate(data: unknown): string | undefined {
  let out: string | undefined;
  const walk = (x: unknown) => {
    if (out || !Array.isArray(x)) return;
    if (x.length >= 2 && typeof x[0] === 'number' && typeof x[1] === 'number' &&
        x[0] >= 2005 && x[0] <= 2035 && x[1] >= 1 && x[1] <= 12) {
      out = `${x[0]}-${String(x[1]).padStart(2, '0')}`;
      return;
    }
    for (const v of x) walk(v);
  };
  walk(data);
  return out;
}

function parsePano(text: string, qLat: number, qLng: number): StreetViewPano | null {
  const data = parseJsonp(text);
  if (!data) return null;
  const pano = data?.[1];
  // Preferred stable index paths (panoid at [1][1][1], coords at [1][5][0][1][0][2..3]).
  let panoid: unknown = pano?.[1]?.[1];
  let lat: unknown = pano?.[5]?.[0]?.[1]?.[0]?.[2];
  let lng: unknown = pano?.[5]?.[0]?.[1]?.[0]?.[3];

  if (!isPanoId(panoid)) {
    // Fallback: first pano-id-shaped string anywhere in the tree.
    const stack = [data];
    while (stack.length && !isPanoId(panoid)) {
      const cur = stack.pop();
      if (Array.isArray(cur)) for (const v of cur) { if (isPanoId(v)) { panoid = v; break; } if (Array.isArray(v)) stack.push(v); }
    }
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    const c = closestCoord(data, qLat, qLng);
    if (c) { lat = c.lat; lng = c.lng; }
  }
  if (!isPanoId(panoid) || typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { panoid, lat, lng, date: extractDate(data) };
}

/** Find the nearest Street View panorama to a point (keyless). Null if there's no coverage. */
export async function findPanorama(lat: number, lng: number, radiusM = 50, signal?: AbortSignal): Promise<StreetViewPano | null> {
  try {
    const res = await stealthFetch(searchUrl(lat, lng, radiusM), {
      signal: safeAbortAny([signal, safeAbortTimeout(SEARCH_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const text = await res.text();
    return parsePano(text, lat, lng);
  } catch {
    return null;
  }
}

export interface ThumbOpts {
  yaw: number;
  pitch?: number;
  fov?: number;
  w?: number;
  h?: number;
}

/** Build a keyless Street View still-image URL for a panorama at a given view. */
export function streetViewThumbUrl(panoid: string, opts: ThumbOpts): string {
  const params = new URLSearchParams({
    cb_client: 'maps_sv.tactile',
    w: String(Math.min(1024, Math.max(80, opts.w ?? 640))),
    h: String(Math.min(1024, Math.max(80, opts.h ?? 480))),
    panoid,
    yaw: String(((opts.yaw % 360) + 360) % 360),
    pitch: String(Math.max(-90, Math.min(90, opts.pitch ?? 0))),
    thumbfov: String(Math.max(10, Math.min(120, opts.fov ?? 80))),
  });
  return `${STREETVIEW_THUMB_URL}?${params}`;
}
