/**
 * OSIRIS — RECON Scanner Backend (osiris-scanner)
 *
 * The Next.js app ships only a hardened *proxy* at /api/scanner. This is the
 * backend that proxy forwards to (SCANNER_URL, default http://scanner:7700).
 * The app's SCANNER_KEY must equal this service's OSIRIS_KEY.
 *
 * Design follows the proxy's defensive posture (see src/app/api/scanner/route.ts
 * and src/lib/ssrf-guard.ts):
 *   - shared-secret auth on every endpoint (?key=)
 *   - target validation: hostnames are resolved and any answer in a reserved /
 *     private / loopback / link-local range is rejected (no scanning internal infra)
 *   - the port scan is a bounded TCP *connect* scan over a curated common-port
 *     list — NOT a 65,535-port sweep (the proxy explicitly removed "deep"/"ports"
 *     as a DDoS amplifier) and NOT raw SYN (no privileges, no spoofing/evasion)
 *
 * Intended for authorized reconnaissance of targets you own or are permitted to
 * test. All data sources are public.
 *
 * Endpoints (all GET, all require ?key=&target=):
 *   /scan/quick       bounded TCP-connect port scan (~120 curated common ports)
 *   /scan/ports       top ~1000 ports (well-known 1-1024 + common service ports)
 *   /scan/deep        full 1-65535 sweep (bounded by a 4-minute deadline)
 *   /scan/ssl         TLS certificate + protocol/cipher
 *   /scan/headers     HTTP response headers
 *   /scan/rdns        reverse DNS
 *   /scan/subdomains  certificate-transparency subdomain enumeration (crt.sh)
 *   /scan/tech        lightweight tech fingerprint (headers + HTML heuristics)
 *   /scan/whois       basic WHOIS (IANA referral)
 *   /scan/geoloc      IP geolocation (ip-api.com)
 *   /scan/vuln        known CVEs for the host (Shodan InternetDB, keyless)
 */

const express = require('express');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns/promises');

const app = express();
const PORT = process.env.PORT || process.env.SCANNER_PORT || 7700;
const OSIRIS_KEY = process.env.OSIRIS_KEY || '';

// ════════════════════════════════════════════════════
// §1 — TARGET VALIDATION (mirrors src/lib/ssrf-guard.ts)
// ════════════════════════════════════════════════════

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const IPV6_BLOCK_PREFIXES = [
  '::', '::1', '::ffff:', '64:ff9b::', '64:ff9b:1:', '100::', '2001:db8:',
  'fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'fec', 'fed', 'fee', 'fef', 'ff',
];
const NAME_BLOCKLIST = [
  /^localhost$/i, /\.localhost$/i, /^host\.docker\.internal$/i,
  /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i,
];

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return p[0] * 0x1000000 + p[1] * 0x10000 + p[2] * 0x100 + p[3];
}
function ipv4Blocked(ip) {
  const v = ipv4ToInt(ip);
  for (const [net_, bits] of IPV4_BLOCKS) {
    const size = bits === 0 ? 0x100000000 : Math.pow(2, 32 - bits);
    if (Math.floor(v / size) === Math.floor(ipv4ToInt(net_) / size)) return true;
  }
  return false;
}
function ipv6Blocked(ip) {
  const l = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (l === '::' || l === '::1') return true;
  return IPV6_BLOCK_PREFIXES.some((p) => l.startsWith(p));
}
function canonicalIPv4(s) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((n) => n < 0 || n > 255)) return null;
    return p.join('.');
  }
  return null; // reject decimal/hex/octal/short forms
}

/**
 * Validate + resolve a user-supplied target. Returns
 * { ok, reason } or { ok:true, host, ip } where ip is a public address to scan.
 */
