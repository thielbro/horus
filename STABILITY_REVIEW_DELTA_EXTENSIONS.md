# OSIRIS Code Review — Delta Pass (Extension/Plugin System + Registry)

> **Scope:** Stability and performance only. Security is explicitly out of scope.  
> **Focus:** Changes in commits `d851493`, `c2c115c`, `e2a87aa` — extension/plugin system, registry cleanup, and hardening.  
> **Previous review:** `STABILITY_REVIEW_DELTA_4Z.md` (B+ → A−, 6 minor findings).  
> **Test result:** 41/41 pass (tests/performance-stability.test.mjs).  
> **Date:** 2026-06-24.

---

## Grade

| Area | Grade | Trend |
|------|-------|-------|
| Plugin/Extension System | B | **New code — solid foundation, 2 Critical data-loss issues** |
| Registry Engine | B+ | Stable, 4 High issues around timer churn and stale closures |
| Frontend (Map + Settings) | B+ | 2 Critical UI bugs, 5 High issues |
| Connection / Resource Management | A | Stable (all previous fixes verified) |
| Error Handling & Resilience | B+ | Some silent swallowing, missing guards |
| Test Maintenance | A | 41/41 pass |

**Overall: A− → B+** (new extension system introduces solid architecture but has 2 Critical data-loss bugs and several timer/stale-closure issues)

---

## Verified Fixes (from previous reviews)

All previously identified patterns remain fixed in the current tree:

- ✅ `releaseResponseBody` / `await res.body?.cancel()` wired into all affected API routes.
- ✅ `AbortController` on all frontend fetch calls.
- ✅ `PolybolosClient` has SSE reconnect with backoff.
- ✅ `desktop/main.js` has `SERVER_STABLE_RESET_MS`, `MAX_RENDERER_RELOADS`, `scheduleRendererReload`.
- ✅ `sdk/stream/route.ts` has bounded connection limit.
- ✅ CCTV fanout uses `Promise.allSettled`, `AbortController`, and `seenCameraIds` dedup.
- ✅ `DATA_ARRAY_LIMITS` / `capDataPayload` in page.tsx.
- ✅ `MAX_GRAPH_NODES`, `MAX_GRAPH_LINKS` in EntityGraphPanel.
- ✅ Feed engine (`engine.ts`) has `controllersRef`, `lazyIntervalsRef`, abort-on-unmount.
- ✅ `mapEngine.ts` isolates bad specs with `try { map.addSource/addLayer } catch`.
- ✅ `MAX_MESH_NODES = 750` cap in `builtins.ts`.
- ✅ Delta review M1–M7 recommendations from `STABILITY_REVIEW_DELTA_4Z.md` are addressed in tests.

---

## Critical Issues (4)

### C1 — `customSources.ts` destroys old source before validating new one
- **File:** `src/lib/plugins/customSources.ts:43–71`
- **Issue:** `upsertCustomSource` calls `unregisterCustomSource(clean.id)` **before** `registerCustomSource(clean)`. If the new registration throws, the previously working source is already gone from the live registry and cannot be recovered.
- **Fix:** Move `unregisterCustomSource` to **after** successful `registerCustomSource`, or validate and register first, then swap.
- **Effort:** Low

### C2 — `customSources.ts` persist() filters out error records, causing data loss
- **File:** `src/lib/plugins/customSources.ts:20–22`
- **Issue:** `persist()` only writes `specs.filter(s => !s.error)`. When an update fails, the catch block pushes an error record into `specs`, then calls `persist()` — which silently drops the source from the settings store. On the next app start, the source is permanently gone.
- **Fix:** Persist the full record list (including error state), or at minimum preserve the original spec on failure so the user doesn't lose data.
- **Effort:** Low

### C3 — `OsirisMap.tsx` missing null check before `setData`
- **File:** `src/components/OsirisMap.tsx:1242–1243`
- **Issue:** `const src = map.getSource('scan-targets')` is cast and immediately called with `setData()`. If the source doesn't exist, this throws. No truthy guard.
- **Fix:** Add `if (src) (src as GeoJSONSource).setData(...)`.
- **Effort:** Trivial

