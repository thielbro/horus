import { NextResponse } from 'next/server';
import { safeFetch, getClientIp, isRateLimited } from '@/lib/ssrf-guard';

/**
 * OSIRIS — Source Tester
 *
 * Backs the "Test source" button in the Surveillance panel. Fetches a user-supplied feed URL
 * server-side (so there's no browser CORS wall) behind the SSRF guard, then reports whether it
 * responded, what it returned, and — for JSON — how many records were found and their field
 * names. That last part is the practical guide for wiring a custom source: it tells the user
 * which properties to map to lat/lng/label.
 *
 * GET /api/source-test?url=<encoded>&jsonPath=<dot.path>
 */

function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/** Find the first array in the payload (root, then one/two levels deep) — a best-effort hint. */
function findFirstArray(obj: any): { arr: any[]; at: string } | null {
  if (Array.isArray(obj)) return { arr: obj, at: '(root)' };
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) return { arr: v, at: k };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(v2)) return { arr: v2, at: `${k}.${k2}` };
      }
    }
  }
  return null;
}

export async function GET(request: Request) {
  const clientIp = getClientIp(request);
  if (isRateLimited(clientIp, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const url = (searchParams.get('url') || '').trim();
  const jsonPath = searchParams.get('jsonPath') || undefined;
  if (!url) {
    return NextResponse.json({ ok: false, error: 'Missing url parameter' }, { status: 400 });
  }

  // Resolve same-origin / relative URLs against the request origin so users can test
  // builtin feeds (e.g. /api/cctv?continent=oceania) too.
  const reqUrl = new URL(request.url);
  let target: URL;
  try {
    target = new URL(url, request.url);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid URL' }, { status: 200 });
  }
  const sameOrigin = target.origin === reqUrl.origin;

  let res: Response;
  try {
    const init = {
      headers: { 'User-Agent': 'OSIRIS-map/1.0 (source tester)' },
      signal: AbortSignal.timeout(12000),
    };
    // Same-origin builtin endpoints are our own APIs — fetch them directly. Only external
    // user URLs go through the SSRF guard (which blocks private/loopback/metadata targets).
    res = sameOrigin ? await fetch(target, init) : await safeFetch(target.toString(), init);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Request failed' },
      { status: 200 },
    );
  }

  const contentType = res.headers.get('content-type') || '';
  const base = { ok: res.ok, status: res.status, statusText: res.statusText, contentType };

  // Only attempt structured parsing for JSON-ish responses.
  let body: any = null;
  let parseError: string | null = null;
  try {
    const text = await res.text();
    if (text.length > 8_000_000) {
      return NextResponse.json({ ...base, count: null, message: 'Response too large to parse (>8MB)' }, { status: 200 });
    }
    try {
      body = JSON.parse(text);
    } catch {
      parseError = 'Response is not valid JSON';
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : 'Could not read response body';
  }

  if (body == null) {
    return NextResponse.json({ ...base, count: null, message: parseError ?? 'Empty response' }, { status: 200 });
  }

  // Locate the records array — explicit jsonPath if given, else best-effort discovery.
  let arr: any[] | null = null;
  let arrayPath: string | null = null;
  if (jsonPath) {
    const resolved = getPath(body, jsonPath);
    if (Array.isArray(resolved)) { arr = resolved; arrayPath = jsonPath; }
  } else {
    const found = findFirstArray(body);
    if (found) { arr = found.arr; arrayPath = found.at; }
  }

  const sample = arr && arr.length ? arr[0] : Array.isArray(body) ? null : body;
  const sampleKeys = sample && typeof sample === 'object' && !Array.isArray(sample) ? Object.keys(sample).slice(0, 40) : null;
  let samplePreview: string | null = null;
  try {
    samplePreview = sample != null ? JSON.stringify(sample).slice(0, 1500) : null;
  } catch { samplePreview = null; }

  return NextResponse.json(
    {
      ...base,
      count: arr ? arr.length : null,
      arrayPath,
      sampleKeys,
      samplePreview,
      message: arr ? null : 'No array of records found — set a JSON path to the records array.',
    },
    { status: 200 },
  );
}
