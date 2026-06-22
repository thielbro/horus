# Stability Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the valid high-impact stability/performance findings from `STABILITY_PERFORMANCE_REVIEW.md` without colliding with the active Phase 2 registry migration or the self-hosted entity graph plan.

**Architecture:** Apply narrow hardening passes first: release response bodies, bound background work, abort stale UI requests, and stop crash/reconnect loops. Defer broad component decomposition and raw MapLibre layer migration until Phase 2 Step 4z and Step 5 cleanup.

**Tech Stack:** Next.js 16.2.6, React 19.2.4, Electron 42.4.1, Node 22 runtime in Docker/desktop, MapLibre, native `node:test`.

---

## Validation Summary

Valid now:
- Unconsumed non-ok response bodies remain in many server routes, including `src/app/api/earthquakes/route.ts`, `src/app/api/cctv/route.ts`, `src/app/api/gdelt/route.ts`, `src/app/api/cctv/asfinag.ts`, and `src/app/api/proxy-tiles/route.ts`. Some routes are already fixed, such as `src/lib/ssrf-guard.ts`, `src/app/api/stats/route.ts`, `src/app/api/space-weather/route.ts`, and `src/app/api/cctv/resilient.ts`.
- `src/lib/sdk/PolybolosClient.ts` still has a no-op SSE `onerror`, no heartbeat watchdog, no reconnect cap/backoff, and several `Math.random()` fallback IDs.
- `desktop/main.js` still never resets `serverRestartAttempts` after a stable embedded server start and reloads crashed renderers with no cap.
- `src/app/api/sdk/stream/route.ts` clears intervals on stream cancel, but still lacks active connection limits and max lifetime.
- `src/app/api/cctv/route.ts` still fetches Caltrans districts and Canada sources sequentially, and `src/app/api/cctv/fanout.ts` times out without aborting underlying work.
- Frontend feed polling is partially fixed by `src/lib/registry/engine.ts`, but one-shot and user-driven fetches in `src/app/page.tsx`, `src/components/EntityGraphPanel.tsx`, `src/components/OsintPanel.tsx`, `src/components/GlobalStatusBar.tsx`, and `src/components/SearchBar.tsx` still need cancellation/race protection.
- Data correctness issues are valid in `fires` CSV parsing, GDELT random IDs, space-weather `NaN`, sanctions `limit`, scanner `vuln` timeout, GitHub fail-fast, Tor-list per-IP download, SDK ingest `Content-Length` `NaN`, settings mutable return, and Lattice position validation.

Overstated or already partially addressed:
- The Node 18 `AbortSignal.timeout()` finding is not a deploy blocker for this repo as currently configured: `Dockerfile`, `intel/Dockerfile`, and `scanner/Dockerfile` use Node 22, and `node_modules/next/package.json` requires Node `>=20.9.0`. The right fix is to declare/enforce this runtime in `package.json`, not mechanically replace every `AbortSignal.timeout()` unless Node 18 support becomes a real target.
- `page.tsx` is still large, but the handoff says feed wiring has already moved into `useFeedEngine`. A broad split should wait until Phase 2 Step 5 cleanup.
- `sdk/stream` interval cleanup is not missing anymore; the remaining work is bounding active connections/lifetime.
- `maritime` already has reconnect backoff and cache caps; it still needs shutdown cleanup.

## Conflict Rules

- Do not run raw `next dev`; use only `npx tsc --noEmit`, `npm run build`, `npm run desktop:prepare`, and direct `node --test` commands.
- Do not decompose `src/app/page.tsx` before Phase 2 Step 4z and Step 5. Only add abort/race guards to existing effects and callbacks.
- Do not migrate `network-mesh`, `sdk-links`, `day-night`, `ip-sweep`, `scan-targets`, `conflict-zones`, or `war-alerts` outside the Step 4z workstream.
- Do not create a sidebar toggle for `news_intel`; add a registry `hidden`/`headless` flag before migrating `sigint-news`.
- Keep `/api/entity/expand` and `EntityGraphPanel` compatible with the self-hosted Yente/Nginx plan. Add cancellation and response cleanup, but do not redesign the graph architecture.

