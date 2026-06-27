# HORUS Code Review — Stability & Performance

> **Scope:** Stability and performance only. Security is explicitly out of scope.  
> **Codebase:** 134 source files, ~21,000 lines. Next.js 16.2.6 + React 19 + Electron 42.4.1.  
> **Reviewed by:** 5 parallel specialist agents covering Frontend/UI, API Routes (Data & External), API Routes (OSINT & Intelligence), Core Libraries, and Desktop/Infrastructure.  

---

## Executive Summary

This review identified **~130 findings** across the codebase. **8 Critical** and **25 High** severity issues require immediate attention. The most dangerous patterns are:

1. **Connection pool exhaustion** from unconsumed `fetch` response bodies on error paths (affects ~15 routes).
2. **No AbortControllers** on any frontend fetch calls, causing race conditions and state updates on unmounted components.
3. **Dead SSE connections** in `PolybolosClient` with no reconnect logic — the client silently stops receiving data.
4. **Node.js 18 incompatibility** — `AbortSignal.timeout()` is used in 18+ files but only exists in Node 20+.
5. **Permanent server death** in Electron — after 3 embedded server crashes, `serverRestartAttempts` is never reset.

### Severity Breakdown

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 8 | Causes crashes, data corruption, or permanent failure under normal use |
| **High** | 25 | Causes significant performance degradation, unbounded growth, or reliability issues |
| **Medium** | 55 | Causes occasional bugs, resource waste, or maintainability issues |
| **Low** | 42 | Minor improvements, code quality, or defensive programming gaps |
| **Total** | **130** | |

---

## Top 15 Issues by Impact

| # | Severity | File(s) | Issue | Impact |
|---|----------|---------|-------|--------|
| 1 | **Critical** | `src/app/api/*/route.ts` (15+ files) | Unconsumed `fetch` response bodies on `!res.ok` early returns | Node.js/undici connection pool exhaustion; all outbound fetches eventually hang |
| 2 | **Critical** | `src/lib/sdk/PolybolosClient.ts:233` | SSE `onerror` is a no-op; no reconnect, heartbeat, or max-retry | Connection dies silently; no data updates until manual page reload |
| 3 | **Critical** | `desktop/main.js:26` | `serverRestartAttempts` never reset after 3 crashes | Embedded server can never restart; app requires full relaunch |
| 4 | **Critical** | `src/app/api/osint/*/route.ts` (18+ files) | `AbortSignal.timeout()` is Node.js 20+ only | Crashes with `TypeError` on Node 18; all affected routes return 500 |
| 5 | **Critical** | `src/app/api/sdk/stream/route.ts` | No max concurrent SSE connection limit | Unbounded `setInterval` spawning; memory/CPU exhaustion via open connections |
| 6 | **Critical** | `src/app/api/cctv/route.ts` | `fetchCaltransCameras` (9 districts) and `fetchCanadaCameras` (7 endpoints) are sequential | Worst-case 70s+ latency per batch; serverless timeouts; connection leaks |
| 7 | **Critical** | `desktop/main.js:245,249` | Renderer crash handlers reload indefinitely with no backoff or retry limit | Infinite crash-reload loop can exhaust system resources |
| 8 | **Critical** | `src/app/page.tsx` | `fetchEndpoint` (feed engine) has no AbortController | State updates on unmounted component; memory leak in flight; race conditions |
| 9 | **High** | `src/app/api/fires/route.ts` | `parseCSV` splits on `,` with no quoted-field handling | Malformed CSV shifts columns, producing `NaN` coordinates and corrupted data |
| 10 | **High** | `src/app/api/gdelt/route.ts` | `crypto.randomUUID()` used for every event ID on every request | Client caches grow unbounded; no deduplication possible across polls |
| 11 | **High** | `src/app/api/space-weather/route.ts` | `parseFloat(latest.kp_index)` returns `NaN` for non-numeric strings | All storm-level comparisons silently fail; always reports `"Quiet"` |
| 12 | **High** | `src/app/page.tsx` | God component: ~50 state variables, 1,200+ lines of JSX | Every state change re-renders the entire app tree; severe performance degradation |
| 13 | **High** | `src/components/OsintPanel.tsx` | 10+ JSX helper functions defined inside component | Recreated every render, causing child remounts and DOM state destruction |
| 14 | **High** | `src/lib/sdk/PolybolosClient.ts` | `Math.random()` fallback IDs cause entity churn | Same entity re-created every ingest cycle; oldest stable entities get evicted |
| 15 | **High** | `intel/server.js:895` | Sanctions `setInterval` never cleared | Keeps process alive during shutdown; may fire new loads while exiting |

