
import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { stealthFetch } from '@/lib/stealthFetch';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

/**
 * HORUS — Flight Data API
 *
 * Primary source: OpenSky Network `/api/states/all` — a single-request GLOBAL snapshot
 * (~8–12k aircraft worldwide) that reliably returns in a few seconds. This replaces the old
 * 6×`dist=2000` adsb.lol fan-out, whose oversized payloads took 30s+ and timed out at 12s,
 * leaving the map empty "half the time" and never truly global.
 *
 * Fallback: adsb.fi point queries (capped at 250nm, fast) when OpenSky is unavailable or
 * rate-limited. Anonymous OpenSky is throttled per day, so we cache + coalesce aggressively
 * and use OAuth2 client credentials when OPENSKY_CLIENT_ID/SECRET are configured.
 *
 * Rich per-aircraft detail (type, registration, route, owner) is resolved on click via
 * /api/entity/expand (adsbdb.com) — not for every aircraft here.
 */

export const maxDuration = 30;

const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_TIMEOUT_MS = 20_000;
const MAX_TOTAL_FLIGHTS = 12_000;

// Fallback adsb.fi point queries (dist capped at 250nm by the API → fast, reliable).
const FALLBACK_REGIONS = [
  { lat: 39.8, lon: -98.5 },   // North America
  { lat: 50.0, lon: 15.0 },    // Europe
  { lat: 35.0, lon: 105.0 },   // Asia
  { lat: -25.0, lon: 133.0 },  // Australia
  { lat: 0.0, lon: 20.0 },     // Africa
  { lat: -15.0, lon: -60.0 },  // South America
];
const FALLBACK_DIST = 250;
const FALLBACK_TIMEOUT_MS = 12_000;

// ── Classification ──────────────────────────────────────────────────────────────
// OpenSky /states/all carries no aircraft type or dbFlags, so buckets are derived from the
// callsign and the ICAO24 hex. Military-callsign prefixes + the US military hex block catch
// most military traffic; airline-style callsigns (3 letters + digit) are commercial; the rest
// is general aviation. "Private jets" can't be split from GA on positions alone, so that bucket
// stays empty here and is identified on click via adsbdb.
const AIRLINE_CODE_RE = /^([A-Z]{3})\d/;
const MIL_CALLSIGN_RE =
  /^(RCH|RRR|CFC|ASCOT|NATO|BAF|EGY|KING|DUKE|EVAC|JAKE|REACH|CONVOY|SENTRY|GRZLY|HOBO|SLAM|VADER|NOBLE|OMEN|PYTHON|BLKCT|SPAR|POLO|GORDO)\d*/i;

// US military ICAO24 allocation block (0xAE0000–0xAFFFFF). A heuristic, not exhaustive, but a
// strong signal for US military aircraft that don't fly under a recognisable callsign.
function isMilitaryHex(hex: string): boolean {
  const n = parseInt(hex, 16);
  return Number.isFinite(n) && n >= 0xae0000 && n <= 0xafffff;
}

interface Flight {
  callsign: string;
  lat: number;
  lng: number;
  alt: number;
  heading: number;
  speed_knots: number | null;
  model: string;
  icao24: string;
  registration: string;
  squawk: string;
  airline_code: string;
  aircraft_category: 'plane' | 'heli';
  category: 'commercial' | 'private' | 'jet' | 'military';
  grounded: boolean;
  origin_country?: string;
  type: 'flight';
}

const round5 = (n: number) => Math.round(n * 100000) / 100000;

