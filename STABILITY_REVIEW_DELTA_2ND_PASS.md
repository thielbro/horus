# HORUS — Second-Pass Code Review (Delta Report)

**Project:** horus-native-desktop  
**Stack:** Next.js 16.2.6, React 19.2.4, TypeScript 5, Electron 42.4.1, Tailwind CSS v4, MapLibre GL  
**Review Date:** 2025-06-23  
**Scope:** Stability, functionality, and performance. Security is out of scope.  
**Previous Review:** `FINAL_CODE_REVIEW.md` (same session, earlier commit)

---

## Executive Summary

The delta between the first review and this one is **feature-heavy, fix-light**. Major new capabilities landed (surveillance panel, per-continent CCTV, port scanning tiers, source tester, bundled desktop backends), but **zero of the 15 Critical issues from the first review were actually fixed**. The new code is generally well-written with good defensive patterns (bounded port scanning, round-robin camera merging, SSRF-gated scanner proxy), but introduces a few new crash surfaces and perpetuates the systemic `AbortSignal.timeout` / `AbortSignal.any` compatibility hazard across 89+ call sites.

**Test Results:** 67 pass, 1 fail (stale test checking for a renamed variable).

**Overall Grade Trend:** Unchanged — C+ / C+ / C (stability / functionality / performance). The new code doesn't materially improve or degrade the grade; the dominant performance bottleneck (1,430-line God component) and the dominant stability hazards (missing fetch timeouts, circular JSON, unterminated bodies) remain untouched.

---

## ✅ Issues Verified as Fixed (First Review → Now)