---

## Critical Issues (8)

### C1. Unconsumed Fetch Response Bodies — Connection Pool Exhaustion
- **Files:** `src/app/api/cctv/route.ts`, `src/app/api/flights/route.ts`, `src/app/api/satellites/route.ts`, `src/app/api/gdelt/route.ts`, `src/app/api/earthquakes/route.ts`, `src/app/api/frontlines/route.ts`, `src/app/api/radar/route.ts`, `src/app/api/cctv/asfinag.ts`, `src/app/api/cctv/stream-status/route.ts`, `src/app/api/region-dossier/route.ts`, `src/app/api/weather/route.ts`, `src/app/api/air-quality/route.ts`, `src/lib/stealthFetch.ts`
- **Issue:** On every `!res.ok` early return, the code does `return []` or `return NextResponse.json(...)` without consuming or cancelling the response body. In Node.js/undici, this leaves the connection in a "busy" state, eventually exhausting the connection pool and causing all outbound fetches to hang.
- **Fix:** Add `await res.body?.cancel()` before every `return` on a non-ok response path.
- **Effort:** Low (mechanical refactor across ~15 files)

### C2. PolybolosClient SSE Dead Connection — No Recovery
- **File:** `src/lib/sdk/PolybolosClient.ts:209-239`
- **Issue:** The SSE `onerror` handler is a no-op. If the connection drops (network hiccup, server restart, proxy timeout), the client never reconnects. The `onmessage` handler is also not nulled out in `destroy()`.
- **Fix:** Implement `onerror` with exponential backoff reconnect; add heartbeat ping/timeout; null out handlers in `destroy()`.
- **Effort:** Medium

### C3. Electron Embedded Server Never Restarts After 3 Crashes
- **File:** `desktop/main.js:26`
- **Issue:** `serverRestartAttempts` increments on every crash but is never reset. After 3 crashes, the server can never restart, and the app requires a full relaunch.
- **Fix:** Reset `serverRestartAttempts` to 0 after a successful server start, or after a cooldown period (e.g., 5 minutes).
- **Effort:** Low

### C4. `AbortSignal.timeout()` Node.js 18 Incompatibility
- **Files:** `src/app/api/osint/bgp/route.ts`, `src/app/api/osint/certs/route.ts`, `src/app/api/osint/cve/route.ts`, `src/app/api/osint/dns/route.ts`, `src/app/api/osint/github/route.ts`, `src/app/api/osint/ip/route.ts`, `src/app/api/osint/leaks/route.ts`, `src/app/api/osint/mac/route.ts`, `src/app/api/osint/phone/route.ts`, `src/app/api/osint/sanctions/route.ts`, `src/app/api/osint/shodan/route.ts`, `src/app/api/osint/sweep/route.ts`, `src/app/api/osint/threats/route.ts`, `src/app/api/osint/whois/route.ts`, `src/app/api/scanner/route.ts`, `src/app/api/cyber-threats/route.ts`, `src/app/api/malware/route.ts`, `src/app/api/sentinel/route.ts`, `src/lib/stealthFetch.ts`, `src/lib/ssrf-guard.ts`
- **Issue:** `AbortSignal.timeout(ms)` is a Node.js 20+ API. On Node 18, it throws `TypeError: AbortSignal.timeout is not a function`, causing all affected routes to return 500.
- **Fix:** Create a compatibility wrapper: `function timeoutSignal(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }` and replace all usages.
- **Effort:** Low (mechanical)

