import { NextResponse } from 'next/server';
import { resolve4 } from 'node:dns/promises';
import { safeAbortTimeout, stableHash } from '@/lib/http-utils';
import { COUNTRY_CENTROIDS, countryCentroid } from '@/lib/geo-centroids';
import type { RansomwarePost } from './types';

export const dynamic = 'force-dynamic';

/**
 * HORUS — Ransomware Leak-Site Feed (RansomLook)
 *
 * Source: https://www.ransomlook.io/api/recent — free, no auth. Each post carries a group,
 * victim, sector, timestamp and leak link, but NO geography. Victims that are domains are
 * geolocated best-effort by their server IP: DNS-resolve → ip-api.com batch → lat/lng. Victims
 * that are plain company names get no marker (the panel still lists them). ccTLD → country
 * centroid is the fallback when DNS / ip-api can't place a domain.
 */

const RANSOMLOOK_BASE = 'https://www.ransomlook.io';
const MAX_POSTS = 200;
const MAX_DOMAINS_RESOLVED = 120; // bound DNS work per refresh
const MAX_GEO_IPS = 100;          // ip-api.com free-tier batch cap
const DNS_TIMEOUT_MS = 2500;

// ── helpers ──────────────────────────────────────────────────────────────────

/** RansomLook timestamps look like "2026-06-29 20:58:06.305234" (UTC). → ISO-8601. */
function toIso(raw: string): string {
  if (!raw) return new Date(0).toISOString();
  const t = raw.trim().replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1');
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** Collapse a name to a dedupe key (case/space/punctuation-insensitive). */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Extract a hostname from a victim title, or null if it isn't a domain. */
function extractDomain(title: string): string | null {
  if (!title) return null;
  let t = title.trim().toLowerCase();
  if (/\s/.test(t)) return null; // company names have spaces; domains don't
  t = t.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(t)) return null;
  const tld = t.split('.').pop() || '';
  if (!/^[a-z]{2,24}$/.test(tld)) return null; // alphabetic TLD ⇒ excludes bare IPs
  return t;
}

const CCTLD_OVERRIDES: Record<string, string> = { uk: 'GB' };
/** Map a domain's country-code TLD to an ISO code we have a centroid for, else null. */
function ccTldToIso(domain: string): string | null {
  const tld = domain.split('.').pop()?.toUpperCase() || '';
  const iso = CCTLD_OVERRIDES[tld.toLowerCase()] || tld;
  return iso.length === 2 && COUNTRY_CENTROIDS[iso] ? iso : null;
}

function isPublicIp(ip: string): boolean {
  const m = ip.split('.').map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = m;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** Stable numeric seed from a post id (drives deterministic centroid jitter). */
const seedOf = (id: string) => [...id].reduce((acc, c) => acc + c.charCodeAt(0), 0);

async function resolveIp(domain: string, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      resolve4(domain),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dns-timeout')), ms); }),
    ]);
    return Array.isArray(addrs) && addrs.length ? addrs[0] : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface GeoHit { lat: number; lng: number; country?: string; city?: string }

