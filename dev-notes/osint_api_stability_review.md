# OSINT API Route Stability & Performance Review

## Executive Summary -- Top 10 Issues by Impact

| Rank | Severity | Issue | File(s) | Impact |
|------|----------|-------|---------|--------|
| 1 | **Critical** | `AbortSignal.timeout()` is Node.js 20+ only; will crash on Node 18 | 18+ route files | All external fetch calls throw `TypeError`, causing 500 errors across the entire OSINT surface |
| 2 | **Critical** | SSE stream endpoint has no connection limit | `sdk/stream/route.ts` | Unbounded interval spawning; attacker can exhaust memory/CPU by opening thousands of SSE connections |
| 3 | **High** | Scanner `vuln` type has 90s timeout | `scanner/route.ts` | Exceeds typical serverless function limits (10-60s), causing guaranteed 504 Gateway Timeouts |
| 4 | **High** | GitHub route uses `Promise.all` (fail-fast) | `osint/github/route.ts` | If repos fetch fails, successfully-fetched user data is discarded; entire lookup returns 502 |
| 5 | **High** | Ingest route Content-Length check bypassed by `NaN` | `sdk/ingest/route.ts` | Malformed `Content-Length: abc` bypasses 1MB limit, allowing OOM via huge payloads |
| 6 | **High** | Tor exit list downloaded in full for every single IP check | `osint/threats/route.ts` | ~100KB downloaded per IP check; wastes bandwidth and slows responses dramatically |
| 7 | **High** | Sanctions `limit` parameter parses to `NaN` | `osint/sanctions/route.ts` | Non-numeric `limit` becomes `NaN` and propagates to the search engine, causing undefined behavior |
| 8 | **High** | No caching on most external API routes | 12+ route files | Every request triggers fresh external calls; increases latency and hits upstream rate limits |
| 9 | **Medium** | Sentinel `days`/`radius` parameters unbounded | `sentinel/route.ts` | Massive datetime ranges or bboxes can be requested, causing huge responses or upstream rejections |
| 10 | **Medium** | GitHub webhook `JSON.parse` without try-catch | `github-webhook/route.ts` | Malformed JSON after signature validation causes 500 instead of clean 400 |

---

## 1. Memory Leaks & Unbounded Growth

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| Critical | `sdk/stream/route.ts` | 26-97 | No maximum concurrent SSE connection limit; each connection spawns 2 `setInterval` timers | Attacker can open thousands of connections, exhausting memory and CPU | Track active connections in a global counter; reject new connections when limit exceeded (e.g., 100) |
| Medium | `sdk/stream/route.ts` | 26-97 | No maximum connection lifetime for SSE streams | Connections can persist indefinitely, causing slow memory accumulation | Add a `setTimeout` to close the stream after 30 minutes |
| Medium | `sdk/ingest/route.ts` | 41-42 | `Number(request.headers.get('content-length') || '0')` returns `NaN` for malformed headers; `NaN > MAX_INGEST_BODY_BYTES` is `false` | Malformed `Content-Length` bypasses the 1MB size guard | Check `isNaN(contentLength)` or `!Number.isFinite(contentLength)` before the comparison |
| Medium | `osint/sweep/route.ts` | 33-38 | Custom `setInterval` rate limiter runs on module load; in serverless environments intervals may leak or behave unpredictably across cold starts | Rate limit state is unreliable; interval may never fire or fire unexpectedly | Use the shared `isRateLimited` from `@/lib/ssrf-guard` instead of a custom implementation |
| Low | `osint/cve/route.ts` | 87-88 | Failed (unavailable) lookups are cached with the same 5-minute TTL as successful ones | If the upstream API recovers, users still get "unavailable" for 5 minutes | Use a shorter negative-cache TTL (e.g., 30s) or skip caching failures |

---