### C5. SSE Stream — No Connection Limit
- **File:** `src/app/api/sdk/stream/route.ts:26-97`
- **Issue:** Each SSE connection spawns 2 `setInterval` timers. There is no maximum connection limit, connection lifetime cap, or cleanup on client disconnect.
- **Fix:** Track active connections in a global counter; reject new connections when limit exceeded (e.g., 100); add a 30-minute max lifetime; clear intervals on `close` event.
- **Effort:** Medium

### C6. CCTV Sequential Fetchers — 70s+ Latency
- **File:** `src/app/api/cctv/route.ts:72-225`
- **Issue:** `fetchCaltransCameras` makes 9 sequential district requests; `fetchCanadaCameras` makes 7 sequential endpoint requests. The outer batch timeout is 25s, but inner requests continue running. Worst-case latency exceeds 70s per batch.
- **Fix:** Parallelize independent requests with `Promise.all` inside each region fetcher, or pass a shared `AbortController` that is checked between requests.
- **Effort:** Medium

### C7. Infinite Renderer Crash Reload Loop
- **File:** `desktop/main.js:245,249`
- **Issue:** `webContents.on('crashed', ...)` and `webContents.on('render-process-gone', ...)` reload the window with no backoff, no retry limit, and no failure logging. A persistently broken renderer will crash-reload forever.
- **Fix:** Add a reload counter with exponential backoff; after 5 attempts, show an error page and stop reloading.
- **Effort:** Low

### C8. Frontend Fetch Calls — No AbortControllers
- **Files:** `src/app/page.tsx` (lines 284, 357, 442), `src/components/AiAnalyst.tsx` (lines 238, 291), `src/components/OsintPanel.tsx` (lines 67, 95), `src/components/EntityGraphPanel.tsx` (line 121), `src/components/GlobalStatusBar.tsx` (line 23)
- **Issue:** No fetch call in the frontend uses an `AbortController`. If a component unmounts while a request is in flight, state setters fire on unmounted components. Rapid user interactions (e.g., clicking multiple graph nodes, right-clicking regions) spawn parallel requests that race and corrupt state.
- **Fix:** Add `AbortController` per request; store in a ref; abort previous before starting new; gate state updates with `if (!signal.aborted)`.
- **Effort:** Medium (affects ~8 files)

---

## High Issues (25)

### H1. `page.tsx` — God Component
- **File:** `src/app/page.tsx`
- **Issue:** ~50 state variables, 1,200+ lines of JSX. The `data` object is recreated on every feed tick, so all children re-render even when their specific data slice is unchanged.
- **Fix:** Split into context providers (`useMapData`, `useMapView`, `useLayers`) and sub-layout components. Use `React.memo` with custom comparison or pass individual data slices.
- **Effort:** High (architectural)

### H2. `OsintPanel` — Inline JSX Helpers
- **File:** `src/components/OsintPanel.tsx`
- **Issue:** `ResultRow`, `StatusBadge`, `SectionHeader`, `renderStructuredResults`, etc. are defined inside `OsintPanelInner`. They are recreated on every render, destroying child DOM state.
- **Fix:** Extract all helpers to module-level components or `useMemo` factories.
- **Effort:** Medium

### H3. `HorusMap.tsx` — JSON.parse Without Try/Catch
- **File:** `src/components/HorusMap.tsx` (lines 737, 761–763)
- **Issue:** `JSON.parse(p.active_threats)`, `JSON.parse(p.ports)`, `JSON.parse(p.vulns)`, `JSON.parse(p.hostnames)` in popup handlers. Malformed GeoJSON properties crash the popup and map interaction.
- **Fix:** Wrap all `JSON.parse` in `try/catch` with default empty arrays.
- **Effort:** Low

