import { NextResponse } from 'next/server';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

export const dynamic = 'force-dynamic';

/**
 * HORUS — Vessel photo lookup (Wikimedia Commons)
 *
 * Best-effort, free-license photo for the entity intel vessel card. Commons ship
 * photos are routinely tagged/described with "IMO <number>", which makes the IMO
 * the most reliable key; MMSI and name are progressively weaker fallbacks. This
 * covers notable vessels only — most working commercial traffic has no free
 * photo, and the card falls back to its type glyph.
 */

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; body: any }>();

// Commons search hits that are almost never an actual photo of the ship.
const JUNK_TITLE = /\b(map|logo|flag|diagram|chart|plan|drawing|coat of arms|insignia|emblem)\b/i;

function stripHtml(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  const text = s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function normalizeForMatch(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function searchCommons(query: string, mustContain?: string): Promise<any | null> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '640',
  });
  const res = await fetch(`${COMMONS_API}?${params}`, {
    signal: safeAbortTimeout(8000),
    cache: 'no-store',
    headers: { 'User-Agent': 'HORUS/1.0 (vessel photo lookup)', Accept: 'application/json' },
  });
  if (!res.ok) {
    await releaseResponseBody(res);
    return null;
  }
  const json = await res.json().catch(() => null);
  const pages = json?.query?.pages;
  if (!pages || typeof pages !== 'object') return null;
  const candidates = Object.values(pages as Record<string, any>)
    .filter((p) => p?.imageinfo?.[0]?.thumburl && !JUNK_TITLE.test(p?.title || ''))
    // Fuzzy searches (bare vessel name) return plausible-but-wrong ships; a wrong
    // photo is worse than none, so the file title must contain the name itself.
    .filter((p) => !mustContain || normalizeForMatch(p?.title || '').includes(normalizeForMatch(mustContain)))
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  const hit = candidates[0];
  if (!hit) return null;
  const info = hit.imageinfo[0];
  const meta = info.extmetadata || {};
  return {
    url: info.thumburl,
    pageUrl: info.descriptionurl || null,
    credit: stripHtml(meta.Artist?.value),
    license: stripHtml(meta.LicenseShortName?.value),
  };
}

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 30);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const imo = params.get('imo')?.replace(/\D/g, '') || '';
  const mmsi = params.get('mmsi')?.replace(/\D/g, '') || '';
  const name = params.get('name')?.trim().slice(0, 80) || '';
  if (!imo && !mmsi && name.length < 4) {
    return NextResponse.json({ photo: null, matchedBy: null, error: 'imo, mmsi or name required' }, { status: 400 });
  }

  const cacheKey = `${imo}|${mmsi}|${name.toUpperCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.body, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Ordered by identifier strength; a wrong-ship photo is worse than no photo,
  // so the bare-name query is qualified with "ship" and tried last.
  const attempts: Array<[string, string, string?]> = [];
  if (imo) attempts.push(['imo', `"IMO ${imo}"`]);
  if (mmsi) attempts.push(['mmsi', `"MMSI ${mmsi}"`]);
  if (name.length >= 4) attempts.push(['name', `"${name}" ship`, name]);

  let body: any = { photo: null, matchedBy: null };
  try {
    for (const [matchedBy, query, mustContain] of attempts) {
      const photo = await searchCommons(query, mustContain);
      if (photo) {
        body = { photo, matchedBy, source: 'wikimedia-commons' };
        break;
      }
    }
  } catch (error) {
    console.warn('[HORUS] Vessel photo lookup failed:', error instanceof Error ? error.message : error);
    // Serve the miss without caching so a transient failure can retry later.
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  }

  cache.set(cacheKey, { at: Date.now(), body });
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first == null) break;
    cache.delete(first);
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