## 2. Error Handling & Timeouts

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| Critical | `scanner/route.ts` | 42, 109 | `vuln` scan config timeout is 90,000ms | Exceeds typical serverless platform limits (Vercel Hobby = 10s, Pro = 60s); guaranteed timeout | Reduce to platform limit (e.g., 10s) or remove `vuln` from public scans |
| High | `osint/github/route.ts` | 14-23 | Uses `Promise.all` for user + repos fetches | If `reposRes` fails, `Promise.all` rejects immediately and the successfully-fetched user data is lost | Use `Promise.allSettled` to get partial results |
| High | `scanner/route.ts` | 111 | `await res.json()` without checking if body is valid JSON | If the scanner returns HTML (e.g., 500 error page), `res.json()` throws and the route returns misleading 502 | Wrap `res.json()` in try-catch; return the raw text fallback if JSON parsing fails |
| Medium | `github-webhook/route.ts` | 27 | `JSON.parse(payloadText)` without try-catch | Malformed JSON after signature verification causes 500 instead of 400 | Wrap in try-catch and return `400` with "Invalid JSON payload" |
| Medium | `osint/certs/route.ts` | 29 | `await res.json()` -- if crt.sh returns HTML with 200 OK, `certs` is not an array | `certs.slice(0, 200)` throws `TypeError` on non-array | Add `if (!Array.isArray(certs)) throw new Error('Invalid response from crt.sh')` |
| Medium | `osint/malware/route.ts` | 120-121 | `geoData = await geoRes.json()` from ip-api batch is not checked as an array before iterating | If ip-api returns an object (e.g., error), `for (const geo of geoData)` throws | Add `if (!Array.isArray(geoData))` guard before the loop |
| Low | `osint/dns/route.ts` | 40-45 | Google DNS response includes `Status` field (0=NOERROR, 3=NXDOMAIN); code only checks `res.ok` | NXDOMAIN responses are treated as successful lookups with empty answers | Check `data.Status !== 0` and return an `nxdomain: true` indicator |

---

## 3. Async & Concurrency

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| High | `osint/threats/route.ts` | 51-56 | For every IP check, the full Tor exit node list (~10,000 IPs, ~100KB) is downloaded and searched | Massive bandwidth waste; slow responses; risk of hitting Tor Project rate limits | Cache the Tor list globally with a 1-hour TTL; search the cached copy |
| Medium | `cyber-threats/route.ts` | 10-50 | CISA and Shadowserver fetches run sequentially | Response time is the sum of both fetches instead of the max | Use `Promise.allSettled` to run them in parallel |
| Medium | `scm-suppliers/route.ts` | 44-45 | `fetch(new URL('/api/fires', request.url))` and `fetch(new URL('/api/gdelt', request.url))` make HTTP calls to internal endpoints | Adds unnecessary HTTP overhead; `request.url` may be wrong behind proxies; cascading failures | Call the internal handler functions directly instead of making HTTP requests to self |
| Medium | `osint/malware/route.ts` | 113-118 | `ip-api.com/batch` free tier = 15 req/min; no rate limit coordination across concurrent requests | Multiple concurrent requests can exceed the free tier limit, causing all batch lookups to fail | Add a global rate-limit semaphore or cache ip-api responses for 5 minutes |
| Low | `osint/bgp/route.ts` | 54-64 | IP lookup path only makes one fetch; if it fails, no fallback or retry | Users get empty BGP results if bgpview.io is temporarily down | Add a retry (1 retry) or fallback to another BGP source |

---

## 4. Resource Management

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| High | `osint/malware/route.ts` | 53, 86 | Feodo Tracker JSON and URLhaus CSV are parsed entirely into memory | If feeds grow, could exceed serverless memory limits | Implement response size guards or stream the CSV; add caching so fetches aren't per-request |
| Medium | `sdk/ingest/route.ts` | 77-119 | Synchronous `for...of` loop over all entities in a single tick | Large entity arrays (up to 1MB of JSON) can briefly block the event loop | Not critical for typical sizes, but could batch process |
| Low | `osint/whois/route.ts` | 65-68 | `safeFetch` uses `method: 'HEAD'`; some servers return 405 Method Not Allowed | HTTP fingerprinting section silently fails for servers that reject HEAD | Fall back to `GET` with `range: bytes=0-0` if HEAD returns 405 |