### H4. `fires/route.ts` — Broken CSV Parser
- **File:** `src/app/api/fires/route.ts`
- **Issue:** `parseCSV` splits on `,` with no quoted-field handling. Fields like `"Los Angeles, CA"` split into 4 columns, shifting lat/lng into wrong positions.
- **Fix:** Use a proper CSV parser (e.g., `csv-parse`) or implement quoted-field handling.
- **Effort:** Low

### H5. `gdelt/route.ts` — Unbounded Cache Growth
- **File:** `src/app/api/gdelt/route.ts`
- **Issue:** `crypto.randomUUID()` generates new IDs for identical events on every request. Client caches keyed by ID grow unbounded.
- **Fix:** Use deterministic ID: `id: \`gdelt-${hash(name + lat + lng)}\``. 
- **Effort:** Low

### H6. `space-weather/route.ts` — NaN Storm Level
- **File:** `src/app/api/space-weather/route.ts`
- **Issue:** `parseFloat(latest.kp_index)` returns `NaN` for non-numeric strings (e.g., `"G4"`). All comparisons (`>= 8`, `>= 7`, etc.) return `false`, so the API always reports `"Quiet"`.
- **Fix:** Check `Number.isNaN(kpIndex)` and fallback to 0. Parse known string levels before `parseFloat`.
- **Effort:** Low

### H7. `PolybolosClient.ts` — Random Fallback IDs Cause Entity Churn
- **File:** `src/lib/sdk/PolybolosClient.ts` (lines 44, 61, 81, 98, 115, 139, 156)
- **Issue:** `Math.random()` fallback IDs are non-deterministic. Same entity becomes a new entry every ingest cycle, evicting stable entities.
- **Fix:** Hash a stable subset of fields (e.g., `lat+lng+timestamp`) for fallback IDs.
- **Effort:** Low

### H8. `stealthFetch.ts` — Dead IP Generation Code
- **File:** `src/lib/stealthFetch.ts:74`
- **Issue:** `generateResidentialIP()` generates an IP but it is never added to headers. The stealth rotation logic is incomplete.
- **Fix:** Either add `X-Forwarded-For: ${ip}` to headers or remove the dead code.
- **Effort:** Low

### H9. `settings/index.ts` — Mutable Shared State Reference
- **File:** `src/lib/settings/index.ts:161`
- **Issue:** `getSettings()` returns the live mutable reference directly. Callers can mutate shared state without triggering listeners.
- **Fix:** Return a deep copy or freeze the returned object.
- **Effort:** Low

### H10. `LatticeAdapter.ts` — Unvalidated Position Access
- **File:** `src/lib/sdk/LatticeAdapter.ts:216-217`
- **Issue:** `translateTrack` dereferences `track.position` without validation. Malformed Lattice messages crash the adapter.
- **Fix:** Add `if (!track.position) throw new Error('missing position')` before translation.
- **Effort:** Low

### H11. `intel/server.js` — Sanctions Interval Never Cleared
- **File:** `intel/server.js:895`
- **Issue:** The sanctions `setInterval` is never cleared. It keeps the process alive during shutdown and may fire new loads while exiting.
- **Fix:** Store the interval ID and clear it in a `SIGTERM`/`SIGINT` handler.
- **Effort:** Low

### H12. `scanner/route.ts` — 90s Timeout Exceeds Serverless Limits
- **File:** `src/app/api/scanner/route.ts`
- **Issue:** The `vuln` scan config timeout is 90,000ms. Vercel Hobby = 10s, Pro = 60s. Guaranteed timeout.
- **Fix:** Reduce to platform limit (e.g., 10s) or remove `vuln` from public scans.
- **Effort:** Low

