# HORUS Stability, Functionality & Performance Review — Delta (b8e2005..95180c9)

**Reviewer:** Orchestrator + 4 specialist sub-agents  
**Scope:** Stability, functionality, and performance ONLY. Security is OUT OF SCOPE.  
**Commit range:** `b8e2005` (prior review) → `95180c9` (HEAD)  
**Date:** 2026-06-27 (NZST)  
**Files changed:** 207 files, ~9,300 insertions, ~1,486 deletions  

---

## Executive Summary

The delta introduces 15 commits of major new functionality: the **intel framework** (compile engine, address/route providers, dossier UI), **live location tracking**, **route planning**, **Waze police/camera alert scraping**, a **curated NZ police-station database**, **viewport-driven OSM layers**, **LLM integration** (Gemini + Ollama), and a **SurveillanceMap Foundation** CCTV pipeline. It also replicates two prior High-severity process-management issues into the new backend forking subsystem.

### Test Results
- **91 passed**, **1 failed** (`tests/nz-police-database.test.mjs:82` — test drift: expects `curatedPoliceWithin` but the route uses `curatedPoliceAll` + `isWithinCuratedCoverage`).
- All 91 passing tests indicate the new features (Waze alerts, police DB, surveillance foundation, intel framework, route planning) are wired and functional at the unit level.

### Top 15 Issues by Impact

| # | Severity | Domain | Issue | File(s) |
|---|----------|--------|-------|---------|
| 1 | **Critical** | API | Rate-limit pruning bug in `ai/analyze` and `ai/briefing` wipes the entire map when size exceeds threshold, disabling rate limits entirely. | `ai/analyze/route.ts`, `ai/briefing/route.ts` |
| 2 | **Critical** | API | `region=all` CCTV fanout resolves to 27 fetchers (150s worst-case) and `continent=europe` to 15 fetchers (75s), exceeding Next.js default timeouts. | `cctv/route.ts` |
| 3 | **Critical** | API | Stats aggregator reads `weather_events` from weather API, but weather API returns key `events`, so weather stats are permanently zero. | `stats/route.ts` |
| 4 | **Critical** | Frontend | `activeLayers.conflict_zones` is not in `DEFAULT_ACTIVE_LAYERS`, so `undefined !== false` is `true`, making the conflict layer permanently visible and uncontrollable. | `components/HorusMap.tsx`, `app/page.tsx` |
| 5 | **Critical** | Core | `validateBbox` in Waze alerts rejects `west > east` (antimeridian crossing), breaking all Pacific coverage (Fiji, Chatham Islands, eastern Russia, Alaska). | `traffic-alerts/bbox.ts` |
| 6 | **High** | Frontend | `HorusMap` is a 1,620-line god component; `page.tsx` is a 1,622-line god component. Both are untestable in isolation and any change risks cascading regressions. | `components/HorusMap.tsx`, `app/page.tsx` |
| 7 | **High** | Core | Viewport-driven fetches pass no `AbortSignal`; rapid pan/zoom leaves in-flight requests running, causing race conditions and connection pool exhaustion. | `registry/useViewportLayers.ts`, `lib/geo.ts` |
| 8 | **High** | Desktop | SMOKE timeout race: `smokeTimeout` is never cleared on success, so delayed `app.quit()` can overwrite the OK marker with `TIMEOUT`, causing false-negative CI failures. | `desktop/main.js` |
| 9 | **High** | Desktop | New backend forking subsystem (`stopManagedBackends`) calls `child.kill()` with no `SIGKILL` fallback — a hung scanner/intel child becomes a zombie. | `desktop/main.js` |
| 10 | **High** | Desktop | `server.log` unbounded growth still present from prior review; backend logs (`${state.id}.log`) replicate the same anti-pattern. | `desktop/main.js` |
| 11 | **High** | API | Expensive endpoints (`cctv`, `flights`, `markets`, `maritime`, `news`) have no rate limiting, making them susceptible to abuse and downstream bans. | Multiple routes |
| 12 | **High** | Core | No caching on expensive external ops: geocoding (Nominatim), routing (OSRM), Overpass queries, and LLM synthesis hit the network every time. | `geocode.ts`, `routing.ts`, `overpass.ts`, `llm/index.ts` |
| 13 | **High** | Core | `registry/events.ts` `listeners` is a raw `Set` with no max size — a buggy plugin can grow memory without bound. | `registry/events.ts` |
| 14 | **High** | Core | `intel/compile.ts` `abortable()` races with `Promise.race` but does not cancel the underlying promise; work continues as a zombie after timeout. | `intel/compile.ts` |
| 15 | **High** | API | Response body leaks in multiple OSINT routes (`threats`, `whois`, `bgp`, `sentinel`) where failed fetch bodies are never consumed, risking undici socket exhaustion. | Multiple routes |

---

## Prior Issue Verification (from `STABILITY_REVIEW.md`)

| # | Severity | File | Prior Issue | Status |
|---|----------|------|-------------|--------|
| 1 | **Critical** | `desktop/main.js:26` | `serverRestartAttempts` never reset → after 3 crashes, app never restarts server. | ✅ **FIXED** — `armServerStableReset()` resets after 5 min. |
| 2 | **Critical** | `intel/server.js:895` | `setInterval` for sanctions refresh never cleared during shutdown. | ✅ **FIXED** — stored and cleared in `shutdown()`. |
| 3 | **High** | `desktop/main.js:245,249` | `render-process-gone`/`crashed` reload indefinitely without backoff. | ✅ **FIXED** — `scheduleRendererReload()` caps at 5 with exponential backoff. |
| 4 | **High** | `desktop/main.js:165` | `server.log` unbounded growth, no rotation. | 🔴 **STILL PRESENT** — still opens in append mode with no rotation. |
| 5 | **High** | `desktop/main.js:64` | `writeSettingsFile` no atomic write (temp+rename). | ✅ **FIXED** — writes to `.tmp` then `renameSync()`. |
| 6 | **High** | `desktop/main.js:113` | `serverChild.kill()` no SIGKILL fallback. | 🔴 **STILL PRESENT** — no timeout or SIGKILL fallback. |
| 7 | **High** | `scanner/server.js:234` | `httpHeaders` never consumes response body (socket leak). | ✅ **FIXED** — calls `await res.body?.cancel()`. |
| 8 | **High** | `scanner/server.js:272` | `subdomains` uses `encodeURIComponent('%.${domain}')` with literal single quotes. | ✅ **FIXED** — uses `encodeURIComponent('%.' + domain)`. |

**Grade:** 5 of 8 fixed (62.5%). The 3 remaining issues are process-management and logging anti-patterns that have now been **replicated** into the new backend forking subsystem.

---

## 🔴 Critical Issues