---

## 5. Caching Strategy

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| High | 12+ routes | Various | No caching on external API calls: `cyber-threats`, `malware`, `github`, `ip`, `leaks`, `mac`, `shodan`, `threats`, `whois`, `scanner`, `scm-suppliers`, `sentinel` | Every request triggers fresh external calls; increased latency, bandwidth, and rate-limit risk | Add per-route in-memory TTL caches (e.g., 5-60 min) with bounded size (e.g., 500 entries) |
| Medium | `osint/dns/route.ts` | 73-77 | Cache eviction uses `cache.keys().next().value`, which is FIFO (first inserted), not LRU | Frequently accessed domains may be evicted before rarely accessed ones | Implement proper LRU by updating `timestamp` on access, or use `lru-cache` library |
| Medium | `osint/cve/route.ts` | 87-88 | Negative cache entries use the same TTL as hits | Transient upstream failures block fresh lookups for 5 minutes | Store negative cache entries with a shorter TTL (e.g., 30s) |

---

## 6. TypeScript / Runtime Safety

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| High | `osint/sanctions/route.ts` | 21 | `parseInt('abc', 10)` -> `NaN`; `Math.max(NaN, 1)` -> `NaN`; `Math.min(NaN, 100)` -> `NaN` | `limit` becomes `NaN` and is passed to the search engine, causing undefined behavior | Add `isNaN` guard: `let limit = parseInt(...); if (isNaN(limit)) limit = 25;` |
| Medium | `sentinel/route.ts` | 8-9 | `days` and `radius` parsed with `parseInt`/`parseFloat` but have no upper/lower bounds | Can request `days=100000` or `radius=1000`, causing massive upstream queries or huge responses | Clamp `days` to [1, 365] and `radius` to [0.1, 50] |
| Medium | `osint/mac/route.ts` | 16 | `cleanMac` could be empty string after `replace(/[^A-F0-9:-]/g, '')` | Empty string is passed to the external API, which returns an error | Validate `cleanMac.length >= 6` before calling the API |
| Medium | `osint/leaks/route.ts` | 6 | No email format validation before calling `xposedornot.com` | Invalid emails are sent to the API, wasting resources | Add basic email regex validation before the fetch |
| Low | `osint/phone/route.ts` | 111-119 | Input normalization: `query = '+' + query` for non-10-digit inputs without `+` or `00` | Strings like `12345` become `+12345` and may parse unexpectedly | Validate the normalized string before calling `phoneUtil.parse()` |
| Low | `malware/route.ts` | 151 | Source label includes `"ThreatFox"` but the code never fetches ThreatFox data | Misleading data provenance | Remove `"ThreatFox"` from the label or implement the fetch |

---

## 7. Data Integrity

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| Medium | `scm-suppliers/route.ts` | 52-87 | `risk_level` is overwritten by later threat checks without considering cumulative severity | If fire sets `HIGH` and then earthquake sets `CRITICAL`, the `HIGH` is lost (this is correct), but if earthquake is absent, fire's `HIGH` is the final state. However, the order is fixed (eq -> fire -> gdelt), so it's deterministic. | Consider tracking the highest risk level across all threat types rather than overwriting |
| Low | `osint/certs/route.ts` | 36-47 | `certs.slice(0, 200)` is applied after parsing the entire crt.sh response | If crt.sh returns 10,000 certs for a popular domain, all are parsed into memory before slicing | Not easily fixable without pagination, but document the behavior |

---