### H13. `osint/github/route.ts` — Promise.all Fail-Fast
- **File:** `src/app/api/osint/github/route.ts`
- **Issue:** Uses `Promise.all` for user + repos fetches. If repos fails, successfully-fetched user data is discarded.
- **Fix:** Use `Promise.allSettled` to get partial results.
- **Effort:** Low

### H14. `osint/threats/route.ts` — Tor List Downloaded Per IP Check
- **File:** `src/app/api/osint/threats/route.ts`
- **Issue:** For every IP check, the full Tor exit node list (~10,000 IPs, ~100KB) is downloaded and searched.
- **Fix:** Cache the Tor list globally with a 1-hour TTL.
- **Effort:** Low

### H15. `osint/sanctions/route.ts` — Limit Parses to NaN
- **File:** `src/app/api/osint/sanctions/route.ts`
- **Issue:** `parseInt('abc', 10)` → `NaN`; `Math.max(NaN, 1)` → `NaN`; `Math.min(NaN, 100)` → `NaN`. The `limit` is passed to the search engine as `NaN`.
- **Fix:** Add `isNaN` guard: `let limit = parseInt(...); if (isNaN(limit)) limit = 25;`.
- **Effort:** Low

### H16. `cctv/fanout.ts` — Promise.race Without Abort Linkage
- **File:** `src/app/api/cctv/fanout.ts`
- **Issue:** `settleFetcher` uses `Promise.race` against a timeout, but the underlying fetcher has no `AbortController`. When timeout fires, the fetcher continues running.
- **Fix:** Pass an `AbortController` into `settleFetcher` and call `controller.abort()` in the timeout branch.
- **Effort:** Medium

### H17. `sdk/ingest/route.ts` — Content-Length NaN Bypass
- **File:** `src/app/api/sdk/ingest/route.ts`
- **Issue:** `Number(request.headers.get('content-length') || '0')` returns `NaN` for malformed headers. `NaN > MAX_INGEST_BODY_BYTES` is `false`, bypassing the size guard.
- **Fix:** Check `isNaN(contentLength)` or `!Number.isFinite(contentLength)` before comparison.
- **Effort:** Low

### H18. `cctv/route.ts` — Overlapping Region Bounding Boxes
- **File:** `src/app/api/cctv/route.ts`
- **Issue:** `getRegionsForBounds` has overlapping bounding boxes (e.g., US-Central overlaps US-East and US-West). Same camera can be fetched twice, wasting bandwidth until `MAX_CAMERAS` cap is hit.
- **Fix:** Deduplicate `allCameras` by `id` before applying `MAX_CAMERAS`.
- **Effort:** Low

### H19. `maritime/route.ts` — WebSocket Never Closed
- **File:** `src/app/api/maritime/route.ts`
- **Issue:** WebSocket connection is opened globally and never explicitly closed on server shutdown or reload.
- **Fix:** Add `process.on('SIGTERM', ...)` or heartbeat to close stale sockets.
- **Effort:** Low

### H20. `proxy-tiles/route.ts` — Unbounded Fetch Cache
- **File:** `src/app/api/proxy-tiles/route.ts`
- **Issue:** `next: { revalidate: 31536000 }` with dynamic tile URLs means each unique URL is a separate cache entry. In non-edge deployments, the fetch cache grows unbounded.
- **Fix:** Use a shorter TTL or a bounded LRU cache for tiles.
- **Effort:** Low

### H21. `EntityGraphPanel.tsx` — No Request Deduplication
- **File:** `src/components/EntityGraphPanel.tsx:121-138`
- **Issue:** Rapid node clicks spawn parallel fetches; results merge in arrival order, corrupting the graph.
- **Fix:** Store `AbortController` in a ref; abort previous before starting new expansion.
- **Effort:** Low

### H22. `HorusMap.tsx` — Malware Mesh Unbounded Growth
- **File:** `src/components/HorusMap.tsx:1085`
- **Issue:** `nodes.length * 2` connections with no cap. If `malware_threats` grows large (e.g., 5K+), generates 10K+ line features and chokes the GPU.
- **Fix:** Cap `nodes.length` before generating links (e.g., `Math.min(nodes.length, MAX_MESH_NODES)`).
- **Effort:** Low

