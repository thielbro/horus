import { NextResponse } from 'next/server';
import { inflateRawSync } from 'node:zlib';
import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { stealthFetch } from '@/lib/stealthFetch';
import { releaseResponseBody, stableHash } from '@/lib/http-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * HORUS — Real-Time Geopolitical Events (GDELT 2.0 raw events export)
 *
 * The GDELT GEO 2.0 API (api.gdeltproject.org/api/v2/geo/geo) is DEAD — 404 on
 * every query as of 2026-07 — so this route polls the raw 15-minute event export
 * instead: lastupdate.txt names the newest export.CSV.zip (~30-300KB), which
 * carries CAMEO-coded events with real coordinates and source article URLs.
 * Completely free, no auth. We merge the last few windows for map density.
 * (data.gdeltproject.org is HTTP-only — its TLS cert doesn't cover the host.)
 */

const GDELT_BASE = 'http://data.gdeltproject.org/gdeltv2';
const WINDOWS = 4; // 4 × 15 min = last hour of events
const MAX_EVENTS = 800;

// CAMEO event root code → HORUS incident type. Codes outside this map are routine
// diplomatic/media chatter (statements, appeals, intents) and are dropped.
const CAMEO_TYPES: Record<string, string> = {
  '14': 'unrest',    // protest
  '18': 'conflict',  // assault
  '19': 'conflict',  // fight
  '20': 'conflict',  // unconventional mass violence
  '15': 'conflict',  // exhibit force posture
  '17': 'conflict',  // coerce
  '13': 'political', // threaten
  '16': 'political', // reduce relations
  '05': 'diplomacy', // diplomatic cooperation
  '06': 'diplomacy', // material cooperation
};

// GDELT 2.0 export column indices (61 tab-separated columns).
const COL = { rootCode: 28, numArticles: 33, geoName: 52, lat: 56, lng: 57, dateAdded: 59, url: 60 } as const;

async function fetchBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await stealthFetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) {
      await releaseResponseBody(res);
      throw new Error(`GDELT fetch ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

/** GDELT export zips hold exactly one deflate entry — inflate it without a zip dep. */
function unzipSingleEntry(buf: Buffer): Buffer {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a zip archive');
  const method = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (method === 0) return buf.subarray(start, start + compSize);
  // compSize can be 0 when a data descriptor is used; inflateRaw stops at stream end.
  return inflateRawSync(compSize > 0 ? buf.subarray(start, start + compSize) : buf.subarray(start));
}

/** lastupdate.txt → newest export URL, then walk back N 15-minute windows. */
async function resolveExportUrls(): Promise<string[]> {
  const manifest = (await fetchBuffer(`${GDELT_BASE}/lastupdate.txt`)).toString('utf8');
  const match = /(\d{14})\.export\.CSV\.zip/.exec(manifest);
  if (!match) throw new Error('GDELT manifest missing export entry');
  const ts = match[1];
  const base = Date.UTC(
    Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)),
    Number(ts.slice(8, 10)), Number(ts.slice(10, 12)), Number(ts.slice(12, 14)),
  );
  const urls: string[] = [];
  for (let i = 0; i < WINDOWS; i++) {
    const d = new Date(base - i * 15 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    urls.push(`${GDELT_BASE}/${stamp}.export.CSV.zip`);
  }
  return urls;
}

/** Best-effort headline from the article URL slug (GDELT export has no titles). */
function headlineFromUrl(url: string, fallback: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const words = segments[i]
        .replace(/\.(html?|php|aspx?)$/i, '')
        .split(/[-_]+/)
        .filter((w) => w && !/^\d+$/.test(w));
      if (words.length >= 4) {
        const headline = words.join(' ');
        return headline.charAt(0).toUpperCase() + headline.slice(1);
      }
    }
  } catch { /* fall through */ }
  return fallback;
}

function parseDateAdded(raw: string): string {
  if (!/^\d{14}$/.test(raw)) return new Date().toISOString();
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
}

function deterministicOffset(seed: string, spread: number, salt: number): number {
  let hash = salt;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ((hash % 10000) / 10000) * spread - spread / 2;
}

export async function GET(request: Request) {
  const limited = rateLimitOr429(request, 60); if (limited) return limited;
  try {
    const allEvents: any[] = [];
    const byKey = new Map<string, any>();

    let urls: string[] = [];
    try {
      urls = await resolveExportUrls();
    } catch (e) {
      console.warn('[HORUS] GDELT manifest unavailable:', e instanceof Error ? e.message : e);
    }

    const windowResults = await Promise.allSettled(urls.map(async (url) => {
      const tsv = unzipSingleEntry(await fetchBuffer(url)).toString('utf8');
      return tsv.split('\n');
    }));

    for (const result of windowResults) {
      if (result.status !== 'fulfilled') continue;
      for (const line of result.value) {
        const cols = line.split('\t');
        if (cols.length < 61) continue;

        const type = CAMEO_TYPES[cols[COL.rootCode]];
        if (!type) continue;

        const lat = Number(cols[COL.lat]);
        const lng = Number(cols[COL.lng]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;

        const url = cols[COL.url] || '';
        const geoName = cols[COL.geoName] || 'Unknown location';
        const count = Number(cols[COL.numArticles]) || 1;

        // One point per article per half-degree cell — an article naming several
        // places still plots each, but repeat mentions of the same place collapse.
        const key = `${url}:${Math.round(lat * 2) / 2}:${Math.round(lng * 2) / 2}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.count = Math.max(existing.count, count);
          continue;
        }

        const event = {
          id: `gdelt-${cols[0] || stableHash({ url, lat, lng, type })}`,
          lat,
          lng,
          name: headlineFromUrl(url, geoName),
          url,
          html: geoName,
          type,
          count,
          shareimage: '',
          seenAt: parseDateAdded(cols[COL.dateAdded] || ''),
        };
        byKey.set(key, event);
        allEvents.push(event);
      }
    }

    // Densest stories first; cap the payload (page.tsx caps the gdelt bucket at 1000).
    allEvents.sort((a, b) => b.count - a.count);
    let events = allEvents.slice(0, MAX_EVENTS);

    // Fallback if GDELT is unreachable (simulate global incidents for demo purposes)
    if (events.length === 0) {
      const fallback: any[] = [];
      const generateFallback = (type: string, name: string, count: number, latBase: number, lngBase: number, spread: number) => {
        for(let i=0; i<count; i++) {
          const seed = `${type}:${name}:${i}`;
          fallback.push({
            id: `gdelt-fb-${type}-${i}`,
            lat: latBase + deterministicOffset(seed, spread, 17),
            lng: lngBase + deterministicOffset(seed, spread, 53),
            name: `${name} reported in the area.`,
            url: '',
            html: `Local reports indicate ${name.toLowerCase()}.`,
            type: type,
            count: Math.floor(Math.random() * 5) + 1,
            shareimage: '',
            seenAt: new Date().toISOString(),
          });
        }
      };

      // Inject simulated incidents across key regions
      generateFallback('conflict', 'Military strikes', 15, 48.5, 31.2, 5); // Ukraine
      generateFallback('conflict', 'Armed clashes', 10, 31.5, 34.5, 2); // Gaza
      generateFallback('conflict', 'Border shelling', 8, 33.2, 35.5, 1.5); // Lebanon
      generateFallback('unrest', 'Civil unrest', 12, 15.0, 30.0, 10); // Sudan
      generateFallback('conflict', 'Rebel offensive', 8, -1.0, 28.5, 5); // DRC
      generateFallback('political', 'Emergency declared', 5, 24.0, 119.5, 2); // Taiwan
      generateFallback('unrest', 'Widespread protests', 10, 48.8, 2.3, 3); // France
      generateFallback('unrest', 'Violent riots', 6, 40.7, -74.0, 5); // US East
      events = fallback;
    }

    return NextResponse.json({
      events,
      total: events.length,
      timestamp: new Date().toISOString(),
      source: events[0]?.id?.includes('fb') ? 'HORUS Simulated Incident Engine' : 'GDELT 2.0 Events Export',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=900' },
    });
  } catch (error) {
    console.error('[HORUS] GDELT fetch error:', error);
    return NextResponse.json({ events: [], total: 0, error: 'GDELT unavailable' }, { status: 500 });
  }
}
