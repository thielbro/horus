import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

/**
 * HORUS — shared OpenStreetMap / Overpass layer helper.
 *
 * Powers the counter-surveillance point layers (police stations, Flock/ALPR cameras,
 * mass-surveillance tech). Each route supplies its own tag clauses + node→record mapper;
 * this module owns the boilerplate: rate limiting, bbox parsing, the Overpass POST, error
 * shaping, and caching. Positions only — community-sourced, ODbL licensed.
 *
 * Default coverage is continent-scale (the area cap below only constrains a *user-supplied*
 * ?bbox=s,w,n,e). Routes are bbox-overridable, which is the hook the future location/route
 * phase will drive from the live viewport.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_BBOX_AREA_DEGREES = 25;

// Short-lived in-memory cache of merged results, keyed by bucket+query. Panning back to a
// recently viewed viewport returns instantly instead of re-hitting the public Overpass API.
const OVERPASS_CACHE_TTL_MS = 60_000;
const OVERPASS_CACHE_MAX = 200;
const overpassCache = new Map<string, { at: number; items: object[] }>();

function getOverpassCache(key: string): object[] | null {
  const hit = overpassCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > OVERPASS_CACHE_TTL_MS) {
    overpassCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  overpassCache.delete(key);
  overpassCache.set(key, hit);
  return hit.items;
}

function setOverpassCache(key: string, items: object[]): void {
  overpassCache.set(key, { at: Date.now(), items });
  while (overpassCache.size > OVERPASS_CACHE_MAX) {
    const oldest = overpassCache.keys().next().value;
    if (!oldest) break;
    overpassCache.delete(oldest);
  }
}

// [south, west, north, east]
export type BBox = [number, number, number, number];

export interface OverpassNode {
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

export function titleCase(s: string): string {
  return s.replace(/[_:]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseBboxParam(bboxParam: string | null, defaults: BBox[]): { ok: true; boxes: BBox[] } | { ok: false; error: string } {
  if (!bboxParam) return { ok: true, boxes: defaults };

  const parts = bboxParam.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: 'invalid bbox format; expected south,west,north,east' };
  }

  const [s, w, n, e] = parts as BBox;
  if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w >= e) {
    return { ok: false, error: 'invalid bbox coordinates' };
  }

  const area = (n - s) * (e - w);
  if (area > MAX_BBOX_AREA_DEGREES) {
    return { ok: false, error: 'bbox area too large' };
  }

  return { ok: true, boxes: [[s, w, n, e]] };
}

export interface OverpassLayerOptions {
  request: Request;
  /** Output bucket key in the JSON response, e.g. 'police'. */
  bucket: string;
  /** Default boxes when no ?bbox is supplied. */
  defaults: BBox[];
  /** Overpass statement(s) for a single `s,w,n,e` bbox string. */
  clausesFor: (bbox: string) => string;
  /** Map one node to a record; return null to drop it. */
  mapNode: (el: OverpassNode) => Record<string, unknown> | null;
  /** Descriptive UA (Overpass etiquette). */
  userAgent: string;
  /** Requests/minute per client IP (default 30). */
  rateLimit?: number;
  /** Overpass `out body N` cap (default 12000). */
  outCount?: number;
  /**
   * Curated records to add to the response after the OSM results, scoped to the
   * resolved request boxes. Use with a `mapNode` that drops OSM nodes inside the
   * curated coverage so curated data replaces (rather than duplicates) OSM.
   */
  extraRecords?: (boxes: BBox[]) => object[];
}

/** Run an OSM/Overpass point layer and return a NextResponse with `{ [bucket], total, timestamp }`. */
export async function runOverpassLayer(opts: OverpassLayerOptions): Promise<Response> {
  const { request, bucket, defaults, clausesFor, mapNode, userAgent, rateLimit = 30, outCount = 12000, extraRecords } = opts;
  // Curated records for this viewport — hoisted out of the try so the catch can
  // still ship them. Curated coverage must never blank out, even if Overpass is
  // slow, errors, or the request aborts.
  let extra: object[] = [];
  try {
    const clientIp = getClientIp(request);
    if (isRateLimited(clientIp, rateLimit, 60_000)) {
      return NextResponse.json({ [bucket]: [], error: 'Rate limit exceeded' }, { status: 429 });
    }

    const { searchParams } = new URL(request.url);
    const parsed = parseBboxParam(searchParams.get('bbox'), defaults);
    if (!parsed.ok) {
      return NextResponse.json({ [bucket]: [], error: parsed.error }, { status: 400 });
    }

    extra = extraRecords ? extraRecords(parsed.boxes) : [];

    const clauses = parsed.boxes
      .map(([s, w, n, e]) => clausesFor(`${s},${w},${n},${e}`))
      .join('\n  ');
    const query = `[out:json][timeout:30];\n(\n  ${clauses}\n);\nout body ${outCount};`;

    // Serve a fresh-enough cached result for this exact viewport/query if we have one.
    const cacheKey = `${bucket}|${query}`;
    const cachedItems = getOverpassCache(cacheKey);
    if (cachedItems) {
      return NextResponse.json(
        { [bucket]: cachedItems, total: cachedItems.length, timestamp: new Date().toISOString(), cached: true },
        { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } },
      );
    }

    // Plain fetch (not stealthFetch — it hard-aborts at 10s; Overpass needs longer).
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: 'data=' + encodeURIComponent(query),
      signal: safeAbortTimeout(30000),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      // Overpass failed — still serve curated data so covered regions don't blank.
      return NextResponse.json({ [bucket]: extra, total: extra.length, error: `Overpass ${res.status}` }, { status: 200 });
    }

    const data = await res.json();
    const osmItems = (data.elements as OverpassNode[] | undefined || [])
      .filter((el) => typeof el.lat === 'number' && typeof el.lon === 'number')
      .map(mapNode)
      .filter((r): r is Record<string, unknown> => r != null);
    // Curated first so that if any downstream cap (server `out body`, client
    // payload cap) truncates, it sheds OSM rows — never the curated ones.
    const items = [...extra, ...osmItems];
    setOverpassCache(cacheKey, items);

    return NextResponse.json(
      { [bucket]: items, total: items.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } },
    );
  } catch (error) {
    console.error(`Overpass layer (${bucket}) fetch error:`, error);
    // Still serve curated data so covered regions don't blank on a timeout/abort.
    return NextResponse.json({ [bucket]: extra, total: extra.length, error: 'Failed' }, { status: 200 });
  }
}
