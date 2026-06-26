import { NextResponse } from 'next/server';
import { validateHost, isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { safeAbortTimeout } from '@/lib/http-utils';

/**
 * HORUS — Scanner Proxy (Hardened)
 * Rate-limited, target-validated, scope-restricted
 */

const SCANNER_URL = process.env.SCANNER_URL || '';
const SCANNER_KEY = process.env.SCANNER_KEY || '';
const VALIDATE_HOST_TIMEOUT_MS = 5000;
// The desktop app sets this for its bundled, local, single-user scanner. It un-gates the
// heavier port scans (`ports`, `deep`) that stay disabled on the public web deployment,
// where an open proxy could be abused to scan arbitrary targets from the server's IP.
const ALLOW_DEEP = process.env.SCANNER_ALLOW_DEEP === '1';

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// The string-based regex previously here matched only literal dotted-quad
// IPv4, missed every IPv6 form, and never resolved hostnames — so an attacker
// could bypass it with `target=metadata.example.com` (DNS A → 169.254.169.254),
// `target=2130706433` (decimal 127.0.0.1), or `target=::1`. Validation now
// canonicalises the input and resolves hostnames before deciding. See
// `src/lib/ssrf-guard.ts`.

// ── ALLOWED SCAN TYPES (safe subset only) ──
// `local: true` entries are only permitted when SCANNER_ALLOW_DEEP=1 (the bundled desktop
// scanner). Their timeouts are generous because they scan far more ports.
const ALLOWED_SCANS: Record<string, { endpoint: string; timeout: number; local?: boolean }> = {
  quick:      { endpoint: '/scan/quick',      timeout: 15000 },
  ports:      { endpoint: '/scan/ports',      timeout: 45000,  local: true },
  deep:       { endpoint: '/scan/deep',       timeout: 300000, local: true },
  ssl:        { endpoint: '/scan/ssl',        timeout: 10000 },
  headers:    { endpoint: '/scan/headers',    timeout: 10000 },
  rdns:       { endpoint: '/scan/rdns',       timeout: 8000  },
  subdomains: { endpoint: '/scan/subdomains', timeout: 15000 },
  tech:       { endpoint: '/scan/tech',       timeout: 15000 },
  whois:      { endpoint: '/scan/whois',      timeout: 10000 },
  geoloc:     { endpoint: '/scan/geoloc',     timeout: 8000  },
  vuln:       { endpoint: '/scan/vuln',       timeout: 10000 },
};

// Still removed from public access (no backend endpoint either): banner, traceroute —
// they harvest software versions / reveal hosting infra using our IP. `ports`/`deep`
// are now allowed only for the local desktop scanner (see ALLOW_DEEP above).

export async function GET(req: Request) {
  // 1. Check scanner is configured
  if (!SCANNER_KEY) {
    return NextResponse.json({ error: 'Scanner not configured', hint: 'Set SCANNER_URL and SCANNER_KEY in .env' }, { status: 503 });
  }

  // 2. Rate limit by client IP
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 5, 60_000)) {
    return NextResponse.json({
      error: 'Rate limit exceeded',
      detail: `Maximum 5 scans per minute. Please wait before scanning again.`,
    }, { status: 429 });
  }

  // 3. Validate params
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('target')?.trim();
  const scanType = searchParams.get('type') || 'quick';

  if (!target) {
    return NextResponse.json({ error: 'Missing target parameter' }, { status: 400 });
  }

  // 4. Block private/internal targets (DNS-resolves before deciding so a
  //    hostname pointing at a reserved range is rejected, and IPv6 + non-
  //    canonical IPv4 forms are no longer free bypasses).
  let guard;
  try {
    guard = await withDeadline(validateHost(target), VALIDATE_HOST_TIMEOUT_MS, 'Target validation');
  } catch {
    return NextResponse.json({
      error: 'Target validation timed out',
      detail: 'DNS or SSRF validation did not complete in time.',
    }, { status: 504 });
  }
  if (!guard.ok) {
    return NextResponse.json({
      error: 'Target blocked',
      detail: `Target validation failed: ${guard.reason}`,
    }, { status: 403 });
  }

  // 5. Validate scan type (only safe scans allowed; heavy scans require the local scanner)
  const available = Object.keys(ALLOWED_SCANS).filter((k) => !ALLOWED_SCANS[k].local || ALLOW_DEEP);
  const scanConfig = ALLOWED_SCANS[scanType];
  if (!scanConfig || (scanConfig.local && !ALLOW_DEEP)) {
    return NextResponse.json({
      error: 'Scan type not available',
      detail: scanConfig?.local
        ? `"${scanType}" is only available in the HORUS desktop app (local scanner).`
        : `"${scanType}" is restricted. Available: ${available.join(', ')}`,
      available_scans: available,
    }, { status: 403 });
  }

  // 6. Execute scan with tight timeout
  try {
    const params = new URLSearchParams({ key: SCANNER_KEY, target });
    const res = await fetch(`${SCANNER_URL}${scanConfig.endpoint}?${params.toString()}`, {
      signal: safeAbortTimeout(scanConfig.timeout),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({
      error: 'Scanner unreachable',
      detail: e.message,
    }, { status: 502 });
  }
}
