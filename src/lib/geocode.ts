// Server-side geocoding via Nominatim (OpenStreetMap). Forward (address → coords + details)
// and reverse (coords → address). Reused by the address provider and later phases (location
// tracking, routing). Nominatim is a fixed public endpoint (plain fetch + descriptive UA per
// their usage policy), not a user-supplied URL — so no SSRF guard is needed here.

import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const UA = 'HORUS-map/1.0 (address intel; OpenStreetMap/Nominatim)';
const GEOCODE_TIMEOUT_MS = 10_000;

// Bounded TTL cache — addresses/places rarely change minute-to-minute, and repeated lookups
// (e.g. the same dossier opened twice, a viewport revisited) shouldn't re-hit Nominatim, which
// rate-limits aggressively. Negative results are cached too, to avoid hammering on misses.
const GEO_CACHE_TTL_MS = 10 * 60_000;
const GEO_CACHE_MAX = 500;
const geoCache = new Map<string, { at: number; value: GeoResult | null }>();

function geoCacheGet(key: string): { value: GeoResult | null } | null {
  const hit = geoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GEO_CACHE_TTL_MS) { geoCache.delete(key); return null; }
  geoCache.delete(key); geoCache.set(key, hit); // refresh LRU
  return { value: hit.value };
}

function geoCacheSet(key: string, value: GeoResult | null): void {
  geoCache.set(key, { at: Date.now(), value });
  while (geoCache.size > GEO_CACHE_MAX) {
    const oldest = geoCache.keys().next().value;
    if (!oldest) break;
    geoCache.delete(oldest);
  }
}

export interface GeoAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

export interface GeoResult {
  lat: number;
  lng: number;
  displayName: string;
  /** Building/POI name if Nominatim attached one (shop/office/amenity). */
  name?: string;
  /** OSM class/type, e.g. place/house, shop/*, office/*, amenity/* — used to classify business vs residential. */
  category?: string;
  osmType?: string;
  osmId?: number;
  address: GeoAddress;
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  return safeAbortAny([signal, safeAbortTimeout(GEOCODE_TIMEOUT_MS)]);
}

function mapResult(d: Record<string, any>): GeoResult | null {
  const lat = parseFloat(d?.lat);
  const lng = parseFloat(d?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    displayName: d.display_name || '',
    name: d.name || d.namedetails?.name || undefined,
    category: d.class && d.type ? `${d.class}/${d.type}` : d.category || undefined,
    osmType: d.osm_type,
    osmId: typeof d.osm_id === 'number' ? d.osm_id : undefined,
    address: (d.address || {}) as GeoAddress,
  };
}

/** Forward geocode a free-text address/place to a single best match. */
export async function geocode(query: string, signal?: AbortSignal): Promise<GeoResult | null> {
  const q = query.trim();
  if (!q) return null;
  const cacheKey = `f:${q.toLowerCase()}`;
  const cached = geoCacheGet(cacheKey);
  if (cached) return cached.value;
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&namedetails=1&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: timeoutSignal(signal) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    const result = first ? mapResult(first) : null;
    geoCacheSet(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/** Reverse geocode coordinates to address details. */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<GeoResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // ~5 decimals ≈ 1m — fine enough to dedupe repeated reverse lookups of the same spot.
  const cacheKey = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = geoCacheGet(cacheKey);
  if (cached) return cached.value;
  const url = `${NOMINATIM}/reverse?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&namedetails=1&zoom=18`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: timeoutSignal(signal) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    const result = data && !data.error ? mapResult(data) : null;
    geoCacheSet(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

/** Compose a short, human "house_number road, city postcode" label from address parts. */
export function formatAddress(g: GeoResult): string {
  const a = g.address;
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
  const place = a.city || a.town || a.village || a.suburb || a.county;
  const parts = [line1 || g.name, place, a.postcode, a.country].filter(Boolean);
  return parts.join(', ') || g.displayName;
}