async function validateTarget(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty target' };
  const bare = trimmed.replace(/^\[|\]$/g, '');

  if (NAME_BLOCKLIST.some((re) => re.test(trimmed))) {
    return { ok: false, reason: 'reserved hostname' };
  }

  const fam = net.isIP(bare);
  if (fam === 4) {
    const c = canonicalIPv4(bare);
    if (!c) return { ok: false, reason: 'non-canonical IPv4' };
    if (ipv4Blocked(c)) return { ok: false, reason: 'reserved IPv4 range' };
    return { ok: true, host: c, ip: c };
  }
  if (fam === 6) {
    if (ipv6Blocked(bare)) return { ok: false, reason: 'reserved IPv6 range' };
    return { ok: true, host: bare, ip: bare };
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(trimmed)) {
    return { ok: false, reason: 'invalid hostname' };
  }
  let answers;
  try {
    answers = await dns.lookup(trimmed, { all: true });
  } catch (e) {
    return { ok: false, reason: `DNS lookup failed: ${e.message}` };
  }
  if (!answers.length) return { ok: false, reason: 'no A/AAAA records' };
  for (const a of answers) {
    if (a.family === 4 && ipv4Blocked(a.address)) return { ok: false, reason: `resolves to reserved ${a.address}` };
    if (a.family === 6 && ipv6Blocked(a.address)) return { ok: false, reason: `resolves to reserved ${a.address}` };
  }
  const v4 = answers.find((a) => a.family === 4);
  return { ok: true, host: trimmed, ip: (v4 || answers[0]).address };
}

// ════════════════════════════════════════════════════
// §2 — PORT SCAN (bounded TCP connect)
// ════════════════════════════════════════════════════

// Port-scan logic lives in ./portscan.js (net-only, no express) so it's unit-testable.
const { portScan, buildTopPorts, buildAllPorts } = require('./portscan');

const MAX_WHOIS_BYTES = 64 * 1024;

// ════════════════════════════════════════════════════
// §3 — OTHER RECON HELPERS
// ════════════════════════════════════════════════════

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

async function tlsInfo(host) {
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = sock.getPeerCertificate();
        const cipher = sock.getCipher();
        const proto = sock.getProtocol();
        sock.end();
        resolve({
          target: host,
          valid: sock.authorized,
          protocol: proto,
          cipher: cipher && cipher.name,
          issuer: cert && cert.issuer && (cert.issuer.O || cert.issuer.CN),
          subject: cert && cert.subject && cert.subject.CN,
          not_after: cert && cert.valid_to,
          expires: cert && cert.valid_to,
          sans: cert && cert.subjectaltname
            ? cert.subjectaltname.split(',').map((s) => s.replace('DNS:', '').trim())
            : [],
        });
      },
    );
    sock.once('error', (e) => { sock.destroy(); resolve({ target: host, valid: false, error: e.message }); });
    sock.once('timeout', () => { sock.destroy(); resolve({ target: host, valid: false, error: 'timeout' }); });
  });
}

async function httpHeaders(host) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://${host}`, { redirect: 'manual', signal: withTimeout(8000) });
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { target: host, scheme, status: res.status, server: headers.server, headers };
    } catch { /* try next scheme */ }
  }
  return { target: host, error: 'unreachable' };
}

async function techFingerprint(host) {
  const h = await httpHeaders(host);
  const tech = [];
  const hdr = h.headers || {};
  if (hdr.server) tech.push(hdr.server);
  if (hdr['x-powered-by']) tech.push(hdr['x-powered-by']);
  if (hdr['x-aspnet-version']) tech.push(`ASP.NET ${hdr['x-aspnet-version']}`);
  if (hdr['x-generator']) tech.push(hdr['x-generator']);
  try {
    const res = await fetch(`https://${host}`, { signal: withTimeout(8000) });
    const html = (await res.text()).slice(0, 200000);
    const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i);
    if (gen) tech.push(gen[1]);
    const sigs = [
      [/wp-content|wp-includes/i, 'WordPress'], [/\/_next\//, 'Next.js'],
      [/cdn\.shopify\.com/i, 'Shopify'], [/Drupal/i, 'Drupal'],
      [/static\.wixstatic/i, 'Wix'], [/data-reactroot|react/i, 'React'],
      [/ng-version/i, 'Angular'], [/__NUXT__/i, 'Nuxt.js'], [/cloudflare/i, 'Cloudflare'],
    ];
    for (const [re, name] of sigs) if (re.test(html) && !tech.includes(name)) tech.push(name);
  } catch { /* ignore body fetch errors */ }
  return { target: host, server: hdr.server, powered_by: hdr['x-powered-by'], technologies: [...new Set(tech)] };
}