## File Structure

- Modify `package.json`: add Node engine declaration matching Next's runtime requirement.
- Create `src/lib/http-utils.ts`: shared helpers for response-body cancellation, bounded integer parsing, stable hashing, and G-level/Kp parsing if the implementation chooses shared helpers over local functions.
- Modify API routes listed in Task 2 and Task 7: resource cleanup and data correctness.
- Modify `src/app/api/cctv/fanout.ts` and `src/app/api/cctv/route.ts`: abortable fanout, parallel region internals, camera dedupe.
- Modify `desktop/main.js`: embedded server restart reset and renderer reload guard.
- Modify `src/lib/sdk/PolybolosClient.ts`, `src/app/api/sdk/stream/route.ts`, and `src/lib/sdk/LatticeAdapter.ts`: bounded SSE/reconnect behavior and stable IDs.
- Modify frontend components only in-place: `src/app/page.tsx`, `src/components/EntityGraphPanel.tsx`, `src/components/OsintPanel.tsx`, `src/components/GlobalStatusBar.tsx`, `src/components/SearchBar.tsx`.
- Modify lifecycle files: `intel/server.js`, `src/app/api/maritime/route.ts`.
- Extend tests: `tests/performance-stability.test.mjs`, `src/app/api/cctv/fanout.test.mjs`, plus targeted `node:test` files for CSV parsing and deterministic IDs if helpers are exported.

---

### Task 1: Runtime Contract

**Files:**
- Modify: `package.json`
- Test: `tests/performance-stability.test.mjs`

- [ ] Add `"engines": { "node": ">=20.9.0" }` to `package.json`.
- [ ] Add a stability test asserting the package engine exists and is `>=20.9.0`.
- [ ] Leave `AbortSignal.timeout()` in place for this pass unless a specific non-Next Node 18 runtime is required.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 2: Release Non-OK Fetch Bodies

**Files:**
- Modify: `src/app/api/earthquakes/route.ts`
- Modify: `src/app/api/frontlines/route.ts`
- Modify: `src/app/api/gdelt/route.ts`
- Modify: `src/app/api/cctv/route.ts`
- Modify: `src/app/api/cctv/asfinag.ts`
- Modify: `src/app/api/cctv/stream-status/route.ts`
- Modify: `src/app/api/air-quality/route.ts`
- Modify: `src/app/api/weather/route.ts`
- Modify: `src/app/api/region-dossier/route.ts`
- Modify: `src/app/api/flights/route.ts`
- Modify: `src/app/api/radar/route.ts`
- Modify: `src/app/api/satellites/route.ts`
- Modify: `src/app/api/proxy-tiles/route.ts`
- Modify: `src/lib/stealthFetch.ts` only if a shared wrapper is needed.
- Test: `tests/performance-stability.test.mjs`

- [ ] For every `if (!res.ok) return`, `continue`, or `throw`, add `await res.body?.cancel()` before control leaves the branch.
- [ ] In `src/app/api/air-quality/route.ts`, check `r.ok` before `r.json()`.
- [ ] Add a source-level stability test that catches common patterns: `if (!res.ok) return` without `body?.cancel()` in reviewed route files.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 3: CCTV Fanout and Dedupe

**Files:**
- Modify: `src/app/api/cctv/fanout.ts`
- Modify: `src/app/api/cctv/route.ts`
- Test: `src/app/api/cctv/fanout.test.mjs`
- Test: `tests/performance-stability.test.mjs`

- [ ] Change `CameraFetcher<T>` to accept an optional `AbortSignal`.
- [ ] In `settleFetcher`, create an `AbortController`; abort it when the timeout branch wins.
- [ ] Keep existing behavior: completed sources are preserved when another source times out.
- [ ] Split Caltrans into per-district promises and fetch with `Promise.allSettled`.
- [ ] Split Canada into named source functions and fetch with `Promise.allSettled`.
- [ ] Dedupe `allCameras` by `id` before applying `MAX_CAMERAS`.
- [ ] Run: `node --test src/app/api/cctv/fanout.test.mjs tests/performance-stability.test.mjs`