| # | Issue | File | Evidence |
|---|---|---|---|
| 1 | `desktop/main.js` `stopManagedBackends` now clears `state.stableTimer` | `desktop/main.js:267-280` | `clearTimeout(state.stableTimer)` present; `stableTimer` stored on `state` object |
| 2 | `desktop/main.js` `isQuitting` guard added to restart schedulers | `desktop/main.js:150,323` | Both `scheduleBackendRestart` and `scheduleEmbeddedServerRestart` bail if `isQuitting` |
| 3 | `scanner/route.ts` completely rewritten with SSRF validation, rate limiting, timeouts, scan type gating | `src/app/api/scanner/route.ts` | `validateHost`, `isRateLimited`, `ALLOWED_SCANS` gating, `withDeadline` wrapper |
| 4 | `cctv/route.ts` now uses `releaseResponseBody` on failed fetches, bounded merging, timeouts | `src/app/api/cctv/route.ts` | `releaseResponseBody(res)` on every `!res.ok` path; `MAX_CAMERAS = 5000`; `mergeCamerasFairly` round-robin |
| 5 | `http-utils.ts` new `releaseResponseBody` helper added | `src/lib/http-utils.ts:1-7` | Exported for use across routes |
| 6 | `settings/index.ts` `JSON.parse` wrapped in try/catch | `src/lib/settings/index.ts:134-138` | `try { JSON.parse(...) } catch { return {} }` |
| 7 | `HorusMap.tsx` `safeJsonArray` guard added | `src/components/HorusMap.tsx:35-44` | `JSON.parse` wrapped in try/catch with array validation |
| 8 | `techFingerprint` in `scanner/server.js` no longer fetches unbounded headers (the original "entire HTML body" vector was partially mitigated by slicing, though `res.text()` still buffers the full response before slicing — see 🔴 Remaining #16) | `scanner/server.js:189-209` | Now reads headers first, then body with `.slice(0, 200000)` |

---

## 🔴 Issues Still NOT Fixed (Carried Forward from First Review)

All 15 Critical issues from the first review remain unaddressed. The most impactful are summarized below; the full list with line numbers and recommendations is identical to `FINAL_CODE_REVIEW.md` § "Critical Issues (Full Detail)".

| # | Severity | File | Issue | Status |
|---|---|---|---|---|
| 1 | Critical | `src/app/page.tsx:160` | `Dashboard` is still a 1,430-line God component; monolithic `data` state forces full-tree re-renders | ❌ Unchanged |
| 2 | Critical | `src/app/page.tsx:604-623` | `fetchEndpoint` still calls `fetch()` with `cache: 'no-store'` but **no timeout** | ❌ Unchanged |
| 3 | Critical | `src/components/HorusMap.tsx:151` | `new maplibregl.Map()` still not wrapped in `try/catch` | ❌ Unchanged |
| 4 | Critical | `src/components/OsintPanel.tsx:283-339` | `ResultRow`, `StatusBadge`, `SanctionsBadge`, `SectionHeader`, `PortRow` still declared **inside** `OsintPanelInner` | ❌ Unchanged |
| 5 | Critical | `src/lib/http-utils.ts:9-16` | `stableStringify` still has **no circular-reference guard** | ❌ Unchanged |
| 6 | Critical | `desktop/main.js:157` | `scheduleBackendRestart` anonymous `setTimeout` still **not stored on `state`**; `stopManagedBackends` cannot clear it | ❌ Partial (isQuitting guard added, but timer still leaks) |
| 7 | Critical | `scanner/server.js:199` | `techFingerprint` still calls `await res.text()` before `.slice(0, 200000)` — a malicious server can stream multi-GB before the slice | ❌ Unchanged (see discussion below) |
| 8 | Critical | `src/components/AiAnalyst.tsx:254,305` | AI `fetch` calls still have **no `AbortController` or timeout** | ❌ Unchanged |
| 9 | Critical | `src/proxy.ts:31-37` | `send()` still fires `fetch` without consuming or cancelling the response body | ❌ Unchanged (now has `AbortSignal.timeout(3000)` but still no body cleanup) |
| 10 | Critical | `src/components/SettingsPanel.tsx:73-78` | `useEffect` still syncs `keys` on `settings.apiKeys` change — **race condition overwrites user edits** | ❌ Unchanged |
| 11 | Critical | `src/components/SharePanel.tsx:23` | `mapView.zoom.toFixed(2)` still called without `Number.isFinite` guard | ❌ Unchanged |
| 12 | Critical | `src/lib/ai-engine.ts:286` | `Math.max(...context.earthquakes.map(...))` still spreads unbounded array — **RangeError** on large contexts | ❌ Unchanged |
| 13 | Critical | `desktop/main.js:524` | `settings:set` IPC still passes renderer payload directly to `fs.writeFileSync` without size validation or atomic write | ❌ Unchanged |
| 14 | Critical | `src/components/ScmPanel.tsx:85` | `JSON.parse(s.active_threats)` still without `try/catch` | ❌ Unchanged |
| 15 | Critical | `src/components/WorkspacesSettings.tsx:78,84` | `getCurrentSnapshot()` still called without `try/catch` | ❌ Unchanged |
| 16 | High | `src/components/EntityGraphPanel.tsx:156-167` | Entity change `useEffect` still does not abort in-flight expansion on entity switch | ❌ Unchanged |
| 17 | High | `src/components/CameraViewer.tsx:84-86` | HLS fatal error still only calls `setError(true)` — does **not** destroy HLS instance | ❌ Unchanged |
| 18 | High | `src/lib/ssrf-guard.ts:62` | `AbortSignal.any` still used without **feature detection** — crashes on Node.js < 20 / older browsers | ❌ Unchanged |

### Discussion: `scanner/server.js` `techFingerprint` OOM Vector

The diff stats show `scanner/server.js` was heavily modified (+148 lines), but `techFingerprint` at line 199 still reads the full response body into memory before slicing:

```js
const html = (await res.text()).slice(0, 200000);
```

`res.text()` buffers the entire response. A malicious server can stream a multi-gigabyte response, causing the scanner backend to OOM before `.slice()` is ever reached. The original fix recommendation was to use a streaming reader or abort at a byte limit. This remains unaddressed.

---

## 🆕 New Critical Issues (Introduced in Recent Changes)

| # | Severity | File | Issue | Impact | Recommendation |
|---|---|---|---|---|---|
| 1 | Critical | `tests/performance-stability.test.mjs:380` | Stale test: `assert.match(route, /seenCameraIds/)` fails because `cctv/route.ts` rewrite renamed the variable to `seen` | CI/test suite broken; false-negative blocks merges | Update test regex to `/\bseen\b.*\bSet\b/` or check `mergeCamerasFairly` function name |
| 2 | Critical | `src/lib/plugins/bundles.ts:52` | `JSON.parse(payload)` without `try/catch` | Runtime crash on malformed bundle JSON during import | Wrap in `try/catch` and return `null` or throw a descriptive error |
| 3 | Critical | `src/components/SurveillancePanel.tsx:279` | `removeCustomSource(s.id)` called inline in JSX `onClick` without `try/catch` | If the plugin registry throws during removal, the React tree crashes | Wrap in `try/catch` with a `formError` / flash notice |
| 4 | Critical | `src/components/SurveillancePanel.tsx:134-146` | `runTest` calls `fetch('/api/source-test?...')` without an `AbortController` or timeout | Multiple rapid clicks accumulate requests; no way to cancel stale tests | Add `AbortController` per test, store in `Map` keyed by URL, abort before firing a new test for the same URL |
| 5 | High | `src/components/SurveillancePanel.tsx:128` | `tests` state is `Record<string, TestState>` with **no cleanup or eviction** | Testing many URLs grows state unbounded; never cleared even on panel close | Reset `tests` to `{}` on panel close, or cap at a max number of entries |
| 6 | High | `src/lib/overpass.ts:103-105` | On non-OK Overpass response, returns early without consuming/cancelling the response body | Undici connection leak in Next.js server | Call `await res.body?.cancel()` before returning the error JSON |
| 7 | High | Systemic — 89+ occurrences | `AbortSignal.timeout()` and `AbortSignal.any()` used extensively across **all** API routes and libraries without feature detection | Hard runtime crash on Node.js < 18.14 / older browsers / Electron renderer contexts that lack the API | Add a polyfill or guard: `typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : (new AbortController()).signal` with a manual `setTimeout` abort. For `AbortSignal.any`, fall back to `parentSignal \|\| timeoutController.signal` |
| 8 | High | `desktop/main.js:330` | `scheduleEmbeddedServerRestart` creates anonymous `setTimeout` without storing the handle | `stopEmbeddedServer` clears `serverStableResetTimer` but not the restart timer; if `stopEmbeddedServer` is called while a restart is pending, the timer may still fire and attempt to start a new server after shutdown | Store the timer ID on a module-level variable (`serverRestartTimer`) and clear it in `stopEmbeddedServer` |
| 9 | Medium | `src/components/SurveillancePanel.tsx:295-313` | Form inputs use `value={draft.xxx}` but `draft` initialized with `EMPTY_DRAFT` may have `undefined` for optional fields; React controlled-input warnings if user clears an optional field | Minor UI warnings | Ensure all optional string fields default to `''` rather than `undefined` in `EMPTY_DRAFT` |
| 10 | Medium | `src/lib/overpass.ts:101` | `AbortSignal.timeout(30000)` without feature detection | Same systemic issue as #7 | Same fix as #7 |
| 11 | Medium | `src/app/api/cctv/route.ts:81-84` | `signalWithTimeout` helper uses `AbortSignal.any` without feature detection | Same systemic issue as #7 | Same fix as #7 |
| 12 | Low | `src/app/api/source-test/route.ts:66` | `AbortSignal.timeout(12000)` without feature detection | Same systemic issue as #7 | Same fix as #7 |
| 13 | Low | `scanner/server.js:145` | `withTimeout` helper returns `AbortSignal.timeout(ms)` without feature detection | Same systemic issue as #7 | Same fix as #7 |
| 14 | Low | `src/app/api/scanner/route.ts:117` | `AbortSignal.timeout(scanConfig.timeout)` without feature detection | Same systemic issue as #7 | Same fix as #7 |

---

## 🆕 New Positive Observations (New Code Quality)

| Module | Observation |
|---|---|
| `scanner/portscan.js` | Excellent bounded scanning: `PORT_SCAN_CONCURRENCY = 100`, deadline support, `sock.destroy()` cleanup, `done` flag prevents double-resolve, `Math.min(concurrency, ports.length)` caps worker creation. A+ module. |
| `src/app/api/cctv/route.ts` | Major rewrite with `releaseResponseBody` on all failure paths, `MAX_CAMERAS = 5000`, `mergeCamerasFairly` round-robin algorithm prevents region starvation, `MAX_REGION_ALL_CONCURRENCY = 5` caps parallel fetches, `Promise.allSettled` for resilience. |
| `src/app/api/scanner/route.ts` | Complete rewrite: `validateHost` with DNS resolution, `isRateLimited`, `ALLOWED_SCANS` gating (`ports`/`deep` behind `SCANNER_ALLOW_DEEP`), `withDeadline` wrapper for timeouts. Dramatically improved from the previous open-proxy design. |
| `src/app/api/source-test/route.ts` | Well-structured: SSRF guard (`safeFetch`), rate limiting (20/min), 8MB text limit before JSON parse, `try/catch` around all parsing, best-effort array discovery. |
| `src/lib/overpass.ts` | Clean shared helper: bbox validation, area cap (`MAX_BBOX_AREA_DEGREES = 25`), output count cap (`outCount = 12000`), coordinate validation, `mapNode` can return `null` to drop items. |
| `src/components/SurveillancePanel.tsx` | Good architecture: module-level `ToggleRow`, `TestResultLine`, `SectionTitle` components (no inner-definition anti-pattern), `memo` on export, per-continent loading. |
| `desktop/main.js` | Backend bundling and lifecycle is well-designed: `forkBackend` with health check polling, `getFreePort`, `managedBackends` array, `buildEngineEnv` for runtime config. |

---

## Systemic Pattern: `AbortSignal.timeout` / `AbortSignal.any` Compatibility Hazard

A grep across the codebase found **89+ call sites** using `AbortSignal.timeout()` and at least **2** using `AbortSignal.any()`. Neither API has feature detection or polyfill at any call site. This is a **systemic stability risk**.

- `AbortSignal.timeout` — available in Node.js ≥ 18.14.0 and modern browsers.
- `AbortSignal.any` — available in Node.js ≥ 20.0.0 / v18.17.0+ and very recent browsers.

In the Electron renderer (Chromium), these are generally present. In older Node.js versions, CI environments, or bundled server contexts, calling these throws a `TypeError` and crashes the request path. The fix is trivial: wrap in a `typeof` check or provide a small polyfill.

**Affected files** (partial list): `ssrf-guard.ts`, `proxy.ts`, `overpass.ts`, `scanner/server.js`, `scanner/route.ts`, `source-test/route.ts`, `cctv/route.ts`, `earthquakes/route.ts`, `fires/route.ts`, `flights/route.ts`, `gdelt/route.ts`, `malware/route.ts`, `markets/route.ts`, `news/route.ts`, `radar/route.ts`, `region-dossier/route.ts`, `sentinel/route.ts`, `weather/route.ts`, `space-weather/route.ts`, `osint/bgp/route.ts`, `entity/expand/route.ts`, `infrastructure/route.ts`, `scm-suppliers/route.ts`, `github-webhook/route.ts`, `frontlines/route.ts`, `surveillance/route.ts`, `air-quality/route.ts`, `cctv/asfinag.ts`, and many more.

---

## Priority Action Plan (Updated for Delta)

### 🔥 Immediate (This Week)

1. **Fix the stale test** — `tests/performance-stability.test.mjs:380` expects `seenCameraIds` but code uses `seen`. Unblocks CI.
2. **Add `AbortSignal.timeout` / `AbortSignal.any` polyfill** — Create a single `safeAbortTimeout(ms)` and `safeAbortAny(signals)` utility in `src/lib/http-utils.ts` and replace all 89+ raw call sites. This is the biggest bang-for-buck stability fix.
3. **Add `try/catch` to `JSON.parse` in `bundles.ts`** — `src/lib/plugins/bundles.ts:52`.
4. **Guard `removeCustomSource` in `SurveillancePanel`** — `src/components/SurveillancePanel.tsx:279`.
5. **Add timeout to `SurveillancePanel.runTest`** — `src/components/SurveillancePanel.tsx:134`.
6. **Cap `tests` state in `SurveillancePanel`** — Reset on close or limit to N entries.

### 📅 Short-Term (Next 2 Weeks)

7. **Fix the top 5 unaddressed Critical issues from the first review** — `fetchEndpoint` timeout, `stableStringify` circular guard, `OsintPanel` inner component extraction, `Dashboard` decomposition, `SettingsPanel` race condition. These have been outstanding for two review cycles.
8. **Add `res.body?.cancel()` to `overpass.ts` error path** — `src/lib/overpass.ts:103-105`.
9. **Store embedded-server restart timer and clear in `stopEmbeddedServer`** — `desktop/main.js:330`.
10. **Fix `techFingerprint` OOM vector** — Use a streaming reader or abort at a byte limit in `scanner/server.js:199`.
11. **Fix `proxy.ts` body consumption** — Use the existing `releaseResponseBody` helper.

### 🏗️ Architectural (Next Month)

12. **Decompose `Dashboard` and split `data` state** — Still the dominant performance bottleneck.
13. **Replace all `AbortSignal.*` raw calls with polyfilled utilities** — Systemic cleanup across 89+ sites.
14. **Harden `SurveillancePanel` async lifecycle** — Abort stale tests, deduplicate in-flight requests, cap state growth.

---

## Grade Comparison

| Dimension | First Review | Second Review (Delta) | Trend |
|---|---|---|---|
| **Stability** | C+ | C+ | → Flat |
| **Functionality** | C+ | C+ | → Flat |
| **Performance** | C | C | → Flat |

**Rationale:** The new features add good defensive patterns (bounded port scanning, round-robin camera merging, SSRF-gated scanner proxy), but they don't counterbalance the 15 unaddressed Critical issues. The God component, missing fetch timeouts, and circular JSON crash surface remain the dominant bottlenecks. The stale test is a new regression. The `AbortSignal` compatibility hazard is a newly-quantified systemic risk (89+ call sites) that was present but not enumerated in the first review.

---

*Review conducted by re-scanning all changed files since the first review, re-running the test suite, and searching for systemic patterns across the full codebase.*
