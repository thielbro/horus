import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout, safeAbortAny } from '@/lib/http-utils';

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

// Public Overpass mirrors, tried in order. The primary (.de) is the most complete but also
// the most heavily loaded; the others are healthy community mirrors we fall back to on
// 429/5xx/timeout so a throttled primary doesn't blank the map.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const MAX_BBOX_AREA_DEGREES = 25;
// Per-attempt upstream timeout. Viewport queries return in 1–3s; this is the ceiling before
// we give up on one mirror and try the next.
const OVERPASS_FETCH_TIMEOUT_MS = 22_000;

// In-memory cache of merged results, keyed by bucket+query. Panning back to a recently viewed
// viewport returns instantly instead of re-hitting Overpass. Bumped to 5 min so a user
// working a small area (the common case) almost never re-queries.
const OVERPASS_CACHE_TTL_MS = 5 * 60_000;
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

// Stale read used only as an error fallback: returns the last-known items for this query
// even past the TTL, so a transient Overpass failure shows slightly-old markers instead of
// wiping the layer to empty.
function getOverpassCacheStale(key: string): object[] | null {
  return overpassCache.get(key)?.items ?? null;
}

function setOverpassCache(key: string, items: object[]): void {
  overpassCache.set(key, { at: Date.now(), items });
  while (overpassCache.size > OVERPASS_CACHE_MAX) {
    const oldest = overpassCache.keys().next().value;
    if (!oldest) break;
    overpassCache.delete(oldest);
  }
}

// ── Global upstream concurrency gate ──
// Overpass allows ~2 concurrent queries per IP. The client fires up to 4 layers at once on a
// viewport change, which would self-throttle. This gate caps concurrent upstream requests
// across ALL layers; excess requests queue and run as slots free, so nothing 429s itself.
const MAX_CONCURRENT_OVERPASS = 2;
let activeOverpass = 0;
type Waiter = { resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
const overpassWaiters: Waiter[] = [];

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function pumpOverpass(): void {
  while (activeOverpass < MAX_CONCURRENT_OVERPASS && overpassWaiters.length) {
    const w = overpassWaiters.shift()!;
    if (w.onAbort && w.signal) w.signal.removeEventListener('abort', w.onAbort);
    if (w.signal?.aborted) { w.reject(abortError()); continue; }
    activeOverpass++;
    w.resolve();
  }
}

function acquireOverpassSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (activeOverpass < MAX_CONCURRENT_OVERPASS) { activeOverpass++; return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, signal };
    if (signal) {
      w.onAbort = () => {
        const i = overpassWaiters.indexOf(w);
        if (i >= 0) overpassWaiters.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', w.onAbort, { once: true });
    }
    overpassWaiters.push(w);
  });
}

function releaseOverpassSlot(): void {
  activeOverpass = Math.max(0, activeOverpass - 1);
  pumpOverpass();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST an Overpass query through the concurrency gate, rotating mirrors with backoff. Resolves
 * with the first OK Response; throws if every mirror fails (or the caller aborts). The gate is
 * held for the whole mirror-rotation so a queued layer doesn't jump ahead of an in-flight one.
 */
async function fetchOverpassResilient(query: string, userAgent: string, signal?: AbortSignal): Promise<Response> {
  const body = 'data=' + encodeURIComponent(query);
  await acquireOverpassSlot(signal);
  try {
    let lastErr: unknown;
    for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
      try {
        const res = await fetch(OVERPASS_MIRRORS[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
          body,
          signal: safeAbortAny([signal, safeAbortTimeout(OVERPASS_FETCH_TIMEOUT_MS)]),
        });
        if (res.ok) return res;
        await releaseResponseBody(res);
        lastErr = new Error(`Overpass ${res.status}`);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
      }
      // Brief backoff before the next mirror (skip after the last attempt).
      if (i < OVERPASS_MIRRORS.length - 1) await delay(250 * (i + 1), signal);
    }
    throw lastErr ?? new Error('Overpass: all mirrors failed');
  } finally {
    releaseOverpassSlot();
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
    if (isRateLimited(clientIp, rateLimit, 60_000, `overpass:${bucket}`)) {
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

    // Resilient upstream fetch: concurrency-gated, with mirror rotation + backoff.
    let res: Response;
    try {
      res = await fetchOverpassResilient(query, userAgent, request.signal);
    } catch (err) {
      if (request.signal?.aborted) throw err;
      // Every mirror failed — serve the last-known markers for this view (even if stale) so
      // the layer doesn't blank, falling back to curated-only if we've never cached it.
      const stale = getOverpassCacheStale(cacheKey);
      const fallback = stale ?? extra;
      return NextResponse.json({ [bucket]: fallback, total: fallback.length, error: 'Overpass unavailable', stale: !!stale }, { status: 200 });
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