### C1 — Rate-limit pruning bug wipes entire map
| | |
|---|---|
| **File** | `src/app/api/ai/analyze/route.ts`, `src/app/api/ai/briefing/route.ts` |
| **Line** | ~38–44 |
| **Description** | `pruneRateLimitMap()` checks `rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES` inside the loop. Once true, every entry matches the condition and the entire map is deleted. |
| **Impact** | Rate limits are bypassed entirely when the map grows past the threshold. |
| **Fix** | Only evict expired entries or the oldest N entries until size is under the limit. |

### C2 — CCTV `region=all` / `continent=europe` exceeds Next.js timeout
| | |
|---|---|
| **File** | `src/app/api/cctv/route.ts` |
| **Line** | ~636–641, ~544–554 |
| **Description** | `region=all` resolves to 27 region fetchers; `continent=europe` to 15. With `MAX_REGION_ALL_CONCURRENCY = 5` and 25s timeout per batch, worst-case is 150s / 75s. |
| **Impact** | Requests hang and timeout, wasting server resources and leaving downstream fetches orphaned. |
| **Fix** | Add `export const maxDuration = 60` to the route; cap `region=all` to a safe subset or reject it; reduce per-batch timeout. |

### C3 — Stats route reads wrong key, weather stats permanently zero
| | |
|---|---|
| **File** | `src/app/api/stats/route.ts` |
| **Line** | ~84 |
| **Description** | Reads `data?.weather_events?.length` but `weather/route.ts` returns key `events`. |
| **Impact** | Weather stats are permanently reported as `0`, silently breaking dashboard aggregation. |
| **Fix** | Change `weather_events` to `events`. |

### C4 — Scanner route parses JSON without checking `res.ok`
| | |
|---|---|
| **File** | `src/app/api/scanner/route.ts` |
| **Line** | ~120 |
| **Description** | `const data = await res.json();` is called without checking `res.ok`. If scanner returns non-JSON error body, `res.json()` throws unhandled parse error. |
| **Impact** | Unnecessary 500s instead of clean passthrough; response body may not be released. |
| **Fix** | Check `res.ok` first; consume/release body if not ok before throwing. |

### C5 — OSINT threats route leaks first response body on fallback
| | |
|---|---|
| **File** | `src/app/api/osint/threats/route.ts` |
| **Line** | ~46 |
| **Description** | When first AlienVault OTX fetch fails (`!res.ok`), code falls back to activity feed but never consumes the first response body. |
| **Impact** | Undici socket leak; exhausted connection pool under load. |
| **Fix** | Add `await releaseResponseBody(res)` before the fallback fetch. |

### C6 — `conflict_zones` layer permanently visible
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx`, `src/app/page.tsx` |
| **Line** | ~1380 (HorusMap), ~DEFAULT_ACTIVE_LAYERS (page.tsx) |
| **Description** | `activeLayers.conflict_zones` is not in `DEFAULT_ACTIVE_LAYERS`, so it defaults to `undefined`. `setVis(['conflict-icons'], activeLayers.conflict_zones !== false)` evaluates to `true` permanently. |
| **Impact** | User cannot hide conflict zone icons. |
| **Fix** | Add `conflict_zones: false` to `DEFAULT_ACTIVE_LAYERS`, or change visibility check to `!!activeLayers.conflict_zones`. |

### C7 — Antimeridian blindness in Waze bbox validator
| | |
|---|---|
| **File** | `src/lib/traffic-alerts/bbox.ts` |
| **Line** | ~21 |
| **Description** | `validateBbox` rejects `west >= east`, which breaks all antimeridian-crossing bboxes (Fiji, Chatham Islands, eastern Russia, Alaska). |
| **Impact** | Waze scraping completely fails for any region spanning 180°. No Pacific coverage. |
| **Fix** | Relax validation for antimeridian boxes (`w > e` is valid); split into two non-crossing bboxes for downstream APIs. |

### C8 — `internet_outages` dead layer reference
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1359 |
| **Description** | `activeLayers.internet_outages` is referenced in the malware visibility effect but does not exist in `DEFAULT_ACTIVE_LAYERS`. |
| **Impact** | Dead code / confusion; the `internet_outages` branch is always `undefined` (falsy), so visibility is silently controlled by `malware` only. |
| **Fix** | Remove `internet_outages` from the expression or add it to `DEFAULT_ACTIVE_LAYERS` with a toggle. |

---

## 🟠 High Issues

### H1 — Frontend god components (HorusMap & page.tsx)
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx`, `src/app/page.tsx` |
| **Line** | ~1–1620 (HorusMap), ~187–1622 (page.tsx) |
| **Description** | `HorusMap` initializes MapLibre, registers 20+ builtin layers, handles all popups, manages dynamic plugin layers, drives dossier/route overlays, sweep viz, scan targets, theme switching, projection changes, and style toggling. `page.tsx` holds ~50 state variables, manages all data fetching, workspace logic, plugin host services, global keyboard shortcuts, and layout. |
| **Impact** | Impossible to unit-test in isolation; any change can ripple unpredictably; state changes cascade globally. |
| **Fix** | Extract at minimum: (a) Map initialization & lifecycle, (b) Popup content factory, (c) Dynamic layer manager, (d) Overlay renderer, (e) Data orchestrator hook, (f) Workspace manager, (g) Keyboard shortcut provider. |

### H2 — `memo(HorusMap)` is ineffective
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1620 |
| **Description** | `data`, `activeLayers`, `flyToLocation`, `dossierOverlay`, `routeOverlay`, and `userPosition` all change frequently, causing shallow comparison to always fail. |
| **Impact** | `memo` adds comparison cost with zero benefit. |
| **Fix** | Remove `memo` or use `React.memo` with a deep-equality comparator for `data` and `activeLayers` only. |

### H3 — `dataRef` mutation during render phase
| | |
|---|---|
| **File** | `src/app/page.tsx` |
| **Line** | ~190–191 |
| **Description** | `const dataRef = useRef<...>({}); dataRef.current = data;` mutates a ref during render. |
| **Impact** | In React StrictMode or concurrent rendering, can produce torn reads if a child or plugin reads the ref during a concurrent render. |
| **Fix** | Move the sync into `useLayoutEffect(() => { dataRef.current = data; }, [data]);`. |

### H4 — No `map.on('error')` handler
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~187, ~1063, ~1593 |
| **Description** | MapLibre tile load failures, style errors, or WebGL context issues are not surfaced to the user or caught for graceful fallback. |
| **Impact** | User sees a blank or broken map with no feedback or retry path. |
| **Fix** | Add `map.on('error', (e) => { ... })` at init; for style errors, surface a "Map failed to load" fallback UI. |

### H5 — `addRegistryLayer` and satellite style switch lack `isStyleLoaded()` guards
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1083, ~1596 |
| **Description** | Dynamic layer registration and satellite raster layer are added in effects without `map.isStyleLoaded()` guards. |
| **Impact** | If style is being reloaded or changed, `addSource`/`addLayer` can throw. |
| **Fix** | Wrap in `if (map.isStyleLoaded()) { ... }`. For satellite style, wait for `map.on('style.load')`. |