### C4 — `ExtensionsSettings.tsx` `busy` state stuck on plugin install failure
- **File:** `src/components/ExtensionsSettings.tsx:287–293`
- **Issue:** The `install` async function does not wrap `installPlugin(src)` in try/catch. If `installPlugin` throws, `setBusy(false)` is never reached and the INSTALL button stays permanently disabled.
- **Fix:** Wrap `installPlugin` call in try/catch with `setBusy(false)` in finally.
- **Effort:** Trivial

---

## High Issues (13)

### Plugin / Extension System

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| H1 | `src/lib/plugins/index.ts` | 46–51 | `started` flag is set before async work completes. If `getSettings()` throws, `started` remains `true` and the system never retries. | Set flag inside `finally` or after successful completion. |
| H2 | `src/lib/plugins/loader.ts` | 141–142 | Same pattern: `bootstrapped` guard set before any work. If `getSettings()` throws, flag is stuck `true` and plugins never load on retry. | Set flag after successful completion. |
| H3 | `src/lib/plugins/context.ts` | 165 | `ctx.fetch` delegates to global `fetch` with no `AbortController`. If a plugin is deactivated, the fetch continues. | Wrap with per-request `AbortController` and store for cancellation on deactivation. |
| H4 | `src/lib/plugins/customSources.ts` | 52–67 | Unprotected `persist()` / `notify()` calls. If `updateSettings()` throws, live registry and persisted settings diverge. | Wrap in try/catch with rollback or consistency check. |
| H5 | `src/lib/plugins/loader.ts` | 94–115 | Race condition in `installPlugin` for same ID. Two concurrent calls can interleave: A tears down, B tears down A's new context, final state is unpredictable. | Add a per-ID lock or use a queue. |
| H6 | `src/lib/plugins/loader.ts` | 117–126 | Optimistic `enabled` state persisted before activation succeeds. If activation fails, record is still `enabled: true` with error set. | Persist `enabled` only after successful activation, or add an `activationFailed` flag. |

### Registry Engine

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| H7 | `src/lib/registry/engine.ts` | 28–29 | Fetch errors silently swallowed. `fetchEndpoint` rejection is unhandled — no `.catch()`. | Add `.catch(err => console.error(...))` or propagate to error boundary. |
| H8 | `src/lib/registry/engine.ts` | 40–54 | Core feed timer churn on every registry mutation. Effect depends on `registryVersion`, so all timers clear/recreate on any plugin registration. | Split into two effects: one for new-feed detection, one for stable intervals. |
| H9 | `src/lib/registry/engine.ts` | 78–80 | Lazy polling intervals capture stale feed definitions. Once created, interval is never replaced even if feed URL/interval changes. | Clear + recreate interval when definition changes. |
| H10 | `src/lib/registry/mapEngine.ts` | 15–18 | `getStyleLayerSource` / `getRenderBindingSource` throw if source is missing. Not caught inside `addRegistryLayer`, so a malformed plugin can crash map init. | Wrap `registryLayerSources` in `try/catch` or return undefined and filter. |

### Frontend

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| H11 | `src/components/OsirisMap.tsx` | 874–933 | Dynamic layer effect missing cleanup on unmount. `dynState.current` retains closures referencing map and handlers. | Add cleanup in the effect return that calls `teardownEntry` for all dynamic layers. |
| H12 | `src/app/page.tsx` | 159–161 | `document.body.className` overwrites all body classes. Runtime classes from Next.js/Electron are stripped. | Use `document.body.classList.add/remove('theme-ghost')` instead. |
| H13 | `src/components/OsirisMap.tsx` | 1114–1117 | `conflict_zones` effect missing `data` dependency. Never re-runs when data changes, so updates after initial load are ignored. | Add `data` to dependency array. |
| H14 | `src/components/OsirisMap.tsx` | 1098–1102 | SDK effect depends on `data.submarine_cables` but likely consumes `data.sdk_entities`. If `sdk_entities` updates without `submarine_cables` changing, layer stays stale. | Add correct dependency. |
| H15 | `src/app/page.tsx` | 976, 995, 1137, etc. | Inline arrow functions in JSX cause child re-renders. `page.tsx` is large and frequently re-rendering; new function references bypass `memo()` on children. | Memoize callbacks with `useCallback` or extract to stable refs. |