/** Mutates posts in place, attaching lat/lng/country/city to domain victims we can place. */
async function geolocateByIp(posts: RansomwarePost[]): Promise<void> {
  const domainByPost = new Map<RansomwarePost, string>();
  const domains = new Set<string>();
  for (const p of posts) {
    const d = extractDomain(p.victim);
    if (d) { domainByPost.set(p, d); domains.add(d); }
  }
  if (domains.size === 0) return;

  // DNS-resolve (bounded, fault-tolerant) → ip per domain.
  const list = [...domains].slice(0, MAX_DOMAINS_RESOLVED);
  const settled = await Promise.allSettled(
    list.map(async (d) => [d, await resolveIp(d, DNS_TIMEOUT_MS)] as const),
  );
  const ipByDomain = new Map<string, string>();
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value[1] && isPublicIp(r.value[1])) ipByDomain.set(r.value[0], r.value[1]);
  }

  // Unique public IPs, capped for the single ip-api batch.
  const ips: string[] = [];
  const seenIp = new Set<string>();
  for (const ip of ipByDomain.values()) {
    if (!seenIp.has(ip)) { seenIp.add(ip); ips.push(ip); }
    if (ips.length >= MAX_GEO_IPS) break;
  }

  const geoByIp = new Map<string, GeoHit>();
  if (ips.length) {
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,countryCode,city,lat,lon,query', {
        method: 'POST',
        body: JSON.stringify(ips),
        headers: { 'Content-Type': 'application/json' },
        signal: safeAbortTimeout(10000),
      });
      if (res.ok) {
        const arr = await res.json();
        for (const g of Array.isArray(arr) ? arr : []) {
          if (g?.status === 'success' && typeof g.lat === 'number' && typeof g.lon === 'number') {
            geoByIp.set(g.query, { lat: g.lat, lng: g.lon, country: g.countryCode, city: g.city });
          }
        }
      }
    } catch (err) {
      console.error('[HORUS] ransomware ip-api error:', err);
    }
  }

  // Attach precise IP geo, else ccTLD centroid fallback.
  for (const [post, domain] of domainByPost) {
    const ip = ipByDomain.get(domain);
    const geo = ip ? geoByIp.get(ip) : undefined;
    if (geo) {
      post.lat = geo.lat; post.lng = geo.lng; post.country = geo.country; post.city = geo.city;
      continue;
    }
    const cc = ccTldToIso(domain);
    if (!cc) continue;
    const centroid = countryCentroid(cc, seedOf(post.id));
    if (centroid) { post.lng = centroid[0]; post.lat = centroid[1]; post.country = cc; }
  }
}

// ── route ────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const res = await fetch(`${RANSOMLOOK_BASE}/api/recent`, {
      signal: safeAbortTimeout(12000),
      cache: 'no-store',
      headers: { 'User-Agent': 'HORUS/4.2', Accept: 'application/json' },
    });
    if (!res.ok) {
      return NextResponse.json(
        { posts: [], total: 0, error: `RansomLook upstream ${res.status}` },
        { status: 502 },
      );
    }

    const raw = await res.json();
    const entries: any[] = Array.isArray(raw) ? raw : [];

    const normalized: RansomwarePost[] = [];
    for (const e of entries) {
      const victim = String(e?.post_title ?? '').trim();
      if (!victim) continue;
      const group = String(e?.group_name ?? 'unknown').trim() || 'unknown';
      const discovered = toIso(String(e?.discovered ?? ''));
      const rawLink = e?.link ? String(e.link) : '';
      const link = rawLink ? (rawLink.startsWith('http') ? rawLink : `${RANSOMLOOK_BASE}${rawLink}`) : undefined;
      const screenshot = e?.screen ? `${RANSOMLOOK_BASE}/${String(e.screen).replace(/^\/+/, '')}` : undefined;
      const sector = e?.description ? String(e.description).trim() || undefined : undefined;
      normalized.push({
        id: stableHash(`${group}|${victim}|${discovered}`),
        group, victim, sector, discovered, link, screenshot, source: 'ransomlook',
      });
    }

    // Dedupe by group+victim, keep the most recent, sort desc, cap.
    const byKey = new Map<string, RansomwarePost>();
    for (const p of normalized) {
      const k = `${norm(p.group)}|${norm(p.victim)}`;
      const prev = byKey.get(k);
      if (!prev || p.discovered > prev.discovered) byKey.set(k, p);
    }
    const posts = [...byKey.values()]
      .sort((a, b) => (a.discovered < b.discovered ? 1 : a.discovered > b.discovered ? -1 : 0))
      .slice(0, MAX_POSTS);

    await geolocateByIp(posts);

    const groups: Record<string, number> = {};
    for (const p of posts) groups[p.group] = (groups[p.group] ?? 0) + 1;
    const geolocated = posts.reduce((n, p) => n + (p.lat != null ? 1 : 0), 0);

    return NextResponse.json(
      {
        posts,
        total: posts.length,
        geolocated,
        groups,
        timestamp: new Date().toISOString(),
        sources: { ransomlook: posts.length },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } },
    );
  } catch (err) {
    console.error('[HORUS] Ransomware feed error:', err);
    return NextResponse.json({ posts: [], total: 0, error: 'Ransomware feed unavailable' }, { status: 500 });
  }
}