### H6 — Viewport fetches have no AbortController cancellation
| | |
|---|---|
| **File** | `src/lib/registry/useViewportLayers.ts`, `src/lib/geo.ts` |
| **Line** | ~52–98 (useViewportLayers), ~222–248 (geo.ts) |
| **Description** | Viewport-driven fetches use `fetchEndpoint` which has a 30s timeout but no external `AbortController`. Rapid panning queues overlapping Overpass requests. |
| **Impact** | Race conditions (stale data overwrites fresh), wasted bandwidth, browser connection pool exhaustion. |
| **Fix** | Pass an `AbortController.signal` through `fetchEndpoint`; abort previous request before starting new debounced one. Also detect antimeridian boxes in `tileBbox` and split before querying Overpass. |

### H7 — Missing rate limiting on expensive endpoints
| | |
|---|---|
| **File** | `src/app/api/cctv/route.ts`, `flights/route.ts`, `markets/route.ts`, `maritime/route.ts`, `news/route.ts`, and 10+ others |
| **Line** | Various |
| **Description** | Only ~half of external-data routes implement rate limiting. Expensive endpoints that spawn parallel upstream fetches lack guards entirely. |
| **Impact** | Easy DoS target; can trigger downstream API bans and exhaust server CPU. |
| **Fix** | Reuse `getClientIp` / `isRateLimited` pattern from `waze-alerts` across all external-data routes. |

### H8 — Response body leaks in OSINT routes
| | |
|---|---|
| **File** | `src/app/api/osint/whois/route.ts`, `bgp/route.ts`, `sentinel/route.ts` |
| **Line** | Various (~30, ~54, ~28, ~51, ~75) |
| **Description** | Routes check `res.ok` but do not release the body when the response is not OK. |
| **Impact** | Undici socket leak under repeated failure; up to 3 sockets per failed ASN lookup. |
| **Fix** | Add `await releaseResponseBody(res)` in every `else` branch after `!res.ok`. |

### H9 — Error masking vs. leakage
| | |
|---|---|
| **File** | `src/app/api/waze-alerts/route.ts`, `surveillance/route.ts`, `route/route.ts`, `scanner/route.ts`, `osint/github/route.ts` |
| **Line** | Various |
| **Description** | `waze-alerts` and `surveillance` return HTTP 200 for failures. `route`, `scanner`, and `github` leak raw `e.message` to client. |
| **Impact** | Clients treat failures as success; or internal URLs/stack traces leak to client. |
| **Fix** | Return appropriate HTTP status (4xx/5xx) with generic safe message; log full error server-side. |

### H10 — No caching on expensive external ops
| | |
|---|---|
| **File** | `src/lib/geocode.ts`, `routing.ts`, `overpass.ts`, `llm/index.ts` |
| **Line** | Various |
| **Description** | Geocoding (Nominatim), routing (OSRM), Overpass queries, and LLM synthesis have no cache. Repeated identical operations hit the network every time. |
| **Impact** | Unnecessary latency, rate-limit risk, redundant network load, wasted GPU/cloud tokens. |
| **Fix** | Add bounded LRU caches with TTL (geocode: 5–10 min, route: 5 min, Overpass: 30–60 s, LLM: 2–5 min). |

### H11 — Unbounded registry event bus
| | |
|---|---|
| **File** | `src/lib/registry/events.ts` |
| **Line** | ~6 |
| **Description** | `listeners` is a raw `Set` with no maximum size. |
| **Impact** | A buggy/malicious plugin or rapid component mount/unmount can grow memory without bound. |
| **Fix** | Cap listeners (e.g., 500–1000) and evict oldest; or use WeakRef-based pub/sub for React consumers. |

### H12 — Zombie async promises after timeout
| | |
|---|---|
| **File** | `src/lib/intel/compile.ts`, `ai-engine.ts` |
| **Line** | ~106–121 (compile.ts), ~24–58 (ai-engine.ts) |
| **Description** | `abortable()` and `withTimeout` use `Promise.race` but do not cancel the underlying promise. If the provider ignores the signal, work continues as a zombie. |
| **Impact** | Wasted CPU/network after timeout; leaked provider state for non-abortable LLMs. |
| **Fix** | Wrap provider calls in a helper that explicitly cancels the underlying fetch/LLM request when the race rejects. Verify Gemini SDK supports `AbortSignal` fully. |

### H13 — Entity ID collisions in Polybolos SDK
| | |
|---|---|
| **File** | `src/lib/sdk/PolybolosClient.ts` |
| **Line** | ~39–61 |
| **Description** | Entity translators fall back to `stableIdFragment({lat, lng, ...})` when primary IDs are missing. Two distinct objects with identical coordinates collide in the `entityStore`. |
| **Impact** | Silent data loss — e.g., two aircraft on the ground at the same airport overwrite each other. |
| **Fix** | Include a random nonce or timestamp in the fallback hash, or use a collision-aware store (array per ID). |

### H14 — SMOKE timeout race
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~518–524 |
| **Description** | `smokeTimeout` is never cleared when `did-finish-load` succeeds. If `app.quit()` is delayed, the 50s timeout fires and overwrites the smoke file with `TIMEOUT`. |
| **Impact** | False-negative smoke tests; CI instability. |
| **Fix** | Clear `smokeTimeout` in the `did-finish-load` handler before calling `app.quit()`. |

### H15 — Backend child SIGKILL missing
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~290–298 |
| **Description** | `stopManagedBackends()` calls `state.child.kill()` with no timeout or `SIGKILL` fallback. |
| **Impact** | Hung scanner/intel backend children become zombies; repeated restarts accumulate orphan Node processes. |
| **Fix** | Send `SIGTERM`, then `setTimeout(() => state.child.kill('SIGKILL'), 5000)`. |

### H16 — Backend log unbounded growth
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~192–200 |
| **Description** | Backend log files (`${state.id}.log`) are opened with `fs.openSync(logPath, 'a')` on every backend fork but never rotated or truncated. |
| **Impact** | Same unbounded disk growth as `server.log`; eventually fills disk. |
| **Fix** | Implement log rotation (rename when size exceeds threshold) or use a rotating file stream. |

### H17 — Embedded server SIGKILL still missing (prior issue 6)
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~319–323 |
| **Description** | `stopEmbeddedServer()` still calls `serverChild.kill()` with no `SIGKILL` fallback or timeout. |
| **Impact** | Hung Next server child becomes a zombie. |
| **Fix** | `serverChild.kill('SIGTERM'); setTimeout(() => serverChild?.kill('SIGKILL'), 5000);` |