### Systemic Patterns

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| H16 | `src/app/page.tsx` | 279 | URL-debounce `useEffect` has no cleanup. `setTimeout` fires after unmount and can corrupt URL of newly mounted page. | Return `clearTimeout(urlTimer.current)` from cleanup. |

---

## Medium Issues (11)

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| M1 | `src/lib/registry/engine.ts` | 57 | `fetched` Set grows without bound. If a feed is unregistered and re-registered with same ID, it never fetches again. | Clear `fetched` entry on feed unregister, or key by composite. |
| M2 | `src/lib/registry/engine.ts` | 58–67, 70–90 | Effects re-run on every `registryVersion` bump, iterating all feeds even if none changed. | Memoize derived lazy-feed list or diff before iterating. |
| M3 | `src/lib/registry/customSource.ts` | 39 | Non-array responses silently discarded. Misconfigured `jsonPath` yields empty array with no diagnostic. | Log warning when resolved value is not an array. |
| M4 | `src/lib/registry/feeds.ts` / `store.ts` | — | Registry Maps have no total size caps. Buggy plugin could register thousands of entries. | Add hard caps (e.g., 500 layers, 200 feeds) with warning log. |
| M5 | `src/components/OsirisMap.tsx` | 1121–1154 | `setVis` effect is O(n) on every toggle. ~40 layers updated when one toggles. | Optional: split into per-layer effects or memoize changed keys. |
| M6 | `src/app/page.tsx` | 265–269 | URL layer parsing resets all unknown layers to false. Old URLs disable new layers by default. | Only toggle layers explicitly mentioned in URL. |
| M7 | `src/components/OsirisMap.tsx` | 1173–1176 | `sweepData` effect forces projection without updating parent state. UI toggle and map desync. | Update `mapProjection` state in page.tsx when effect changes projection. |
| M8 | `src/components/OsirisMap.tsx` | 59, 63, 82, 86, 976, 1003 | `canvas.getContext('2d')!` non-null assertions. If canvas limit reached, throws. | Guard with null check and early return. |
| M9 | `src/app/page.tsx` | 240 | IP geolocation fetch without `res.ok` guard. Error body passed to `.json()` can throw. | Check `r.ok` before `.json()`. |
| M10 | `src/app/page.tsx` | 296 | Stats fetch without `res.ok` guard. Same issue. | Check `res.ok` before `.json()`. |
| M11 | `src/app/page.tsx` | 459 | `bootstrapExtensions` async work continues after unmount with no cancellation. | Add `AbortController` or unmount guard. |

---

## Low Issues (9)