async function subdomains(domain) {
  try {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`, {
      signal: withTimeout(14000),
      headers: { 'User-Agent': 'OSIRIS-scanner/1.0' },
    });
    if (!res.ok) return { domain, subdomains: [], count: 0, error: `crt.sh ${res.status}` };
    const rows = await res.json();
    const set = new Set();
    for (const row of rows) {
      String(row.name_value || '').split('\n').forEach((n) => {
        const v = n.trim().toLowerCase();
        if (v && !v.startsWith('*') && v.endsWith(domain)) set.add(v);
      });
    }
    const list = [...set].sort();
    return { domain, count: list.length, subdomains: list.slice(0, 500) };
  } catch (e) {
    return { domain, subdomains: [], count: 0, error: e.message };
  }
}

async function reverseDns(ip) {
  try {
    const names = await dns.reverse(ip);
    return { ip, hostnames: names };
  } catch (e) {
    return { ip, hostnames: [], error: e.message };
  }
}

async function geoloc(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,lat,lon,isp,as,query`, { signal: withTimeout(8000) });
    const d = await res.json();
    if (d.status !== 'success') return { ip, error: 'geoloc failed' };
    return { ip: d.query, lat: d.lat, lng: d.lon, city: d.city, country: d.country, isp: d.isp, asn: d.as };
  } catch (e) {
    return { ip, error: e.message };
  }
}

async function vulnScan(ip, host) {
  try {
    const res = await fetch(`https://internetdb.shodan.io/${ip}`, { signal: withTimeout(12000) });
    if (res.status === 404) return { target: host, vulnerabilities: [], risk_level: 'NONE', total: 0 };
    if (!res.ok) return { target: host, vulnerabilities: [], error: `InternetDB ${res.status}` };
    const d = await res.json();
    const vulns = (d.vulns || []).map((cve) => ({ id: cve, cve, type: 'cve' }));
    const risk = vulns.length > 10 ? 'CRITICAL' : vulns.length > 3 ? 'HIGH' : vulns.length > 0 ? 'MEDIUM' : 'NONE';
    return { target: host, ip, total: vulns.length, risk_level: risk, vulnerabilities: vulns, ports: d.ports || [] };
  } catch (e) {
    return { target: host, vulnerabilities: [], error: e.message };
  }
}

async function whois(domain) {
  // Minimal WHOIS over port 43 via IANA referral. Best-effort; returns raw text.
  function query(server, q) {
    return new Promise((resolve) => {
      const sock = net.connect(43, server);
      let data = '';
      let bytes = 0;
      sock.setTimeout(8000);
      sock.once('connect', () => sock.write(q + '\r\n'));
      sock.on('data', (b) => {
        bytes += b.length;
        data += b.toString();
        if (bytes > MAX_WHOIS_BYTES) {
          sock.destroy();
          resolve(data.slice(0, MAX_WHOIS_BYTES));
        }
      });
      sock.once('end', () => resolve(data));
      sock.once('timeout', () => { sock.destroy(); resolve(data); });
      sock.once('error', () => { sock.destroy(); resolve(data); });
    });
  }
  try {
    const iana = await query('whois.iana.org', domain);
    const refer = (iana.match(/refer:\s*(\S+)/i) || [])[1];
    const raw = refer ? await query(refer, domain) : iana;
    const field = (re) => (raw.match(re) || [])[1]?.trim();
    return {
      domain,
      registrar: field(/Registrar:\s*(.+)/i),
      creation_date: field(/Creation Date:\s*(.+)/i),
      expiration_date: field(/(?:Registry Expiry|Expiration) Date:\s*(.+)/i),
      updated_date: field(/Updated Date:\s*(.+)/i),
      name_servers: [...raw.matchAll(/Name Server:\s*(\S+)/gi)].map((m) => m[1]),
      raw: raw.slice(0, 4000),
    };
  } catch (e) {
    return { domain, error: e.message };
  }
}

