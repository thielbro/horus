import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { safeAbortTimeout } from '@/lib/http-utils';

// CVE Intelligence — fetches vulnerability details from CIRCL CVE API (free, no key)
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const cveCache = new Map<string, { data: any; timestamp: number }>();

function getCachedCve(key: string) {
  const cached = cveCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    cveCache.delete(key);
    return null;
  }
  cveCache.delete(key);
  cveCache.set(key, cached);
  return cached.data;
}

function setCachedCve(key: string, data: any) {
  cveCache.set(key, { data, timestamp: Date.now() });
  while (cveCache.size > MAX_CACHE_ENTRIES) {
    const oldest = cveCache.keys().next().value;
    if (!oldest) break;
    cveCache.delete(oldest);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cve = searchParams.get('cve');
  if (!cve) return NextResponse.json({ error: 'Missing cve parameter' }, { status: 400 });

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 30, 60_000, 'osint-cve')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // Validate CVE format (CVE-YYYY-NNNNN)
  if (!/^CVE-\d{4}-\d{4,}$/i.test(cve)) {
    return NextResponse.json({ error: 'Invalid CVE format. Expected: CVE-YYYY-NNNNN' }, { status: 400 });
  }

  const cacheKey = cve.toUpperCase();
  const cached = getCachedCve(cacheKey);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  try {
    const res = await fetch(`https://cveawg.mitre.org/api/cve/${encodeURIComponent(cacheKey)}`, {
      signal: safeAbortTimeout(8000),
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      // Fallback to CIRCL
      try {
        const circlRes = await fetch(`https://cve.circl.lu/api/cve/${encodeURIComponent(cacheKey)}`, {
          signal: safeAbortTimeout(8000),
          headers: { 'Accept': 'application/json' },
        });
        if (circlRes.ok) {
          const data = await circlRes.json();
          const payload = {
            id: data.id || cacheKey,
            description: data.summary || 'No description available.',
            cvss: data.cvss ?? null,
            cvss_vector: data.cvss_vector || null,
            references: (data.references || []).slice(0, 5),
            published: data.Published || null,
            modified: data.Modified || null,
            cwe: data.cwe || null,
            source: 'circl',
          };
          setCachedCve(cacheKey, payload);
          return NextResponse.json(payload);
        }
      } catch { /* fall through */ }

      const payload = {
        id: cacheKey,
        description: 'CVE details could not be retrieved at this time.',
        cvss: null,
        references: [],
        source: 'unavailable',
      };
      setCachedCve(cacheKey, payload);
      return NextResponse.json(payload);
    }

    const data = await res.json();

    // Parse the CVE 5.0 JSON format from MITRE
    const cna = data.containers?.cna;
    const description = cna?.descriptions?.find((d: any) => d.lang === 'en')?.value
      || cna?.descriptions?.[0]?.value
      || 'No description available.';

    // Extract CVSS from metrics
    let cvss: number | null = null;
    let cvss_vector: string | null = null;
    let severity: string | null = null;

    const metrics = cna?.metrics;
    if (metrics) {
      for (const m of metrics) {
        const v31 = m.cvssV3_1 || m.cvssV3_0 || m.cvssV31;
        if (v31) {
          cvss = v31.baseScore ?? null;
          cvss_vector = v31.vectorString ?? null;
          severity = v31.baseSeverity ?? null;
          break;
        }
        const v2 = m.cvssV2_0 || m.cvssV2;
        if (v2) {
          cvss = v2.baseScore ?? null;
          cvss_vector = v2.vectorString ?? null;
          break;
        }
      }
    }

    // Extract CWE
    const problemTypes = cna?.problemTypes;
    let cwe: string | null = null;
    if (problemTypes?.[0]?.descriptions?.[0]) {
      cwe = problemTypes[0].descriptions[0].cweId || problemTypes[0].descriptions[0].description || null;
    }

    // Extract references
    const references = (cna?.references || []).slice(0, 5).map((r: any) => r.url);

    // Extract affected products
    const affected = (cna?.affected || []).slice(0, 5).map((a: any) => ({
      vendor: a.vendor || 'Unknown',
      product: a.product || 'Unknown',
      versions: (a.versions || []).slice(0, 3).map((v: any) => v.version).filter(Boolean),
    }));

    const payload = {
      id: data.cveMetadata?.cveId || cacheKey,
      description,
      cvss,
      cvss_vector,
      severity: severity || (cvss !== null ? (cvss >= 9 ? 'CRITICAL' : cvss >= 7 ? 'HIGH' : cvss >= 4 ? 'MEDIUM' : 'LOW') : null),
      cwe,
      affected,
      references,
      published: data.cveMetadata?.datePublished || null,
      modified: data.cveMetadata?.dateUpdated || null,
      source: 'mitre',
    };
    setCachedCve(cacheKey, payload);
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: 'CVE lookup failed' }, { status: 500 });
  }
}