| # | File | Lines | Issue | Fix |
|---|------|-------|-------|-----|
| L1 | `src/components/OsirisMap.tsx` | 340–831 | ~40 built-in `map.on()` handlers rely on `map.remove()` as sole cleanup. | Explicitly remove handlers or verify `map.remove()` behavior. |
| L2 | `src/components/ExtensionsSettings.tsx` | 42–48 | Blob URL revoked immediately after `a.click()`. Download may not start in some browsers. | Revoke in `setTimeout(..., 1000)` or after `load` event. |
| L3 | `src/components/ExtensionsSettings.tsx` | 115–116 | Raw JSON mode allows primitives. `JSON.parse` can return number/string/null. | Add runtime type check before assigning `.id`. |
| L4 | `src/lib/plugins/loader.ts` | 36 | `notify()` lacks listener error isolation. One throwing subscriber stops others. | Wrap each listener in try/catch. |
| L5 | `src/lib/plugins/customSources.ts` | 18 | Same listener-isolation issue in `customSources` notify. | Same fix. |
| L6 | `src/lib/plugins/context.ts` | 139–141 | `settings.get/set/delete` silently swallow `localStorage` errors. | Log errors or return status. |
| L7 | `src/lib/plugins/context.ts` | 180 | `dispose()` silently swallows all disposer errors. | Log error before ignoring. |
| L8 | `src/lib/plugins/loader.ts` | 12 | `records` array unbounded. No max plugin count. | Add `MAX_PLUGINS` guard. |
| L9 | `src/lib/plugins/customSources.ts` | 15 | `specs` array unbounded. No max source count. | Add `MAX_CUSTOM_SOURCES` guard. |
| L10 | `src/components/LayerPanel.tsx` | 23–35, 51 | `getLayerGroups` not memoized. Recomputed on every render. | Wrap in `useMemo`. |
| L11 | `src/components/ExtensionsSettings.tsx` | 120, 131 | Unnecessary `as CustomSourceSpec` type assertions. | Remove redundant casts. |
| L12 | `src/lib/registry/mapEngine.ts` | 34, 53, 89, 94 | `as any` casts reduce type safety. | Use proper MapLibre types. |
| L13 | `src/lib/registry/events.ts` | 11–13 | Listener errors silently swallowed with no log. | Log to console.error in dev mode. |
| L14 | `src/lib/registry/builtins.ts` | 163 | `undefined` name possible for maritime ships. | Add `|| 'Unknown'` fallback. |
| L15 | `src/lib/registry/builtins.ts` | 330 | `computeSolarTerminator` recalculates on every render with no memoization. | Cache with 60s TTL. |
| L16 | `src/lib/registry/engine.ts` | 23–24 | `useRef` initializers create new collections on every render. | Use lazy initialization. |
| L17 | `src/components/SettingsPanel.tsx` | — | Not memoized. Re-renders whenever page.tsx re-renders even if closed. | Wrap in `memo()`. |
| L18 | `src/app/page.tsx` | 84–88 | Brittle URL parsing in `getYouTubeWatchUrl`. | Use `URL` API. |
| L19 | `src/app/page.tsx` | 1080–1085 | Live feed iframe missing `sandbox` attribute. | Add `sandbox="allow-scripts allow-same-origin"` or stricter. |

---

## Positive Findings

| # | Finding | Location |
|---|---------|----------|
| 1 | **Blob URLs reliably revoked** — `importDef` uses `finally` block to revoke blob URL. | `loader.ts:48–53` |
| 2 | **Plugin activation isolated** — `runActivate` wraps each plugin in `try/catch`. One bad plugin cannot crash the host. | `loader.ts:64–77` |
| 3 | **Validation-first** — `registerLayer`, `registerFeed`, `registerGroup` validate before touching registry. | `context.ts` |
| 4 | **Sequential boot** — `bootstrapPlugins` awaits each plugin sequentially, avoiding thundering-herd. | `loader.ts:140–150` |
| 5 | **Consistent `AbortController` pattern** — Every fetch gets cancellable signal. | `engine.ts` |
| 6 | **Comprehensive unmount cleanup** — Aborts in-flight requests and clears all intervals/timers. | `engine.ts:32–37` |
| 7 | **Defensive try/catch around MapLibre ops** — All `addSource`, `addLayer`, `removeLayer`, etc. wrapped. | `mapEngine.ts` |
| 8 | **Bounded mesh generation** — `MAX_MESH_NODES = 750` caps botnet lattice links. | `builtins.ts:16` |
| 9 | **HTML escaping in custom popups** — `escapeHtml` prevents injection in generated popup HTML. | `customSource.ts:41` |
| 10 | **Stable callback patterns** — `useCallback` used for `createIcon`, `createDot`, `setGeo`, `setVis`, `handleEntityClick`, `fetchEndpoint`, `ifVisible`. | `page.tsx`, `OsirisMap.tsx` |
| 11 | **LRU cache** — `geocodeCache` Map with 500-entry cap prevents unbounded growth. | `page.tsx:338–364` |
| 12 | **Settings listener cap** — `MAX_LISTENERS = 500` prevents unbounded listener growth. | `settings/index.ts:154–155` |
| 13 | **Inflight promise guard** — Prevents concurrent hydration of settings store. | `settings/index.ts:152, 157–174` |
| 14 | **`ErrorBoundary` around map** — Isolates map failures from rest of app. | `page.tsx:861–877` |
| 15 | **Plugin context uses `warnOnce`** — Prevents console spam from unwired features. | `context.ts:42–43` |
| 16 | **Host services are null-safe** — Every service degrades gracefully if not wired yet. | `host.ts:21–39` |

---

## Priority Action Plan

### Immediate (Fix Before Next Release)