// Map one OpenSky state vector (array form) into a HORUS flight.
// Indices: 0 icao24, 1 callsign, 2 origin_country, 5 lon, 6 lat, 7 baro_alt(m),
//          8 on_ground, 9 velocity(m/s), 10 true_track(deg), 13 geo_alt(m).
function classifyOpenSky(s: unknown[]): Flight | null {
  const icao24 = String(s[0] ?? '').trim().toLowerCase();
  const callsignRaw = String(s[1] ?? '').trim().toUpperCase();
  const lon = s[5];
  const lat = s[6];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const onGround = Boolean(s[8]);
  const velocityMs = typeof s[9] === 'number' ? s[9] : null;
  const track = typeof s[10] === 'number' ? s[10] : 0;
  const baroAlt = typeof s[7] === 'number' ? s[7] : typeof s[13] === 'number' ? s[13] : 0;

  const callsign = callsignRaw || icao24 || 'UNKNOWN';
  const airlineMatch = AIRLINE_CODE_RE.exec(callsign);
  const airlineCode = airlineMatch ? airlineMatch[1] : '';

  let category: Flight['category'];
  if (isMilitaryHex(icao24) || MIL_CALLSIGN_RE.test(callsign)) category = 'military';
  else if (airlineCode) category = 'commercial';
  else category = 'private';

  return {
    callsign,
    lat: round5(lat),
    lng: round5(lon),
    alt: Math.round(baroAlt),
    heading: Math.round(track),
    speed_knots: velocityMs != null ? Math.round(velocityMs * 1.94384 * 10) / 10 : null,
    model: 'Unknown',
    icao24,
    registration: 'N/A',
    squawk: typeof s[14] === 'string' ? s[14] : '',
    airline_code: airlineCode,
    aircraft_category: 'plane',
    category,
    grounded: onGround,
    origin_country: typeof s[2] === 'string' ? s[2] : '',
    type: 'flight',
  };
}

interface FlightPayload {
  commercial_flights: Flight[];
  private_flights: Flight[];
  private_jets: Flight[];
  military_flights: Flight[];
  gps_jamming: unknown[];
  total: number;
  returned_total: number;
  source: string;
  timestamp: string;
}

function bucketAndCap(flights: Flight[], source: string, rawTotal: number): FlightPayload {
  const commercial: Flight[] = [];
  const privateFl: Flight[] = [];
  const jets: Flight[] = [];
  const military: Flight[] = [];
  for (const f of flights) {
    switch (f.category) {
      case 'military': military.push(f); break;
      case 'jet': jets.push(f); break;
      case 'private': privateFl.push(f); break;
      default: commercial.push(f);
    }
  }

  let remaining = MAX_TOTAL_FLIGHTS;
  const take = (arr: Flight[]) => {
    const out = arr.slice(0, Math.max(0, remaining));
    remaining -= out.length;
    return out;
  };
  const militaryFlights = take(military);
  const privateJets = take(jets);
  const privateFlights = take(privateFl);
  const commercialFlights = take(commercial);

  return {
    commercial_flights: commercialFlights,
    private_flights: privateFlights,
    private_jets: privateJets,
    military_flights: militaryFlights,
    gps_jamming: [],
    total: rawTotal,
    returned_total:
      militaryFlights.length + privateJets.length + privateFlights.length + commercialFlights.length,
    source,
    timestamp: new Date().toISOString(),
  };
}

// ── OpenSky OAuth2 (optional — raises rate limits when creds are configured) ──
let osToken: { value: string; exp: number } | null = null;
async function getOpenSkyToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  if (osToken && Date.now() < osToken.exp - 30_000) return osToken.value;
  try {
    const res = await fetch(OPENSKY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: safeAbortTimeout(8000),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    if (typeof data?.access_token !== 'string') return null;
    osToken = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 300) * 1000 };
    return osToken.value;
  } catch {
    return null;
  }
}

async function fetchFromOpenSky(): Promise<FlightPayload | null> {
  const token = await getOpenSkyToken();
  // NOTE: plain fetch (not stealthFetch) — stealthFetch hard-aborts at 10s, but the global
  // OpenSky snapshot can take up to ~12s. We set our own longer timeout here.
  const headers: Record<string, string> = {
    'User-Agent': 'HORUS-map/1.0 (flight tracking)',
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(OPENSKY_STATES_URL, {
    headers,
    signal: safeAbortTimeout(OPENSKY_TIMEOUT_MS),
  });
  if (!res.ok) {
    await releaseResponseBody(res);
    return null;
  }
  const data = await res.json();
  const states: unknown[] = Array.isArray(data?.states) ? data.states : [];
  if (states.length === 0) return null;

  const flights: Flight[] = [];
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const f = classifyOpenSky(s);
    if (f) flights.push(f);
  }
  if (flights.length === 0) return null;
  return bucketAndCap(flights, 'opensky', states.length);
}