### H18 — server.log unbounded growth still present (prior issue 4)
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~389–391 |
| **Description** | `server.log` is still opened in append mode on every embedded server start with no rotation or truncation. |
| **Impact** | Unbounded disk growth; prior issue 4 remains unfixed. |
| **Fix** | Add rotation logic or cap the file size. |

### H19 — SDK ingester interval leak
| | |
|---|---|
| **File** | `scripts/sdk_ingester.js` |
| **Line** | ~178–179 |
| **Description** | `setInterval(runIngestCycle, 10000)` handle is never stored or cleared. No `SIGTERM`/`SIGINT` handlers. |
| **Impact** | Process hangs on shutdown signals; container orchestrators may force-kill after timeout. |
| **Fix** | Store the interval handle and add signal handlers that call `clearInterval`. |

### H20 — Waze browser transport has no size limit before JSON.parse
| | |
|---|---|
| **File** | `src/lib/traffic-alerts/waze.ts` |
| **Line** | ~242 |
| **Description** | `JSON.parse(result.text)` in the browser transport has no size limit before parsing. |
| **Impact** | A massive Waze response can OOM the renderer or crash the parse step. |
| **Fix** | Check `result.text.length` against a safe cap (e.g., 5 MB) before `JSON.parse`. |

### H21 — `stealthFetch` dead code
| | |
|---|---|
| **File** | `src/lib/stealthFetch.ts` |
| **Line** | ~74 |
| **Description** | `generateResidentialIP()` is called but the `ip` is never used in returned headers. |
| **Impact** | The "residential IP spoofing" feature is completely non-functional; misleading dead code. |
| **Fix** | Either inject the IP into a header (e.g., `X-Forwarded-For`) or remove the dead generator. |

### H22 — Overpass tile queries have no cache
| | |
|---|---|
| **File** | `src/lib/overpass.ts` |
| **Line** | ~81–139 |
| **Description** | `runOverpassLayer` has no cache on Overpass responses. Panning back to a previously viewed viewport re-fetches identical data. |
| **Impact** | Wasted bandwidth; slower map re-renders; unnecessary load on public Overpass endpoint. |
| **Fix** | Add a short-lived LRU cache (e.g., 30–60 s) keyed by `stableHash(query)`. |

### H23 — Gemini API key rotation races
| | |
|---|---|
| **File** | `src/lib/llm/gemini-adapter.ts` |
| **Line** | ~26–57 |
| **Description** | `rotateApiKey` mutates `_keyIndex` without any concurrency guard. Concurrent `geminiChat` calls can race and reuse the same key. |
| **Impact** | Key rotation is ineffective under load; may hit per-key rate limits faster. |
| **Fix** | Use an atomic counter or a queue-based rotation strategy. |

### H24 — Registry engine signature mismatches cause unnecessary teardowns
| | |
|---|---|
| **File** | `src/lib/registry/engine.ts` |
| **Line** | ~31–40 |
| **Description** | `getFeedSignature` uses a `WeakMap` on function references. Custom-source transforms are recreated on each `buildCustomSource`, causing signature mismatches. |
| **Impact** | Extra CPU/work registering/unregistering feeds that have not actually changed. |
| **Fix** | Normalize the signature by hashing the function body string or using a stable function reference from a module scope. |

---

## 🟡 Medium Issues

### M1 — CameraViewer HLS re-initialization on parent re-render
| | |
|---|---|
| **File** | `src/components/CameraViewer.tsx` |
| **Line** | ~43–118 |
| **Description** | `streamType` and `externalOnly` are derived from `camera` on every render and used as `useEffect` dependencies. Parent re-renders with a new `camera` reference cause unnecessary HLS teardown/rebuild. |
| **Fix** | Memoize `streamType` and `externalOnly` with `useMemo`, or compute them inside the effect. |