| Priority | Issue | File | Effort |
|----------|-------|------|--------|
| 1 | Fix destroy-before-validate in `upsertCustomSource` | `src/lib/plugins/customSources.ts` | Low |
| 2 | Fix `persist()` filtering out error records | `src/lib/plugins/customSources.ts` | Low |
| 3 | Fix `busy` state stuck on plugin install failure | `src/components/ExtensionsSettings.tsx` | Trivial |
| 4 | Add null check before `setData` on scan-targets | `src/components/OsirisMap.tsx` | Trivial |
| 5 | Add cleanup to URL-debounce timer | `src/app/page.tsx` | Trivial |
| 6 | Fix `bootstrapped`/`started` flag order | `src/lib/plugins/loader.ts`, `src/lib/plugins/index.ts` | Low |
| 7 | Add `res.ok` guards to frontend fetches | `src/app/page.tsx` (lines 240, 296) | Low |
| 8 | Add `AbortController` to `ctx.fetch` | `src/lib/plugins/context.ts` | Low |
| 9 | Fix core feed timer churn | `src/lib/registry/engine.ts` | Medium |
| 10 | Fix lazy interval stale closures | `src/lib/registry/engine.ts` | Medium |

### Short-Term (Fix Within 1 Sprint)

| Priority | Issue | File | Effort |
|----------|-------|------|--------|
| 11 | Add `try/catch` around `registryLayerSources` | `src/lib/registry/mapEngine.ts` | Low |
| 12 | Add dynamic layer cleanup on unmount | `src/components/OsirisMap.tsx` | Low |
| 13 | Fix `document.body.className` overwrite | `src/app/page.tsx` | Trivial |
| 14 | Fix `conflict_zones` missing data dependency | `src/components/OsirisMap.tsx` | Trivial |
| 15 | Fix SDK effect stale dependency | `src/components/OsirisMap.tsx` | Trivial |
| 16 | Memoize inline callbacks in `page.tsx` | `src/app/page.tsx` | Medium |
| 17 | Add `fetched` Set cleanup on feed unregister | `src/lib/registry/engine.ts` | Low |
| 18 | Add registry Map size caps | `src/lib/registry/store.ts`, `feeds.ts` | Low |
| 19 | Add `try/catch` around unprotected persist/notify | `src/lib/plugins/customSources.ts` | Low |
| 20 | Fix `installPlugin` race condition | `src/lib/plugins/loader.ts` | Medium |

### Medium-Term (Fix Within 2 Sprints)

| Priority | Issue | File | Effort |
|----------|-------|------|--------|
| 21 | Add listener error isolation | `src/lib/plugins/loader.ts`, `customSources.ts` | Low |
| 22 | Log `localStorage` errors instead of swallowing | `src/lib/plugins/context.ts` | Low |
| 23 | Add `dispose()` error logging | `src/lib/plugins/context.ts` | Low |
| 24 | Add max plugin/source limits | `src/lib/plugins/loader.ts`, `customSources.ts` | Low |
| 25 | Memoize `getLayerGroups` in `LayerPanel` | `src/components/LayerPanel.tsx` | Low |
| 26 | Fix `canvas.getContext('2d')!` null assertions | `src/components/OsirisMap.tsx` | Low |
| 27 | Fix sweep projection desync | `src/components/OsirisMap.tsx` | Low |
| 28 | Add `sandbox` to live feed iframe | `src/app/page.tsx` | Trivial |
| 29 | Fix `computeSolarTerminator` memoization | `src/lib/registry/builtins.ts` | Low |
| 30 | Fix `useRef` eager initialization | `src/lib/registry/engine.ts` | Trivial |

---

## Appendix: Review Coverage

| Domain | Files Reviewed | Agent |
|--------|---------------|-------|
| Plugin / Extension System | 8 | Plugin_System_Stability_Reviewer |
| Registry System | 10 | Registry_System_Stability_Reviewer |
| Frontend / UI Components | 6 | Frontend_Stability_Reviewer |
| Systemic Patterns (grep) | ~30 changed files | Systemic_Pattern_Reviewer |
| **Total** | **~30** | |

**Excluded from scope:** Security vulnerabilities per user request.
