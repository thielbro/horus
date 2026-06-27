import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

// BGP/ASN Lookup via bgpview.io (free, no key)
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const bgpCache = new Map<string, { data: any; timestamp: number }>();

function getCachedBgp(key: string) {
  const cached = bgpCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    bgpCache.delete(key);
    return null;
  }
  bgpCache.delete(key);
  bgpCache.set(key, cached);
  return cached.data;
}

function setCachedBgp(key: string, data: any) {
  bgpCache.set(key, { data, timestamp: Date.now() });
  while (bgpCache.size > MAX_CACHE_ENTRIES) {
    const oldest = bgpCache.keys().next().value;
    if (!oldest) break;
    bgpCache.delete(oldest);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('query'); // Can be IP, ASN, or prefix
  if (!query) return NextResponse.json({ error: 'Missing query parameter (IP, ASN number, or prefix)' }, { status: 400 });

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 20, 60_000, 'osint-bgp')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const cacheKey = query.trim().toUpperCase();
    const cached = getCachedBgp(cacheKey);
    if (cached) return NextResponse.json({ ...cached, cached: true });

    const results: any = { query, timestamp: new Date().toISOString() };

    // Detect query type
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(query);
    const isASN = /^(AS)?\d+$/i.test(query);
    const asnNum = isASN ? query.replace(/^AS/i, '') : null;

    if (isIP) {
      // IP → ASN lookup
      const res = await fetch(`https://api.bgpview.io/ip/${query}`, {
        signal: safeAbortTimeout(8000),
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok') {
          results.ip = data.data;
          results.type = 'ip';
        }
      } else {
        await releaseResponseBody(res);
      }
    } else if (asnNum) {
      // ASN details
      const [asnRes, prefixRes, peersRes] = await Promise.allSettled([
        fetch(`https://api.bgpview.io/asn/${asnNum}`, { signal: safeAbortTimeout(8000) }),
        fetch(`https://api.bgpview.io/asn/${asnNum}/prefixes`, { signal: safeAbortTimeout(8000) }),
        fetch(`https://api.bgpview.io/asn/${asnNum}/peers`, { signal: safeAbortTimeout(8000) }),
      ]);

      if (asnRes.status === 'fulfilled') {
        if (asnRes.value.ok) {
          const d = await asnRes.value.json();
          if (d.status === 'ok') results.asn = d.data;
        } else {
          await releaseResponseBody(asnRes.value);
        }
      }
      if (prefixRes.status === 'fulfilled') {
        if (prefixRes.value.ok) {
          const d = await prefixRes.value.json();
          if (d.status === 'ok') {
            results.prefixes = {
              ipv4: (d.data?.ipv4_prefixes || []).slice(0, 20),
              ipv6: (d.data?.ipv6_prefixes || []).slice(0, 10),
              total_v4: d.data?.ipv4_prefixes?.length || 0,
              total_v6: d.data?.ipv6_prefixes?.length || 0,
            };
          }
        } else {
          await releaseResponseBody(prefixRes.value);
        }
      }
      if (peersRes.status === 'fulfilled') {
        if (peersRes.value.ok) {
          const d = await peersRes.value.json();
          if (d.status === 'ok') {
            results.peers = {
              upstream: (d.data?.ipv4_peers || []).slice(0, 10),
              total: d.data?.ipv4_peers?.length || 0,
            };
          }
        } else {
          await releaseResponseBody(peersRes.value);
        }
      }
      results.type = 'asn';
    } else {
      return NextResponse.json({ error: 'Unrecognized query format. Use IP address or AS number.' }, { status: 400 });
    }

    setCachedBgp(cacheKey, results);
    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: 'BGP lookup failed' }, { status: 500 });
  }
}