### M2 — `getWorkspaceSnapshot` callback identity changes on every UI interaction
| | |
|---|---|
| **File** | `src/app/page.tsx` |
| **Line** | ~273–322 |
| **Description** | Large dependency array includes `showLayers`, `showMarkets`, etc., causing callback identity changes on every UI interaction. `SettingsPanel` (which is `memo`'d) re-renders on every unrelated state change. |
| **Fix** | Use `useRef` for the mutable UI state and read from the ref in the callback, or use `useCallback` with a ref-based getter. |

### M3 — `renderStructuredResults` unmemoized in OsintPanel
| | |
|---|---|
| **File** | `src/components/OsintPanel.tsx` |
| **Line** | ~347–710 |
| **Description** | `renderStructuredResults`, `renderFallback`, and `renderFallbackExcluding` are large inline functions called during render without memoization. |
| **Impact** | Re-computes the entire results tree on every render, including panel animations. |
| **Fix** | Memoize with `useMemo` keyed on `results` and `activeTab`. |

### M4 — `fetchEndpoint` doesn't accept external abort signal
| | |
|---|---|
| **File** | `src/app/page.tsx` |
| **Line** | ~710–740 |
| **Description** | `fetchEndpoint` creates its own `AbortController` internally; callers cannot cancel in-flight requests. |
| **Impact** | Unmounting or rapid state changes don't abort pending fetches. |
| **Fix** | Accept an optional `signal` in `options` and link it to the internal controller. |

### M5 — Map cleanup order is fragile
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1126–1141 |
| **Description** | `dynState` cleanup effect checks `mapRef.current`. If the map creation effect's cleanup runs first (nulling `mapRef.current`), `dynState` teardown may skip. |
| **Impact** | On unmount, if cleanup order is reversed, `dynState.current` Map may retain stale layer metadata. |
| **Fix** | Capture `mapRef.current` into a local `const` inside the cleanup effect. |

### M6 — Dynamic layer effect re-renders ALL layers on ANY data change
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1150–1155 |
| **Description** | `useEffect([mapReady, registryVersion, data, activeLayers, setGeo])` re-renders ALL dynamic layers on ANY `data` change. |
| **Impact** | `data` is a single object; any bucket update triggers this effect. |
| **Fix** | Split into per-bucket effects, or use `Object.is` / deep comparison to skip unchanged buckets. |

### M7 — Visibility effect calls `setVis` for ~40 layer groups on every change
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1351–1391 |
| **Description** | Visibility `useEffect` has a massive dependency array and calls `setVis` for ~40 layer groups on every `activeLayers` change. |
| **Impact** | O(n) layer visibility calls where n is the number of groups. |
| **Fix** | Use a diffing approach: compare prev `activeLayers` to current and only call `setVis` for changed keys. |

### M8 — Theme effect recreates all canvas icons synchronously
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1167–1237 |
| **Description** | Theme effect recreates all canvas icons on every theme switch via `updateImage`. |
| **Impact** | ~12 icon updates in a single synchronous block. |
| **Fix** | Batch icon updates into a single `requestAnimationFrame` or use MapLibre sprite sheets. |

### M9 — `map.remove()` not wrapped in try/catch
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~1008 |
| **Description** | `map.remove()` in cleanup is not wrapped in `try/catch`. |
| **Impact** | If MapLibre is in a bad state, `remove()` may throw, preventing `mapRef.current = null`. |
| **Fix** | Wrap `map.remove()` in `try/catch`. |

### M10 — Unsafe `as` assertions on MapLibre features
| | |
|---|---|
| **File** | `src/components/HorusMap.tsx` |
| **Line** | ~773, ~814, ~1000+ |
| **Description** | Many click handlers cast `e.features[0].properties as any` and `geometry as any`. |
| **Impact** | `any` masks potential runtime errors if MapLibre returns features without properties. |
| **Fix** | Use strict typed interfaces for feature properties, or at least `unknown` with runtime guards. |

### M11 — `data` state is a single `Record<string, any>` blob
| | |
|---|---|
| **File** | `src/app/page.tsx` |
| **Line** | ~189 |
| **Description** | `data` state is a single `Record<string, any>` blob. Every bucket update spreads the entire object. |
| **Impact** | `HorusMap` re-renders because `data` prop reference changes. |
| **Fix** | Use a context or split `data` into per-bucket states, or use `useMemo` for the `data` prop. |

### M12 — `intel/compile/route.ts` hangs if client never aborts
| | |
|---|---|
| **File** | `src/app/api/intel/compile/route.ts` |
| **Line** | ~58, ~83 |
| **Description** | `compile()` is awaited with only `req.signal` as a timeout mechanism. If the client never aborts, the call can hang indefinitely. |
| **Impact** | Hanging requests tie up server workers and eventually hit the route timeout. |
| **Fix** | Pass an explicit `AbortSignal` with a hard deadline (e.g., 45s) and race it against `req.signal`. |

### M13 — Sentinel route leaks response bodies on non-OK
| | |
|---|---|
| **File** | `src/app/api/sentinel/route.ts` |
| **Line** | ~28, ~51, ~75 |
| **Description** | Three upstream fetches (Earth Search v1, v2, Copernicus) check `res.ok` but do not release the body when the response is not OK. |
| **Fix** | Add `await releaseResponseBody(res)` in each `else` branch. |

### M14 — Police route uses unsafe `as` assertions on external OSM data
| | |
|---|---|
| **File** | `src/app/api/police/route.ts` |
| **Line** | ~45–46 |
| **Description** | `const lat = el.lat as number; const lng = el.lon as number;` — unsafe `as` assertions on external OSM data. |
| **Impact** | Can produce `NaN` coordinates that break map rendering or clustering. |
| **Fix** | Validate with `Number.isFinite` before asserting; filter out invalid nodes. |

### M15 — CCTV Australia unsafe `as` assertions on coordinates
| | |
|---|---|
| **File** | `src/app/api/cctv/australia.ts` |
| **Line** | ~37–38 |
| **Description** | `lat: lat as number, lng: lng as number` on NSW GeoJSON coordinates. |
| **Fix** | Validate with `Number.isFinite` before pushing. |

### M16 — Region dossier uses `any` for external API responses
| | |
|---|---|
| **File** | `src/app/api/region-dossier/route.ts` |
| **Line** | ~33, ~143 |
| **Description** | `let locationInfo: any = {}` and `([code, info]: [string, any])` mask missing validation on RestCountries and Nominatim responses. |
| **Fix** | Replace `any` with strict interfaces; validate fields before use. |

### M17 — CCTV route has no per-source cap before final merge
| | |
|---|---|
| **File** | `src/app/api/cctv/route.ts` |
| **Line** | ~649 |
| **Description** | Individual source fetchers have no per-source cap before the final `MAX_CAMERAS` merge. |
| **Impact** | A single flaky source returning thousands of items wastes memory and CPU. |
| **Fix** | Add a `maxResults` parameter to each fetcher and slice early. |

### M18 — Settings mutation before persistence succeeds
| | |
|---|---|
| **File** | `src/lib/settings/index.ts` |
| **Line** | ~208–219 |
| **Description** | `updateSettings` mutates `current` in memory before persistence succeeds. If `localStorage` or the desktop bridge throws, state is inconsistent. |
| **Fix** | Move `current = deepMerge(current, patch)` after a successful persistence call, or roll back on failure. |

### M19 — Sanctions CSV parser ignores standalone `\r`
| | |
|---|---|
| **File** | `src/lib/sanctions.ts` |
| **Line** | ~76–115 |
| **Description** | `parseCsv` treats `\r` as ignored noise, relying on a following `\n`. Does not handle legacy `\r`-only line endings. |
| **Fix** | Treat standalone `\r` as a row terminator. |

### M20 — Address intel fetches 20 Mapillary photos but only keeps 8
| | |
|---|---|
| **File** | `src/lib/intel/providers/address.ts` |
| **Line** | ~135–176 |
| **Description** | `fetchPhotos` requests `limit=20` from Mapillary but only keeps 8. |
| **Fix** | Reduce the API limit to 10–12 or match `MAX_PHOTOS`. |

### M21 — Solar terminator uses local timezone for day-of-year
| | |
|---|---|
| **File** | `src/lib/registry/builtins.ts` |
| **Line** | ~53–55 |
| **Description** | `computeSolarTerminatorRaw` computes day-of-year using `new Date(year, 0, 0)` which is in local timezone, not UTC. |
| **Impact** | Terminator polygon may be offset by up to ~12 hours depending on server timezone. |
| **Fix** | Use UTC-based day-of-year calculation. |

### M22 — Waze alert array has no hard cap before deduplication
| | |
|---|---|
| **File** | `src/lib/traffic-alerts/waze.ts` |
| **Line** | ~30–47 |
| **Description** | `scrapeWazePoliceCameraAlerts` builds an `alerts` array that grows with every tile before deduplication. No hard cap on raw items. |
| **Fix** | Cap `alerts.length` during tile processing (e.g., stop accepting after 10,000 raw alerts). |

### M23 — Plugin loader lacks per-plugin lock on toggle
| | |
|---|---|
| **File** | `src/lib/plugins/loader.ts` |
| **Line** | ~99–112 |
| **Description** | `setPluginEnabled` does not use `withPluginLock`; rapid toggles can interleave `teardown` and `activate`. |
| **Fix** | Wrap `setPluginEnabled` in the same per-plugin lock used by `installPlugin`. |

### M24 — Map engine adds plugin layers without validation
| | |
|---|---|
| **File** | `src/lib/registry/mapEngine.ts` |
| **Line** | ~74–78 |
| **Description** | `map.addLayer(spec as any)` casts plugin-provided style layers to `any`. A malformed plugin layer can crash MapLibre. |
| **Fix** | Add runtime validation of `spec` before `addLayer` (or at least a `try/catch` around the add). |

### M25 — Curated police fetch is fire-and-forget with no signal
| | |
|---|---|
| **File** | `src/lib/registry/useViewportLayers.ts` |
| **Line** | ~65–69 |
| **Description** | Curated police fetch is fire-and-forget with no signal or error boundary. |
| **Fix** | Wrap in an abortable fetch and handle timeouts explicitly. |

### M26 — Rate limit cleanup only triggers on new insert
| | |
|---|---|
| **File** | `src/lib/ssrf-guard.ts` |
| **Line** | ~269–280 |
| **Description** | `isRateLimited` cleanup only triggers when a new IP is inserted. If the map is idle, stale entries persist indefinitely. |
| **Fix** | Add a periodic background cleanup or use a time-to-live heap. |

### M27 — Overpass bbox area check is in degrees², not km²
| | |
|---|---|
| **File** | `src/lib/overpass.ts` |
| **Line** | ~48–51 |
| **Description** | `parseBboxParam` area check is in degrees², not km². High-latitude regions get a smaller physical query window than equatorial ones. |
| **Fix** | Convert area to a physical metric (e.g., km²) using latitude before validating. |

### M28 — Desktop `ready-to-show` still lacks `isDestroyed()` guard
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~475 |
| **Description** | `win.once('ready-to-show', () => win.show())` still lacks an `isDestroyed()` guard. |
| **Impact** | If the window is destroyed before the event fires, `win.show()` throws "Object has been destroyed". |
| **Fix** | Guard with `if (win && !win.isDestroyed()) win.show();`. |

### M29 — TLS socket lingering (prior Medium, still present)
| | |
|---|---|
| **File** | `scanner/server.js` |
| **Line** | ~187–214 |
| **Description** | `tlsInfo` success path calls `sock.end()` but never `sock.destroy()`. |
| **Fix** | Call `sock.destroy()` after `resolve()` in the success path. |

### M30 — Yente health check body leak (prior Medium, still present)
| | |
|---|---|
| **File** | `intel/server.js` |
| **Line** | ~186–200 |
| **Description** | `isYenteAvailable` fetches `/healthz` but never consumes the response body. |
| **Fix** | Add `await res.body?.cancel?.()` or `await res.text()` before returning. |

### M31 — `loadSanctions` has no concurrent invocation guard (prior Medium, still present)
| | |
|---|---|
| **File** | `intel/server.js` |
| **Line** | ~101–159 |
| **Description** | `loadSanctions()` has no guard against concurrent invocation. If the 24h interval fires while a previous load is still running, two large CSV fetches run concurrently. |
| **Fix** | Add an `isLoadingSanctions` boolean lock at the top of `loadSanctions()`. |

### M32 — Script writes lack atomic temp+rename
| | |
|---|---|
| **File** | `scripts/generate_nz_police.js`, `rename_to_horus.py`, `upgrade_v5_1.js`, `upgrade_v5.js`, `patch_map_cables.js` |
| **Line** | Various |
| **Description** | Multiple scripts write files directly without atomic temp+rename; interruption corrupts the file. |
| **Fix** | Use temp-file + rename pattern for all build/generator scripts. |

### M33 — `ipcMain.handle('horus:relaunch')` order can cause double-start
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~559 |
| **Description** | `app.relaunch()` then `app.quit()` — on macOS, `app.quit()` can be blocked by `before-quit` handlers; if blocked, `relaunch()` has already queued a relaunch. |
| **Fix** | Reverse order: `app.quit(); app.relaunch();` or use `app.on('will-quit')`. |

### M34 — `before-quit` doesn't wait for child to exit
| | |
|---|---|
| **File** | `desktop/main.js` |
| **Line** | ~598 |
| **Description** | `app.on('before-quit', ...)` calls `stopEmbeddedServer()` but doesn't wait for the child to exit. |
| **Fix** | `event.preventDefault()` + wait for child `exit` before calling `app.quit()`. |

---

## 🟢 Low Issues

| # | File | Line | Description | Fix |
|---|------|------|-------------|-----|
| L1 | `src/components/IntelFeed.tsx` | ~31–43 | `timeAgo` doesn't guard against future dates or `NaN` diff. | Add `if (diff < 0) return 'just now';` |
| L2 | `src/app/page.tsx` | ~1143 | `mapStyle` prop receives raw tile URL; internal logic assumes `'dark' \| 'satellite'`. | Keep enum internally and translate URL inside `HorusMap`. |
| L3 | `src/components/HorusMap.tsx` | ~1450–1465 | IP sweep effect uses `setTimeout` chains; `batchTimers` array is declared inside effect but cleanup only iterates it. If effect re-runs before first `setTimeout` fires, old array is lost. | Use a ref for `batchTimers`. |
| L4 | `src/components/SharePanel.tsx` | ~62–69 | Keyboard shortcut `e.key === 's'` doesn't prevent default, may trigger browser "Save". | Add `e.preventDefault()`. |
| L5 | `src/components/AiAnalyst.tsx` | ~236–243 | `getHeaders` reads `localStorage` synchronously on every message send. | Read the key once in `useEffect` and store in a ref. |
| L6 | `src/components/HorusMap.tsx` | ~1353–1380 | `war_alerts` is in `DEFAULT_ACTIVE_LAYERS` as `false` but never referenced in visibility effect. | Either wire it to a layer or remove it from defaults. |
| L7 | `src/components/CameraViewer.tsx` | ~121–125 | JPG auto-refresh interval uses `camera?.feed_url` as dependency. If `camera` becomes null, interval is not cleaned up until unmount. | Add `enabled` guard inside effect body. |
| L8 | `src/components/EntityGraphPanel.tsx` | ~58–87 | `graphRef` is typed as `any` and never used. | Remove unused `graphRef` or type it with `ForceGraphMethods`. |
| L9 | `src/lib/intel/types.ts` | ~114 | `geometry?: unknown` is too weak. | Tighten to `GeoJSON.Geometry \| GeoJSON.FeatureCollection`. |
| L10 | `src/lib/bulgaria-sources.ts` | ~20 | `DEFAULT_MAP_CENTER: [number, number]` is ambiguous about order. | Rename to `DEFAULT_MAP_CENTER_LNG_LAT` or add JSDoc. |
| L11 | `src/lib/registry/builtins.ts` | ~102 | `flightFeatures` uses `any` throughout. | Define a minimal `FlightRecord` interface. |
| L12 | `src/lib/http-utils.ts` | ~68–75 | `stableHash` uses 32-bit djb2 hash; collisions are unlikely but possible for large objects. | Consider 64-bit or crypto hash for cache keys. |
| L13 | `src/lib/geocode.ts` | ~44–58 | `mapResult` uses `d?.lat` and `d?.lon` with optional chaining; if `d` is nullish, `parseFloat(undefined)` returns `NaN`. | Add explicit `if (!d) return null;` guard. |
| L14 | `src/lib/ai-engine.ts` | ~369–391 | `analyzeIntelligence` and `generateBriefing` do not validate that `response.text()` is non-empty. | Add guard: `if (!text?.trim()) throw new Error('Empty model response')`. |
| L15 | `src/app/api/proxy-tiles/route.ts` | ~6 | No rate limiting. | Add lightweight IP-based rate limit. |
| L16 | `src/app/api/github-webhook/route.ts` | ~32 | Hardcoded Tailscale IP (`http://100.68.100.15:3005`). | Make forward URL configurable via `process.env`. |
| L17 | `src/app/api/source-test/route.ts` | ~59 | Invalid URL returns HTTP 200 with `{ ok: false, error: 'Invalid URL' }`. | Return `status: 400` for malformed input. |
| L18 | `scripts/extract_v51.js` | ~6 | `fs.readFileSync(transcriptPath, 'utf8')` with no existence check. | Add `fs.existsSync` check. |
| L19 | `scripts/extract_v51.js` | ~12 | `obj.tool_calls[0].args.CodeContent` with no null/length checks. | Guard with `obj.tool_calls?.[0]?.args?.CodeContent`. |
| L20 | `scripts/disable_sdk_links.js` | ~2–6 | `fs.readFileSync`/`writeFileSync` with no error handling. | Add `try/catch` and existence checks. |
| L21 | `package.json` | ~14 | `"dev": "pwsh -NoProfile ..."` hardcodes PowerShell. | Add cross-platform wrapper or document `dev:raw` fallback. |
| L22 | `intel/server.js` | ~27 | `PORT = process.env.INTEL_PORT || 4000` with no validation. | Parse with `parseInt` and validate `Number.isFinite`. |
| L23 | `scanner/server.js` | ~40 | `PORT = process.env.PORT || process.env.SCANNER_PORT || 7700` with no validation. | Validate port and prefer `SCANNER_PORT` only. |
| L24 | `desktop/main.js` | ~603–624 | `process.on('SIGTERM')`, `SIGINT`, `unhandledRejection`, `uncaughtException` call `app.quit()` without setting `process.exitCode`. | Set `process.exitCode = 1` in all error handlers. |
| L25 | `tests/waze-alerts.test.mjs` | ~113–134 | CLI test creates a temp directory but never deletes it. | Add `await rm(dir, { recursive: true })` in `finally`. |
| L26 | `scripts/generate_nz_police.js` | ~64–65 | Blank CSV lat/lon cells become `Number('') = 0`, which passes `Number.isFinite`, inserting bogus `0,0` coordinates. | Add explicit blank check. |
| L27 | `scripts/rename_to_horus.py` | ~54 | `subprocess.check_output(["git", "ls-files"], cwd=ROOT)` fails if not inside a Git repo. | Wrap in `try/except` and fall back to directory walk. |

---

## Cross-Cutting Patterns

### 1. Missing Response Body Consumption (Undici Socket Leaks)
A recurring pattern across OSINT and API routes: checking `res.ok` and reading the body on success, but **not** releasing the body on failure. This leaves sockets in Node.js's undici connection pool, eventually exhausting available connections.

**Affected files:** `osint/threats/route.ts`, `osint/whois/route.ts`, `osint/bgp/route.ts`, `sentinel/route.ts`, `scanner/route.ts`, `intel/server.js` (`isYenteAvailable`).

**Fix:** Add a `releaseResponseBody(res)` helper (or `await res.body?.cancel?.()`) in every `!res.ok` branch.

### 2. Missing Rate Limiting
Only ~half of external-data routes implement rate limiting. Expensive endpoints that spawn parallel upstream fetches or heavy CPU operations lack guards entirely.

**Affected files:** `cctv/route.ts`, `flights/route.ts`, `markets/route.ts`, `maritime/route.ts`, `news/route.ts`, `gdelt/route.ts`, `weather/route.ts`, `earthquakes/route.ts`, `frontlines/route.ts`, `radar/route.ts`, `satellites/route.ts`, `scm-suppliers/route.ts`, `entity/expand/route.ts`, `proxy-tiles/route.ts`, `flock/route.ts`, `mass-surveillance/route.ts`.

**Fix:** Reuse the `getClientIp` / `isRateLimited` pattern from `waze-alerts/route.ts` consistently across all external-data routes.

### 3. Error Masking vs. Error Leakage
Two opposite problems exist:
- **Masking:** `waze-alerts`, `surveillance`, `source-test` return HTTP 200 for failures.
- **Leaking:** `route`, `scanner`, `osint/github` return raw `e.message` to the client.

**Fix:** Return appropriate HTTP status (4xx/5xx) with a generic, safe message, while logging the full error server-side.

### 4. Antimeridian Blindness
Multiple geo components reject or mishandle bounding boxes that cross the 180° meridian: Waze bbox validator, Overpass tiling logic, and route buffer generation. This breaks functionality for Pacific regions, parts of New Zealand, Russia, and Alaska.

**Fix:** Relax validation for antimeridian boxes (`w > e` is valid) and split them into two non-crossing bboxes for downstream APIs that cannot handle them.

### 5. No Caching on Expensive External Operations
Geocoding, routing, Overpass queries, and LLM synthesis all lack caches. Repeated identical operations hit the network every time.

**Fix:** Add bounded LRU caches with appropriate TTLs for each domain.

### 6. Process Management Anti-Patterns Replicated
The new backend forking subsystem in `desktop/main.js` replicates the same `kill()`-without-SIGKILL-fallback and unbounded-log-growth anti-patterns that the prior review flagged for the embedded server.

**Fix:** Apply the same fixes to all child processes: SIGTERM + 5s SIGKILL fallback, and log rotation.

---

## Priority Action Plan

### Immediate (this sprint)
| # | Issue | File(s) | Est. Effort |
|---|-------|---------|-------------|
| 1 | Fix rate-limit pruning bug (C1) | `ai/analyze/route.ts`, `ai/briefing/route.ts` | 30 min |
| 2 | Fix stats route wrong key (C3) | `stats/route.ts` | 5 min |
| 3 | Fix `conflict_zones` permanently visible (C6) | `components/HorusMap.tsx`, `app/page.tsx` | 15 min |
| 4 | Fix antimeridian blindness in Waze bbox (C7) | `traffic-alerts/bbox.ts` | 1 hr |
| 5 | Add `maxDuration` to CCTV route and cap `region=all` (C2) | `cctv/route.ts` | 1 hr |
| 6 | Fix SMOKE timeout race (H14) | `desktop/main.js` | 30 min |
| 7 | Add SIGKILL fallback to backend children (H15) | `desktop/main.js` | 30 min |
| 8 | Fix scanner route JSON parse without `res.ok` (C4) | `scanner/route.ts` | 15 min |
| 9 | Fix OSINT threats response body leak (C5) | `osint/threats/route.ts` | 15 min |
| 10 | Fix test drift (`curatedPoliceWithin` vs `curatedPoliceAll`) | `tests/nz-police-database.test.mjs` | 15 min |

### Short-term (next sprint)
| # | Issue | File(s) | Est. Effort |
|---|-------|---------|-------------|
| 11 | Add `AbortController` to viewport fetches (H6) | `registry/useViewportLayers.ts`, `geo.ts` | 2 hr |
| 12 | Add `map.on('error')` handler and fallback UI (H4) | `components/HorusMap.tsx` | 1 hr |
| 13 | Add `isStyleLoaded()` guards before `addSource`/`addLayer` (H5) | `components/HorusMap.tsx` | 30 min |
| 14 | Add rate limiting to all expensive external-data routes (H7) | Multiple routes | 2–3 hr |
| 15 | Fix response body leaks across OSINT routes (H8) | `osint/whois`, `bgp`, `sentinel`, etc. | 1 hr |
| 16 | Add caching to geocode, routing, Overpass, LLM (H10) | `geocode.ts`, `routing.ts`, `overpass.ts`, `llm/index.ts` | 3–4 hr |
| 17 | Cap registry event bus listeners (H11) | `registry/events.ts` | 30 min |
| 18 | Cancel underlying promises after `Promise.race` timeout (H12) | `intel/compile.ts`, `ai-engine.ts` | 2 hr |
| 19 | Fix entity ID collisions in Polybolos SDK (H13) | `sdk/PolybolosClient.ts` | 1 hr |
| 20 | Add log rotation to `server.log` and backend logs (H16, H18) | `desktop/main.js` | 1 hr |
| 21 | Fix SDK ingester interval leak (H19) | `scripts/sdk_ingester.js` | 30 min |
| 22 | Add Waze response size cap before JSON.parse (H20) | `traffic-alerts/waze.ts` | 15 min |
| 23 | Fix error masking/leakage across routes (H9) | Multiple routes | 1 hr |
| 24 | Add atomic writes to build scripts (M32) | Multiple scripts | 1 hr |
| 25 | Fix `dataRef` mutation during render (H3) | `app/page.tsx` | 30 min |
| 26 | Fix `ready-to-show` `isDestroyed()` guard (M28) | `desktop/main.js` | 15 min |
| 27 | Fix `loadSanctions` concurrent invocation guard (M31) | `intel/server.js` | 15 min |
| 28 | Fix TLS socket lingering (M29) | `scanner/server.js` | 15 min |
| 29 | Fix Yente health check body leak (M30) | `intel/server.js` | 15 min |
| 30 | Fix `ipcMain.handle('horus:relaunch')` double-start risk (M33) | `desktop/main.js` | 15 min |
| 31 | Fix `before-quit` not waiting for child exit (M34) | `desktop/main.js` | 30 min |

### Architectural (next quarter)
| # | Issue | File(s) | Est. Effort |
|---|-------|---------|-------------|
| 32 | Decompose `HorusMap` god component (H1) | `components/HorusMap.tsx` | 2–3 days |
| 33 | Decompose `page.tsx` god component (H1) | `app/page.tsx` | 2–3 days |
| 34 | Remove or fix ineffective `memo(HorusMap)` (H2) | `components/HorusMap.tsx` | 2 hr |
| 35 | Split `data` blob into per-bucket states or context (M11) | `app/page.tsx` | 1–2 days |
| 36 | Add diffing to layer visibility effect (M7) | `components/HorusMap.tsx` | 4 hr |
| 37 | Batch icon updates into `requestAnimationFrame` (M8) | `components/HorusMap.tsx` | 2 hr |
| 38 | Split dynamic layer effect into per-bucket effects (M6) | `components/HorusMap.tsx` | 4 hr |
| 39 | Memoize `renderStructuredResults` in OsintPanel (M3) | `components/OsintPanel.tsx` | 2 hr |
| 40 | Fix `getWorkspaceSnapshot` callback churn (M2) | `app/page.tsx` | 2 hr |
| 41 | Remove or fix `stealthFetch` dead code (H21) | `stealthFetch.ts` | 30 min |
| 42 | Fix Gemini API key rotation race (H23) | `llm/gemini-adapter.ts` | 1 hr |
| 43 | Fix registry engine signature mismatches (H24) | `registry/engine.ts` | 2 hr |
| 44 | Fix solar terminator timezone bug (M21) | `registry/builtins.ts` | 1 hr |
| 45 | Fix Overpass bbox area check to use physical units (M27) | `overpass.ts` | 1 hr |
| 46 | Fix `intel/compile/route.ts` hard timeout (M12) | `intel/compile/route.ts` | 30 min |
| 47 | Add runtime validation to `map.addLayer` from plugins (M24) | `registry/mapEngine.ts` | 1 hr |
| 48 | Fix `settings/index.ts` mutation before persistence (M18) | `settings/index.ts` | 1 hr |
| 49 | Fix `isRateLimited` stale entry cleanup (M26) | `ssrf-guard.ts` | 1 hr |
| 50 | Fix CCTV per-source cap before merge (M17) | `cctv/route.ts` | 30 min |

---

## Positive Findings (Worth Noting)

- **5 of 8 prior Critical/High issues are fixed**, including the server restart counter, sanctions interval cleanup, renderer crash backoff, settings atomic write, scanner response body consumption, and subdomain URL encoding.
- **AbortController discipline** is strong in `DossierPanel`, `LocationTracker`, `SearchBar`, `AiAnalyst`, and `EntityGraphPanel`. Most async flows properly cancel on unmount or supersession.
- **Array capping is implemented consistently**: `MAX_MESSAGES` (100), `MAX_CVE_CACHE_ENTRIES` (200), `MAX_WORKSPACES` (50), `MAX_TEST_RESULTS` (50), `MAX_DOSSIER_NEARBY` (30), `capDataPayload`, `news.slice(0, 25)`.
- **HLS cleanup in `CameraViewer`** is correct: `destroyHls()`, video pause, `removeAttribute('src')`, and `video.load()` are all called.
- **Map cleanup** (ResizeObserver disconnect, popup removal, `map.remove()`) is present in the main effect.
- **Desktop backend forking** is a solid architectural improvement for isolating scanner and intel processes.
- **Tests are comprehensive** and cover the new features (Waze alerts, police DB, surveillance foundation, intel framework) with 91 of 92 passing.
- **`geoBatchUpdatesRef`** uses `requestAnimationFrame` for batching GeoJSON updates, a good pattern for preventing MapLibre setData thrashing.
- **SSRF guard** (`validateTarget`) remains robust with IP blocklists, hostname validation, and DNS resolution checks.
- **Rate limiting** on `waze-alerts`, `ai/analyze`, and `ai/briefing` follows a consistent pattern with IP-based caps and TTL cleanup.
- **Feed engine** aborts in-flight requests and avoids interval churn.

---

*End of report.*