### H23. `HorusMap.tsx` — Map Load Handler No Try/Catch
- **File:** `src/components/HorusMap.tsx:137`
- **Issue:** The `map.on('load', ...)` callback has no `try/catch` around the massive layer/source initialization block. If any single `addLayer` throws, the entire map load fails and the app hangs.
- **Fix:** Wrap the entire `load` callback body in `try/catch` and surface a fallback UI.
- **Effort:** Low

### H24. `LatticeAdapter.ts` — Fixed 5s Reconnect, No Backoff
- **File:** `src/lib/sdk/LatticeAdapter.ts:263-269`
- **Issue:** Reconnect uses a fixed 5s delay with no backoff or max retry cap. Under persistent failure, it retries every 5s forever.
- **Fix:** Use exponential backoff (1s, 2s, 4s, 8s, max 60s) and cap retries.
- **Effort:** Low

### H25. `ai-engine.ts` — Throws on API Failure, No Degradation
- **File:** `src/lib/ai-engine.ts`
- **Issue:** `analyzeIntelligence` and `generateBriefing` throw on any API failure. The UI gets no briefing and the error is uncaught.
- **Fix:** Wrap in `try/catch` and return a user-friendly error message.
- **Effort:** Low

---

## Medium Issues (Selected — 20 of 55)

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| M1 | `src/components/HorusMap.tsx` | 1264 | `activeLayers.conflict_zones !== false` defaults to visible if key missing | Use `=== true` for explicit opt-in |
| M2 | `src/components/HorusMap.tsx` | 1272 | Sweep layers always visible even when `sweepData` is empty | Gate visibility on `sweepData?.devices?.length > 0` |
| M3 | `src/components/CameraViewer.tsx` | 14 | Not memoized; re-renders on every parent tick | Wrap in `React.memo` |
| M4 | `src/components/LiveAlerts.tsx` | 56 | Not memoized; re-renders on every `data` change | Wrap in `React.memo` |
| M5 | `src/components/AiAnalyst.tsx` | 229 | `getHeaders` reads `localStorage` on every invocation | Memoize the key once on mount |
| M6 | `src/components/HorusMap.tsx` | 54 | `canvas.getContext('2d')!` non-null assertion | Check for null and return early |
| M7 | `src/components/HorusMap.tsx` | 477 | `e.features[0].properties as any` | Use strict typing with optional chaining |
| M8 | `src/components/SettingsPanel.tsx` | 85 | `(window as any).horus?.relaunch?.()` no error handling | Wrap in try/catch and show toast |
| M9 | `src/app/api/air-quality/route.ts` | 27 | `.json()` called before checking `r.ok` | Check `r.ok` before `.json()` |
| M10 | `src/app/api/resilient.ts` | 47 | Retry backoff is linear, not exponential | Use `Math.min(200 * 2^attempt, 5000)` |
| M11 | `src/app/api/resilient.ts` | 66 | `withFallback` catches errors silently and prunes cache | Move prune to after successful update |
| M12 | `src/app/api/osint/dns/route.ts` | 73 | Cache eviction is FIFO, not LRU | Update timestamp on access or use `lru-cache` |
| M13 | `src/app/api/osint/cve/route.ts` | 87 | Negative cache entries use same 5-min TTL as hits | Use shorter negative-cache TTL (e.g., 30s) |
| M14 | `src/app/api/sentinel/route.ts` | 8 | `days` and `radius` have no upper/lower bounds | Clamp `days` to [1, 365] and `radius` to [0.1, 50] |
| M15 | `src/app/api/osint/malware/route.ts` | 113 | No rate limit coordination for ip-api.com batch | Add global rate-limit semaphore or cache |
| M16 | `src/lib/registry/engine.ts` | 25 | `runFetch` uses `void Promise.resolve(...)` with no `.catch()` | Add `.catch((err) => console.error(...))` |
| M17 | `src/lib/registry/store.ts` | 7 | `groups` and `layers` Maps have no size limit | Add `MAX_LAYERS` / `MAX_GROUPS` guard |
| M18 | `src/lib/settings/index.ts` | 84 | `deepMerge` returns `null` when `patch` is `null` | Treat `null` same as `undefined` |
| M19 | `src/lib/ssrf-guard.ts` | 256 | `rateMap` entry count grows indefinitely | Cap `entry.count` at `limit + 1` |
| M20 | `desktop/main.js` | — | No `SIGTERM`/`SIGINT` handler for graceful shutdown | Add cleanup for server, intervals, and sockets |