## 8. API Design Anti-Patterns

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| Medium | `osint/cve/route.ts` | 94-138 | `cna` nested property access is deep and fragile | If MITRE changes the JSON structure, the route returns `undefined` fields instead of graceful degradation | Add null-guards at each level or use a helper like `lodash.get` |
| Medium | `github-webhook/route.ts` | 6 | `await request.text()` has no size limit before the body is read | Large malicious payloads could cause memory exhaustion | Check `request.headers.get('content-length')` before reading the body |
| Low | `cyber-threats/route.ts` | 8 | `const results: any = { ... }` -- using `any` type | Loses TypeScript safety on the response shape | Define a proper interface for the response object |

---

## 9. External Integration Resilience

| Severity | File | Line | Issue | Impact | Recommendation |
|----------|------|------|-------|--------|----------------|
| Critical | 18+ routes | Various | `AbortSignal.timeout(ms)` is used throughout; this is a Node.js 20+ API | On Node.js 18, every route using it throws `TypeError` and returns 500 | Create a compatibility wrapper: `function timeoutSignal(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }` |
| High | `osint/cve/route.ts` | 56-78 | Has a fallback to CIRCL if MITRE fails, but no retry or exponential backoff on either | Transient network failures cause immediate fallback or unavailable response | Add 1 retry with exponential backoff (e.g., 1s then 2s) before falling back |
| High | `osint/ip/route.ts` | 29-54 | No retry, no caching, no fallback if `ip-api.com` fails | Single point of failure for geolocation; every request is a fresh call | Add a 5-minute TTL cache and a fallback to another free geo IP service |
| Medium | `osint/shodan/route.ts` | 16-37 | No retry or fallback if `internetdb.shodan.io` is down | Users get 502 for all Shodan lookups during outages | Add 1 retry and a fallback to Shodan API key endpoint if configured |
| Medium | `osint/whois/route.ts` | 28-31 | No fallback if `rdap.org` is down | WHOIS lookups fail entirely if the single RDAP source is unavailable | Add fallback to `whois` command or another RDAP endpoint |
| Low | `osint/bgp/route.ts` | 54-64 | No retry if `bgpview.io` fails | Single transient failure causes empty results | Add 1 retry with a 1-second delay |

---

## 10. Consolidated Fix Priority List

### Immediate (Fix before next deploy)
1. Replace all `AbortSignal.timeout(ms)` calls with a Node.js 18-compatible wrapper.
2. Add a max concurrent connection limit to `sdk/stream/route.ts`.
3. Fix `sdk/ingest/route.ts` Content-Length `NaN` bypass.
4. Fix `osint/sanctions/route.ts` `limit` parsing bug.
5. Reduce `scanner/route.ts` `vuln` timeout to <=10s or remove it from allowed scans.

### Short-term (Fix within 1 sprint)
6. Switch `osint/github/route.ts` from `Promise.all` to `Promise.allSettled`.
7. Cache the Tor exit list in `osint/threats/route.ts` (1-hour TTL).
8. Add TTL-based caching to routes that lack it: `github`, `ip`, `leaks`, `mac`, `shodan`, `whois`, `threats`, `sentinel`, `cyber-threats`, `malware`.
9. Add bounds checking to `sentinel/route.ts` `days` and `radius`.
10. Fix `github-webhook/route.ts` JSON.parse try-catch and add payload size limit.

### Medium-term (Fix within 2 sprints)
11. Add retry with exponential backoff to all external fetch calls.
12. Switch `scm-suppliers/route.ts` internal HTTP calls to direct function calls.
13. Add SSE connection lifetime cap (30 min) and heartbeat cleanup verification.
14. Replace `sweep/route.ts` custom rate limiter with shared `isRateLimited`.
15. Add proper null-guards to all external API response parsing.

---

*Report generated by OSINT_API_Stability_Reviewer. Scope: Performance & stability only. Security issues were intentionally excluded per instructions.*