// ── Fallback: adsb.fi point queries (dist capped at 250nm → fast). Degraded coverage
// (six regional clusters) but keeps the layer alive when OpenSky is down/limited. ──
async function fetchFallbackRegion(region: { lat: number; lon: number }): Promise<any[]> {
  try {
    const url = `https://opendata.adsb.fi/api/v2/lat/${region.lat}/lon/${region.lon}/dist/${FALLBACK_DIST}`;
    const res = await stealthFetch(url, { signal: safeAbortTimeout(FALLBACK_TIMEOUT_MS) });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data?.ac) ? data.ac : [];
    }
    await releaseResponseBody(res);
  } catch {
    /* silent — one region failing must not blank the layer */
  }
  return [];
}

function classifyAdsb(f: any): Flight | null {
  const lat = f.lat;
  const lon = f.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const modelUpper = (f.t || '').toUpperCase();
  if (modelUpper === 'TWR') return null;
  const callsign = (f.flight || '').trim().toUpperCase() || f.hex || 'UNKNOWN';
  const altRaw = f.alt_baro;
  const altMeters = typeof altRaw === 'number' ? altRaw * 0.3048 : 0;
  const airlineMatch = AIRLINE_CODE_RE.exec(callsign);
  const airlineCode = airlineMatch ? airlineMatch[1] : '';
  const dbFlags = f.dbFlags || 0;

  let category: Flight['category'] = 'commercial';
  if (dbFlags & 1 || isMilitaryHex((f.hex || '').toLowerCase()) || MIL_CALLSIGN_RE.test(callsign)) {
    category = 'military';
  } else if (!airlineCode) {
    category = 'private';
  }

  return {
    callsign,
    lat: round5(lat),
    lng: round5(lon),
    alt: Math.round(altMeters),
    heading: Math.round(f.track || 0),
    speed_knots: typeof f.gs === 'number' ? Math.round(f.gs * 10) / 10 : null,
    model: f.t || 'Unknown',
    icao24: (f.hex || '').toLowerCase(),
    registration: f.r || 'N/A',
    squawk: f.squawk || '',
    airline_code: airlineCode,
    aircraft_category: 'plane',
    category,
    grounded: typeof altRaw === 'number' && altRaw < 100,
    type: 'flight',
  };
}

async function fetchFromAdsbFallback(): Promise<FlightPayload | null> {
  const results = await Promise.allSettled(FALLBACK_REGIONS.map(fetchFallbackRegion));
  const seen = new Set<string>();
  const flights: Flight[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const ac of r.value) {
      const hex = (ac.hex || '').toLowerCase().trim();
      if (hex && seen.has(hex)) continue;
      if (hex) seen.add(hex);
      const f = classifyAdsb(ac);
      if (f) flights.push(f);
    }
  }
  if (flights.length === 0) return null;
  return bucketAndCap(flights, 'adsb.fi', flights.length);
}

// ── In-memory cache + request coalescing (per-isolate; protects the upstream from bursts) ──
let cachedData: FlightPayload | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 30_000;
let fetchPromise: Promise<FlightPayload | null> | null = null;

async function loadFlights(): Promise<FlightPayload | null> {
  const viaOpenSky = await fetchFromOpenSky().catch(() => null);
  if (viaOpenSky) return viaOpenSky;
  return fetchFromAdsbFallback().catch(() => null);
}

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 60);
  if (limited) return limited;
  const now = Date.now();

  if (cachedData && now - lastFetchTime < CACHE_TTL) {
    return NextResponse.json(cachedData, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  if (fetchPromise) {
    const data = await fetchPromise.catch(() => null);
    if (data) {
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }
    if (cachedData) return NextResponse.json(cachedData);
    return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 502 });
  }

  fetchPromise = loadFlights();
  try {
    const data = await fetchPromise;
    if (data) {
      cachedData = data;
      lastFetchTime = Date.now();
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }
    // Both sources failed — serve stale if we have it, otherwise error.
    if (cachedData) {
      return NextResponse.json(cachedData, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 502 });
  } catch (error) {
    console.error('Flight fetch error:', error);
    if (cachedData) return NextResponse.json(cachedData, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 500 });
  } finally {
    fetchPromise = null;
  }
}