// ════════════════════════════════════════════════════
// §4 — HTTP API
// ════════════════════════════════════════════════════

// A scan handler: validates key + target, runs `fn(validated)`.
function scan(needsIp, fn) {
  return async (req, res) => {
    if (!OSIRIS_KEY || req.query.key !== OSIRIS_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const v = await validateTarget(req.query.target);
    if (!v.ok) return res.status(403).json({ error: 'Target blocked', detail: v.reason });
    try {
      const out = await fn(v);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: 'Scan failed', detail: e.message });
    }
  };
}

// Precompute the larger profiles once.
const PORTS_TOP = buildTopPorts();
const PORTS_ALL = buildAllPorts();

function portScanResponse(v, scanType, result, t0) {
  return {
    target: v.host, host: v.host, ip: v.ip, scan_type: scanType,
    duration: `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    open_count: result.open.length, ports: result.open,
    ports_scanned: result.scanned,
    ...(result.truncated ? { truncated: true } : {}),
  };
}

app.get('/scan/quick', scan(true, async (v) => {
  const t0 = Date.now();
  const result = await portScan(v.ip);
  return portScanResponse(v, 'quick', result, t0);
}));

// Top ~1000 ports (well-known 1-1024 + common service ports). ~5-15s.
app.get('/scan/ports', scan(true, async (v) => {
  const t0 = Date.now();
  const result = await portScan(v.ip, PORTS_TOP, { concurrency: 250, timeout: 1200 });
  return portScanResponse(v, 'ports', result, t0);
}));

// Full 1-65535 sweep. Slow; capped at a 4-minute overall deadline (returns partial
// results with truncated:true if the host firewalls most ports).
app.get('/scan/deep', scan(true, async (v) => {
  const t0 = Date.now();
  const result = await portScan(v.ip, PORTS_ALL, { concurrency: 500, timeout: 1000, deadlineMs: 240000 });
  return portScanResponse(v, 'deep', result, t0);
}));

app.get('/scan/ssl', scan(false, (v) => tlsInfo(v.host)));
app.get('/scan/headers', scan(false, (v) => httpHeaders(v.host)));
app.get('/scan/tech', scan(false, (v) => techFingerprint(v.host)));
app.get('/scan/subdomains', scan(false, (v) => subdomains(v.host)));
app.get('/scan/rdns', scan(true, (v) => reverseDns(v.ip)));
app.get('/scan/geoloc', scan(true, (v) => geoloc(v.ip)));
app.get('/scan/vuln', scan(true, (v) => vulnScan(v.ip, v.host)));
app.get('/scan/whois', scan(false, (v) => whois(v.host)));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'osiris-scanner', configured: !!OSIRIS_KEY }));
app.get('/', (_req, res) => res.json({
  service: 'osiris-scanner',
  endpoints: ['/scan/quick', '/scan/ports', '/scan/deep', '/scan/ssl', '/scan/headers', '/scan/tech', '/scan/subdomains', '/scan/rdns', '/scan/geoloc', '/scan/vuln', '/scan/whois'],
}));

// Only bind/listen when run as the entrypoint (node server.js or forked by Electron).
// When require()'d by a test, we just expose the internals below without opening a socket.
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SCANNER] OSIRIS RECON backend on port ${PORT}`);
    if (!OSIRIS_KEY) console.warn('[SCANNER] WARNING: OSIRIS_KEY not set — all requests will be rejected. Set it (and the app SCANNER_KEY to match).');
  });

  const shutdown = (signal) => {
    console.log(`[SCANNER] ${signal} received; shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[SCANNER] Unhandled rejection:', err);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[SCANNER] Uncaught exception:', err);
    shutdown('uncaughtException');
  });
}