---

## Low Issues (Selected — 15 of 42)

| # | File | Line | Issue | Fix |
|---|------|------|-------|-----|
| L1 | `src/components/SharePanel.tsx` | 44 | `document.execCommand('copy')` deprecated | Use `navigator.clipboard.writeText` exclusively |
| L2 | `src/components/HorusMap.tsx` | 1218 | Hardcoded future-dated URL | Review and update URLs periodically |
| L3 | `src/components/OsintPanel.tsx` | 183 | `case 'crypto':` is dead code (not in `TABS`) | Remove unused case |
| L4 | `src/components/LiveAlerts.tsx` | 101 | `filter === 'all'` excludes live feeds | Rename or include feeds |
| L5 | `src/app/api/cctv/route.ts` | 86 | `fetchCaltransCameras` silent catch for each district | Log district failures with `console.warn` |
| L6 | `src/app/api/surveillance/route.ts` | 97 | Returns 200 with empty array on Overpass error | Return actual error status (e.g., 502) |
| L7 | `src/app/api/osint/whois/route.ts` | 65 | HEAD request may return 405; no fallback | Fall back to GET with `range: bytes=0-0` |
| L8 | `src/app/api/osint/bgp/route.ts` | 54 | No retry if `bgpview.io` fails | Add 1 retry with 1s delay |
| L9 | `src/app/api/osint/shodan/route.ts` | 16 | No retry or fallback if `internetdb.shodan.io` is down | Add 1 retry and fallback |
| L10 | `src/lib/ai-engine.ts` | 204 | `_keyIndex` is module-level mutable state | Accept optional index state or use keyed rotation |
| L11 | `src/lib/registry/builtins.ts` | 16 | Pervasive `any` types in `toFeatures` | Replace with `unknown` + runtime validation |
| L12 | `src/lib/sanctions.ts` | 53 | Module-level cache with no invalidation API | Add `invalidateCache()` or use LRU |
| L13 | `desktop/main.js` | — | No cleanup of `BrowserWindow` instances on quit | Ensure all window references are nulled |
| L14 | `desktop/prepare-standalone.js` | — | Non-atomic file writes | Use temp-file + rename pattern |
| L15 | `scripts/*.js` | Various | Missing error handling in patch scripts | Add try/catch and exit codes |

---

## Priority Action Plan

### Immediate (Deploy Blockers — Fix Before Next Release)

| Priority | Issue | Files | Effort |
|----------|-------|-------|--------|
| 1 | Add `await res.body?.cancel()` to all `!res.ok` early returns | ~15 API route files | Low |
| 2 | Replace `AbortSignal.timeout()` with Node 18-compatible wrapper | ~18 API route files | Low |
| 3 | Fix `PolybolosClient` SSE reconnect logic | `src/lib/sdk/PolybolosClient.ts` | Medium |
| 4 | Add max concurrent connection limit to SSE stream | `src/app/api/sdk/stream/route.ts` | Medium |
| 5 | Parallelize CCTV sequential fetchers | `src/app/api/cctv/route.ts` | Medium |
| 6 | Reset `serverRestartAttempts` after successful start | `desktop/main.js` | Low |
| 7 | Add reload limit to renderer crash handlers | `desktop/main.js` | Low |
| 8 | Add AbortControllers to all frontend fetch calls | `page.tsx`, `AiAnalyst.tsx`, `OsintPanel.tsx`, `EntityGraphPanel.tsx` | Medium |
| 9 | Fix `space-weather` NaN handling | `src/app/api/space-weather/route.ts` | Low |
| 10 | Fix `fires` CSV parser | `src/app/api/fires/route.ts` | Low |

