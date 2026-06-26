// Server-side routing via OSRM. Shared by the /api/route proxy and the route intel provider.
//
// ROUTING_URL is a user-configured service (self-hosted OSRM in prod; the public OSRM demo by
// default for dev) — a fixed, trusted endpoint, not an LLM-supplied URL, so plain fetch is used
// (mirrors how geocode.ts / the address provider call Nominatim / Overpass directly).

import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';

const DEFAULT_ROUTING_URL = 'https://router.project-osrm.org';
const UA = 'HORUS-map/1.0 (route exposure; OpenStreetMap/OSRM)';
const ROUTE_TIMEOUT_MS = 15_000;

// Bounded TTL cache keyed by rounded start/end — the same A→B route requested repeatedly
// (route preview re-renders, the intel provider re-running) shouldn't re-hit OSRM each time.
const ROUTE_CACHE_TTL_MS = 5 * 60_000;
const ROUTE_CACHE_MAX = 300;
const routeCache = new Map<string, { at: number; value: RouteResult | null }>();

function routeCacheGet(key: string): { value: RouteResult | null } | null {
  const hit = routeCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ROUTE_CACHE_TTL_MS) { routeCache.delete(key); return null; }
  routeCache.delete(key); routeCache.set(key, hit); // refresh LRU
  return { value: hit.value };
}

function routeCacheSet(key: string, value: RouteResult | null): void {
  routeCache.set(key, { at: Date.now(), value });
  while (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (!oldest) break;
    routeCache.delete(oldest);
  }
}

export interface RoutePoint {
  lat: number;
  lng: number;
}

export interface RouteResult {
  /** Polyline as GeoJSON [lng,lat] pairs. */
  coordinates: Array<[number, number]>;
  /** Total route length in metres. */
  distance: number;
  /** Estimated travel time in seconds. */
  duration: number;
}

/** Configured OSRM base URL (no trailing slash), falling back to the public demo server. */
export function routingBaseUrl(): string {
  const url = process.env.ROUTING_URL?.trim();
  return url ? url.replace(/\/+$/, '') : DEFAULT_ROUTING_URL;
}

function validPoint(p: RoutePoint | null | undefined): p is RoutePoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}

/**
 * Driving route between two points. Returns the full-geometry polyline plus distance/duration,
 * or null when routing is unavailable / the points are unroutable.
 */
export async function routeBetween(start: RoutePoint, end: RoutePoint, signal?: AbortSignal): Promise<RouteResult | null> {
  if (!validPoint(start) || !validPoint(end)) return null;
  const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`;
  // ~5 decimals ≈ 1m — enough to dedupe repeats without conflating distinct endpoints.
  const cacheKey = `${start.lat.toFixed(5)},${start.lng.toFixed(5)};${end.lat.toFixed(5)},${end.lng.toFixed(5)}`;
  const cached = routeCacheGet(cacheKey);
  if (cached) return cached.value;
  const url = `${routingBaseUrl()}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: safeAbortAny([signal, safeAbortTimeout(ROUTE_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    if (data?.code && data.code !== 'Ok') return null;
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    const raw = route?.geometry?.coordinates;
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const coordinates = raw
      .filter((c: unknown): c is [number, number] => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map((c: [number, number]): [number, number] => [c[0], c[1]]);
    if (coordinates.length < 2) return null;
    const result: RouteResult = {
      coordinates,
      distance: Number.isFinite(route.distance) ? route.distance : 0,
      duration: Number.isFinite(route.duration) ? route.duration : 0,
    };
    routeCacheSet(cacheKey, result);
    return result;
  } catch {
    // Don't cache transient network/abort errors — only definitive results above.
    return null;
  }
}