### Task 4: Desktop Crash/Restart Guards

**Files:**
- Modify: `desktop/main.js`
- Test: `tests/performance-stability.test.mjs`

- [ ] Reset `serverRestartAttempts = 0` after `waitForServer()` succeeds and the embedded URL is assigned.
- [ ] Add a stability timer so restart attempts reset after a stable window, e.g. 5 minutes.
- [ ] Add renderer reload state: counter, last crash timestamp, exponential backoff, max attempts.
- [ ] After the cap, load `desktop/splash.html` or a minimal local error page instead of calling `win.reload()` again.
- [ ] Run: `node --test tests/performance-stability.test.mjs desktop/runtime-config.test.js`

### Task 5: SDK SSE Hardening

**Files:**
- Modify: `src/lib/sdk/PolybolosClient.ts`
- Modify: `src/app/api/sdk/stream/route.ts`
- Modify: `src/lib/sdk/LatticeAdapter.ts`
- Test: `tests/performance-stability.test.mjs`

- [ ] Add `PolybolosClient` reconnect state: retry count, backoff delay, max retry cap, heartbeat timestamp, reconnect timer.
- [ ] On SSE `onerror`, close the current `EventSource`, null handlers, and schedule reconnect with backoff.
- [ ] On `destroy()`, clear reconnect/heartbeat timers, null `onmessage`/`onerror`, close the stream, and clear state.
- [ ] Replace `Math.random()` fallback IDs with the existing `stableIdFragment()` helper using stable entity fields.
- [ ] Add `sdk/stream` global active connection count, max concurrent connections, 30-minute max lifetime, and cleanup in both `cancel()` and error paths.
- [ ] Add Lattice position validation before dereferencing `track.position`, and replace fixed 5s reconnect with capped exponential backoff.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 6: Frontend Request Cancellation

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/EntityGraphPanel.tsx`
- Modify: `src/components/OsintPanel.tsx`
- Modify: `src/components/GlobalStatusBar.tsx`
- Modify: `src/components/SearchBar.tsx`
- Test: `tests/performance-stability.test.mjs`

- [ ] Keep `useFeedEngine` as the owner of registry feed cancellation.
- [ ] Add local `AbortController` refs for one-shot `page.tsx` requests: stats, region dossier, space weather, submarine cables.
- [ ] In `EntityGraphPanel`, abort the previous expansion request before starting a new one and ignore aborted completions.
- [ ] In `OsintPanel`, abort previous lookup/sweep/CVE detail requests on tab/query changes and component unmount.
- [ ] In `GlobalStatusBar` and `SearchBar`, abort interval/search requests on unmount.
- [ ] Preserve the entity graph/Yente contract from `implementation_plan.md`; no panel redesign.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 7: Data Correctness and Bounded Inputs

**Files:**
- Modify: `src/app/api/fires/route.ts`
- Modify: `src/app/api/gdelt/route.ts`
- Modify: `src/app/api/space-weather/route.ts`
- Modify: `src/app/api/osint/sanctions/route.ts`
- Modify: `src/app/api/osint/threats/route.ts`
- Modify: `src/app/api/osint/github/route.ts`
- Modify: `src/app/api/scanner/route.ts`
- Modify: `src/app/api/sdk/ingest/route.ts`
- Modify: `src/app/api/sentinel/route.ts`
- Modify: `src/lib/settings/index.ts`
- Modify: `src/lib/ai-engine.ts`
- Test: `tests/performance-stability.test.mjs`

- [ ] Replace the FIRMS CSV split parser with quoted-field-aware parsing or an installed CSV parser.
- [ ] Generate deterministic GDELT IDs from stable event fields instead of `crypto.randomUUID()`.
- [ ] Normalize NOAA Kp values: parse numeric Kp first, map `G1` through `G5` when present, and guard `Number.isFinite(kpIndex)`.
- [ ] Parse sanctions `limit` with a finite-number fallback before clamping.
- [ ] Cache the Tor exit list globally with a 1-hour TTL and cancel/clear failed response bodies.
- [ ] Change GitHub lookup to `Promise.allSettled`, preserving user data if repos fail.
- [ ] Reduce or disable public `vuln` scanner timeout so the route cannot exceed the deployment budget.
- [ ] Reject or default non-finite SDK ingest `Content-Length`.
- [ ] Clamp Sentinel `days` and `radius` to bounded finite ranges.
- [ ] Return cloned settings from `getSettings()` and ensure `deepMerge(base, null)` keeps `base`.
- [ ] Wrap AI engine public calls or their route callers with graceful fallback text for API failure.
- [ ] Run: `node --test tests/performance-stability.test.mjs intel/sources.test.js`

### Task 8: Map Stability Without Step 4z Collision

**Files:**
- Modify: `src/components/OsirisMap.tsx`
- Test: `tests/performance-stability.test.mjs`

- [ ] Add a local `safeJsonArray(value)` helper near popup code and use it for `active_threats`, `ports`, `vulns`, and `hostnames`.
- [ ] Cap malware mesh nodes before generating links, e.g. `MAX_MESH_NODES`, without migrating `network-mesh` to the registry in this task.
- [ ] Wrap the map `load` initialization body in a tight try/catch that logs `[OSIRIS] Map init failed` and avoids repeated initialization attempts.
- [ ] Defer moving `network-mesh`, `sdk-links`, `day-night`, `ip-sweep`, `scan-targets`, `conflict-zones`, and `war-alerts` to the registry until Phase 2 Step 4z.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 9: Process Lifecycle Cleanup

**Files:**
- Modify: `intel/server.js`
- Modify: `src/app/api/maritime/route.ts`
- Test: `tests/performance-stability.test.mjs`

- [ ] Store the sanctions refresh interval ID in `intel/server.js`.
- [ ] Add idempotent shutdown cleanup for `SIGTERM` and `SIGINT`: clear sanctions interval, close server if applicable, and avoid launching new refresh work while closing.
- [ ] Add maritime cleanup function that clears reconnect timers and closes `globalForAis.aisSocket` on process shutdown.
- [ ] Run: `node --test tests/performance-stability.test.mjs`

### Task 10: Phase 2-Aligned Deferred Work

**Files:**
- Modify later: `src/lib/registry/types.ts`
- Modify later: `src/lib/registry/store.ts`
- Modify later: `src/components/LayerPanel.tsx`
- Modify later: `src/lib/registry/builtins.ts`
- Modify later: `src/components/OsirisMap.tsx`
- Modify later: `src/app/page.tsx`
- Modify later: `src/components/OsintPanel.tsx`

- [ ] During Phase 2 Step 4z, add `hidden?: boolean` or `headless?: boolean` to `RegistryLayer`.
- [ ] Filter hidden layers out of `LayerPanel` while allowing `addRegistryLayer` and `renderRegistryLayer` to use them.
- [ ] Migrate `sigint-news`/`news_intel` only after the hidden-layer flag exists.
- [ ] After Step 4z and Step 5 cleanup, split `page.tsx` into focused container/hooks/components.
- [ ] Extract `OsintPanel` inline render helpers to module-level memoized components after its request-cancellation fixes land.

## Final Verification

- [ ] Run direct tests:
  ```powershell
  node --test tests/performance-stability.test.mjs src/app/api/cctv/fanout.test.mjs desktop/runtime-config.test.js intel/sources.test.js
  ```
- [ ] Run typecheck:
  ```powershell
  npx tsc --noEmit
  ```
- [ ] Run safe production build path:
  ```powershell
  npm run build
  npm run desktop:prepare
  ```
- [ ] Do not run raw `next dev`.

## Recommended Execution Order

1. Tasks 1-4: runtime contract, response cleanup, CCTV, desktop crash guards.
2. Tasks 5-7: SDK/SSE, frontend cancellation, data correctness.
3. Tasks 8-9: map stability and lifecycle cleanup.
4. Task 10: fold into Phase 2 Step 4z/Step 5 rather than mixing with the stability batch.