### Short-Term (Fix Within 1 Sprint)

| Priority | Issue | Files | Effort |
|----------|-------|-------|--------|
| 11 | Use deterministic IDs in GDELT | `src/app/api/gdelt/route.ts` | Low |
| 12 | Cache Tor exit list globally | `src/app/api/osint/threats/route.ts` | Low |
| 13 | Add caching to OSINT routes that lack it | `github`, `ip`, `leaks`, `mac`, `shodan`, `whois`, `threats`, `sentinel`, `cyber-threats`, `malware` | Low |
| 14 | Fix `sdk/ingest` Content-Length NaN bypass | `src/app/api/sdk/ingest/route.ts` | Low |
| 15 | Fix sanctions `limit` NaN parsing | `src/app/api/osint/sanctions/route.ts` | Low |
| 16 | Switch GitHub route to `Promise.allSettled` | `src/app/api/osint/github/route.ts` | Low |
| 17 | Reduce scanner `vuln` timeout to 10s | `src/app/api/scanner/route.ts` | Low |
| 18 | Add bounds checking to sentinel params | `src/app/api/sentinel/route.ts` | Low |
| 19 | Fix `LatticeAdapter` position validation | `src/lib/sdk/LatticeAdapter.ts` | Low |
| 20 | Fix `settings/index.ts` mutable reference | `src/lib/settings/index.ts` | Low |

### Medium-Term (Fix Within 2 Sprints)

| Priority | Issue | Files | Effort |
|----------|-------|-------|--------|
| 21 | Refactor `page.tsx` god component | `src/app/page.tsx` | High |
| 22 | Extract `OsintPanel` inline helpers | `src/components/OsintPanel.tsx` | Medium |
| 23 | Add retry with exponential backoff to all external fetches | All API routes | Medium |
| 24 | Implement circuit breaker for failing upstreams | All API routes | Medium |
| 25 | Add proper LRU caching with bounded size | `src/lib/registry/store.ts`, `src/lib/sanctions.ts`, `src/lib/ssrf-guard.ts` | Medium |
| 26 | Add `SIGTERM`/`SIGINT` graceful shutdown | `desktop/main.js`, `intel/server.js`, `scanner/server.js` | Low |
| 27 | Fix `stealthFetch` dead IP generation | `src/lib/stealthFetch.ts` | Low |
| 28 | Fix `PolybolosClient` random fallback IDs | `src/lib/sdk/PolybolosClient.ts` | Low |
| 29 | Add JSON.parse try/catch in MapLibre popups | `src/components/HorusMap.tsx` | Low |
| 30 | Add WebSocket cleanup on shutdown | `src/app/api/maritime/route.ts` | Low |

---

## Appendix: Review Coverage

| Domain | Files Reviewed | Agent |
|--------|---------------|-------|
| Frontend / UI Components | 20 | Frontend_Stability_Reviewer |
| API Routes — Data & External | 47 | API_Routes_Stability_Reviewer |
| API Routes — OSINT & Intelligence | 23 | OSINT_API_Stability_Reviewer |
| Core Libraries & SDK | 18 | Core_Lib_Stability_Reviewer |
| Desktop & Infrastructure | 22 | Desktop_Infra_Stability_Reviewer |
| **Total** | **130** | |

**Excluded from scope:** Security vulnerabilities (XSS, auth bypass, injection, etc.) per user request.
