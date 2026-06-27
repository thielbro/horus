# HORUS — Final Code Review: Stability, Functionality & Performance

**Project:** horus-native-desktop  
**Stack:** Next.js 16.2.6, React 19.2.4, TypeScript 5, Electron 42.4.1, Tailwind CSS v4, MapLibre GL, Framer Motion, WebSocket  
**Total LOC:** ~12,600 (main app, desktop, intel, scanner, plugins-sdk)  
**Review Date:** 2025-06-23  
**Scope:** Stability, functionality, and performance. Security is out of scope.

---

## Executive Summary

This is a large, ambitious OSINT platform with a well-structured feature set and many thoughtful defensive patterns (bounded caches, AbortControllers, timeout wrappers, and single-flight patterns). However, **three systemic problems** drag down the overall grade:

1. **A 1,430-line God component (`page.tsx`)** with a monolithic `data` state forces full-tree re-renders on every feed update, defeating memoization across the entire UI.
2. **Missing fetch timeouts and unterminated response bodies** allow hung connections, memory leaks, and connection-pool exhaustion across the frontend, proxy, scanner, and backend services.
3. **Unsafe synchronous I/O and timer leaks in the Electron main process** can orphan child processes and corrupt settings on quit.

**Overall Grades:**

| Dimension | Grade | Notes |
|---|---|---|
| **Stability** | **C+** | Good patterns in many modules, but crash surfaces from circular JSON, unbounded HTML fetches, sync main-process writes, and missing try/catch around MapLibre/WebGL |
| **Functionality** | **C+** | Features work, but race conditions overwrite user edits, dead code exists, and keyboard shortcuts collide |
| **Performance** | **C** | The God component and monolithic data state are the dominant bottleneck. MapLibre re-initialization in StrictMode, HLS worker disabled, and O(n) rate-limiter cleanup add measurable overhead |

---

## Top 15 Issues by Impact (Priority Ranked)

| # | Severity | File | Issue | Impact | Quick Fix |
|---|---|---|---|---|---|
| 1 | 🔴 **Critical** | `src/app/page.tsx:160` | `Dashboard` is a 1,430-line God component with 35+ state variables. Every data update forces a full-tree re-render. | Severe jank and GC pressure as data volume grows; all memoization downstream is useless. | Decompose into `DataProvider`, `MapController`, `UIManager`, and `PluginHost`. Split `data` into independent atoms or use context selectors. |
| 2 | 🔴 **Critical** | `src/app/page.tsx:590` | `fetchEndpoint` calls `fetch()` with `cache: 'no-store'` but **no timeout**. | Hung connections accumulate, block the HTTP/1.1 pool, and eventually freeze the tab. | Wrap every `fetch` in `Promise.race` with a 15 s `AbortController` timeout. |
| 3 | 🔴 **Critical** | `src/components/HorusMap.tsx:151` | `new maplibregl.Map()` is **not wrapped in try/catch**. | If WebGL is unavailable or the container is invalid, the effect throws uncaught and the React tree crashes. | Wrap map creation in `try/catch`, set an error state, and render a fallback UI. |
| 4 | 🔴 **Critical** | `src/components/OsintPanel.tsx:283-339` | `ResultRow`, `StatusBadge`, `SanctionsBadge`, `SectionHeader`, and `PortRow` are declared **inside** `OsintPanelInner`. | React treats them as new component types on every parent render, causing full subtree unmount/remount. | Extract all five to top-level module components or stable `memo()` declarations. |
| 5 | 🔴 **Critical** | `src/lib/http-utils.ts:10-25` | `stableStringify` has **no circular-reference guard**. | Feeding a cyclic object causes infinite recursion and a **stack-overflow crash**. | Track objects in a `seen` `WeakSet`; throw a clear error on cycle detection. |
| 6 | 🔴 **Critical** | `desktop/main.js:149 / 320` | `scheduleBackendRestart` and `scheduleEmbeddedServerRestart` create anonymous `setTimeout` timers that are **never stored or cleared**. | On quit, timers can fire and spawn orphaned child processes that survive the parent exit. | Store timer refs on state object, clear them in `stopManagedBackends` / `stopEmbeddedServer`, and guard callbacks with `isQuitting`. |
| 7 | 🔴 **Critical** | `scanner/server.js:256` | `techFingerprint` fetches the **entire HTML body** before slicing to 200 k chars. No response size limit. | A multi-GB response streams into memory and causes an **OOM crash**. | Use a streaming reader or abort when a byte limit is exceeded. |
| 8 | 🔴 **Critical** | `src/components/AiAnalyst.tsx:252-289` | `handleSend` calls `fetch` **without an `AbortController` or timeout**. | If the server hangs, `isLoading` stays `true` forever and the user is locked out. | Add `AbortController` per request, a 30 s timeout, and ensure `finally` resets `isLoading`. |
| 9 | 🔴 **Critical** | `src/proxy.ts:31-37` | `send()` fires `fetch` inside `event.waitUntil` but **never consumes or cancels the response body**. | Under Node.js/undici this leaks connections, exhausting the pool and causing all subsequent outbound requests to hang. | Chain `.then(async (res) => { await res.body?.cancel(); })` or fully await the response. |
| 10 | 🔴 **Critical** | `src/components/SettingsPanel.tsx:73-78` | `useEffect` syncs `keys` state whenever `settings.apiKeys` changes. | In-progress API-key edits are **silently overwritten** by a parent re-render or background sync. | Remove `settings.apiKeys` from the dependency array; only reset when `open` transitions `false → true`. |
| 11 | 🔴 **Critical** | `src/components/SharePanel.tsx:23,105` | `mapView.zoom.toFixed(2)` and `.toFixed(1)` are called without validating `zoom` is finite. | `NaN`, `Infinity`, `undefined`, or `null` causes a `TypeError` and crashes the component. | Guard: `Number.isFinite(mapView.zoom) ? mapView.zoom.toFixed(2) : '0'`. |
| 12 | 🔴 **Critical** | `src/lib/ai-engine.ts:286` | `generateLocalBriefing` spreads an unbounded `context.earthquakes.map(...)` into `Math.max(...)`. | Very large arrays exceed the engine's max argument length and throw a `RangeError`. | Slice the array to a bounded size (e.g., `slice(0, 50)`) before computing the max. |
| 13 | 🔴 **Critical** | `desktop/main.js:522 / 83` | `settings:set` IPC passes any renderer payload directly to `writeSettingsFile`, which runs `JSON.stringify` and `fs.writeFileSync` in the main thread without size validation or atomic write. | Large/circular payload blocks the UI (freeze) and can corrupt `settings.json` if the process crashes mid-write. | Validate payload size, write to a temp file, then `fs.rename`. |
| 14 | 🔴 **Critical** | `src/components/ScmPanel.tsx:85` | `JSON.parse(s.active_threats)` without `try/catch`. | Malformed JSON from the API crashes the entire React tree. | Wrap in `try/catch` and default to `[]`. |
| 15 | 🔴 **Critical** | `src/components/WorkspacesSettings.tsx:78,83` | `getCurrentSnapshot()` called without `try/catch`. | If snapshot throws (corrupted map state, missing layer), the component crashes and the user loses their workspace. | Wrap in `try/catch` and surface the error via the `notice` state. |

---

## Critical Issues (Full Detail)

### 1. `page.tsx` — Dashboard God Component & Monolithic Data State
**File:** `src/app/page.tsx` (lines 160, 162, 590, 1076, 1285, 163-164, 206)  
**Severity:** Critical  

The root `Dashboard` component is 1,430 lines and holds 35+ state variables. It manages data fetching, UI state, plugin hosting, map control, and keyboard shortcuts in a single component. The `data` state is a monolithic `Record<string, any>` updated via `setData(prev => ({ ...prev, ...d }))`, which:
- Forces a full React tree re-render on every feed update
- Defeats `memo` on `LayerPanel` (which receives the always-new `data` object)
- Copies all keys on every partial update, creating O(keys) overhead
- Makes `useCallback` dependencies unstable because `data` changes constantly

**Recommendation:**
- Decompose `Dashboard` into `DataProvider`, `MapController`, `UIManager`, and `PluginHost`.
- Split `data` into independent `useState` atoms or use a context with selectors (e.g., Zustand, Jotai, or a custom selector context).
- Pass only derived primitives (counts, not objects) to memoized children.

### 2. `page.tsx` — `fetchEndpoint` Lacks Timeout
**File:** `src/app/page.tsx:590`  
**Severity:** Critical  

`fetchEndpoint` calls `fetch()` with `cache: 'no-store'` but no timeout. The browser's default TCP timeout is minutes. With multiple active feeds, pending requests accumulate, consuming memory and blocking the HTTP/1.1 connection pool.

**Recommendation:** Wrap every `fetch` in `Promise.race` with a 15 s `AbortController` timeout.

### 3. `HorusMap.tsx` — MapLibre Init Not Guarded
**File:** `src/components/HorusMap.tsx:151`  
**Severity:** Critical  

`new maplibregl.Map()` is not wrapped in `try/catch`. If WebGL is unavailable, the container is invalid, or MapLibre throws during initialization, the `useEffect` throws an uncaught exception. React Error Boundaries **do not catch errors inside effects**, so the entire React tree may crash.

**Recommendation:** Wrap map creation in `try/catch`, set an error state, and render a fallback UI.

### 4. `OsintPanel.tsx` — Inner Component Definitions Cause Subtree Remounts
**File:** `src/components/OsintPanel.tsx:283-339`  
**Severity:** Critical  

`ResultRow`, `StatusBadge`, `SanctionsBadge`, `SectionHeader`, and `PortRow` are declared as React components *inside* `OsintPanelInner`. React treats them as new component types on every parent render, forcing a full unmount/remount of their entire subtrees. In a 1,000-line panel with heavy conditional rendering, this causes catastrophic layout thrashing and GC pressure.

**Recommendation:** Extract all five to top-level module components or stable `memo()` declarations outside the parent.

### 5. `http-utils.ts` — `stableStringify` Stack Overflow
**File:** `src/lib/http-utils.ts:10-25`  
**Severity:** Critical  

`stableStringify` has no circular-reference guard. Feeding an object with circular references causes infinite recursion and a stack-overflow crash. It is exported and used by `stableHash`, making it a library-wide stability hazard.

**Recommendation:** Add a `seen` `WeakSet` (or `Set` for non-object keys) to track objects currently being serialized; throw a clear error on cycle detection.

### 6. `desktop/main.js` — Orphaned Child Processes on Quit
**File:** `desktop/main.js:149 / 320`  
**Severity:** Critical  

`scheduleBackendRestart` and `scheduleEmbeddedServerRestart` create anonymous `setTimeout` timers that are never stored or cleared. When `stopManagedBackends` / `stopEmbeddedServer` runs during app quit, these timers can still fire, and their callbacks do not check `isQuitting` before calling `forkBackend()` or `startEmbeddedServer()`. This spawns orphaned child processes that survive the parent exit.

**Recommendation:** Store timer references on the state object, clear them in `stopManagedBackends` / `stopEmbeddedServer`, and add an `isQuitting` guard inside the timer callback.

### 7. `scanner/server.js` — Unbounded HTML Fetch → OOM
**File:** `scanner/server.js:256`  
**Severity:** Critical  

`techFingerprint` fetches the entire HTML body with `await res.text()` before slicing to 200,000 characters. No response size limit is enforced, so a malicious or misconfigured server can stream a multi-gigabyte response into memory.

**Recommendation:** Consume the response with a streaming reader or a `fetch` wrapper that aborts when a byte limit is exceeded.

### 8. `AiAnalyst.tsx` — AI Fetch Hangs Forever
**File:** `src/components/AiAnalyst.tsx:252-289 / 303-339`  
**Severity:** Critical  

`handleSend` and `handleBriefing` call `fetch` without an `AbortController` or a timeout. If the server hangs, `isLoading` stays `true` forever; the user is locked out and cannot retry.

**Recommendation:** Add `AbortController` per request, a `setTimeout` fallback (e.g., 30 s), and ensure `finally` always resets `isLoading`.

### 9. `proxy.ts` — Connection Pool Exhaustion
**File:** `src/proxy.ts:31-37`  
**Severity:** Critical  

`send()` fires `fetch` inside `event.waitUntil` but never consumes or cancels the response body. Under Node.js/undici this leaks connections, eventually exhausting the connection pool and causing all subsequent outbound requests to hang.

**Recommendation:** Chain `.then(async (res) => { await res.body?.cancel(); })` or fully `await` the response and cancel the body before discarding.

### 10. `SettingsPanel.tsx` — API Key Edits Overwritten by Race
**File:** `src/components/SettingsPanel.tsx:73-78`  
**Severity:** Critical  

`useEffect` syncs `keys` state whenever `settings.apiKeys` changes. If the user is editing API keys while the settings object updates (parent re-render, background sync, or new object reference from `useSettings`), their in-progress edits are silently overwritten.

**Recommendation:** Remove `settings.apiKeys` from the dependency array and only reset `keys` when `open` transitions from `false` to `true`.

### 11. `SharePanel.tsx` — `toFixed` Crash on Invalid Zoom
**File:** `src/components/SharePanel.tsx:23,105`  
**Severity:** Critical  

`mapView.zoom.toFixed(2)` and `mapView.zoom.toFixed(1)` are called without validating that `zoom` is a finite number. If `zoom` is `NaN`, `Infinity`, `undefined`, or `null` at runtime, `toFixed` throws a `TypeError` and crashes the component.

**Recommendation:** Add a guard: `Number.isFinite(mapView.zoom) ? mapView.zoom.toFixed(2) : '0'`.

### 12. `ai-engine.ts` — `RangeError` on Large Earthquake Arrays
**File:** `src/lib/ai-engine.ts:286`  
**Severity:** Critical  

`generateLocalBriefing` spreads an unbounded `context.earthquakes.map(...)` into `Math.max(...)`. If the upstream context ever carries a very large array (> ~100 k items), the spread exceeds the engine's maximum argument length and throws a `RangeError`. `serializeContext` caps at 20, but the briefing text does not.

**Recommendation:** Slice the array to a bounded size (e.g., `context.earthquakes.slice(0, 50)`) before computing the max.

### 13. `desktop/main.js` — Settings Write Blocks Main Thread
**File:** `desktop/main.js:522 / 83`  
**Severity:** Critical  

The `settings:set` IPC handler passes any renderer payload directly to `writeSettingsFile`, which runs `JSON.stringify(full)` and `fs.writeFileSync()` in the main thread without size validation or atomic write. A large or circular payload blocks the main process (UI freeze) and can corrupt `settings.json` if the process crashes mid-write.

**Recommendation:** Validate payload size, ensure it is a plain object, and write to a temp file followed by `fs.rename`.

### 14. `ScmPanel.tsx` — `JSON.parse` Without Guard
**File:** `src/components/ScmPanel.tsx:85`  
**Severity:** Critical  

`JSON.parse(s.active_threats)` is called without `try/catch`. If the API returns malformed JSON, an empty string, or a non-string value, the entire component throws and the React tree crashes.

**Recommendation:** Wrap in `try/catch` and default to `[]`.

### 15. `WorkspacesSettings.tsx` — Workspace Save Crash
**File:** `src/components/WorkspacesSettings.tsx:78,83`  
**Severity:** Critical  

`getCurrentSnapshot()` is called directly inside `saveCurrent` and `updateExisting` without a `try/catch`. If the snapshot function throws (e.g., due to a corrupted map state or a missing layer), the entire component crashes and the user loses their workspace.

**Recommendation:** Wrap `getCurrentSnapshot()` calls in `try/catch` and surface the error via the `notice` state.

---

## High Issues (Significant Risk)

### Frontend / Map
- **`page.tsx:163-164`** — `dataRef.current = data` mutates a ref during render. In React 19 concurrent rendering, renders can be interrupted; mutating refs during render can cause plugins to read torn or partially committed state. **Fix:** Move assignment to `useInsertionEffect` or read directly from the `data` state closure.
- **`page.tsx:1076`** — `LayerPanel` is wrapped in `memo`, but it receives `data` which is always a new object (`setData(prev => ({ ...prev, ...d }))`). This defeats memoization, forcing `LayerPanel` to re-render on every feed update and re-calculate `getCount()` for every layer. **Fix:** Pass only derived counts, or use a context/selector pattern.
- **`HorusMap.tsx:144`** — Map initialization runs in `useEffect(() => {}, [])`. In React Strict Mode (enabled by default in Next.js dev), this effect runs twice. MapLibre's `map.remove()` may not fully release the WebGL context, causing the second `new maplibregl.Map()` to fail. **Fix:** Use a ref guard (`didInit`) or move the map instance to a ref.
- **`page.tsx:617`** — `useFeedEngine` is a custom hook whose source is not in the reviewed set. It receives `fetchEndpoint` and `ifVisible` but we cannot verify it has proper cleanup, `AbortController` management, or limits on parallel fetch concurrency. **Fix:** Audit `useFeedEngine` for cleanup, concurrency limits, and leak-free polling.
- **`HorusMap.tsx:836`** — `map.remove()` in the cleanup function is not wrapped in `try/catch`. If MapLibre throws during cleanup, the remaining cleanup lines are skipped. **Fix:** Wrap `map.remove()` in `try/catch`.
- **`HorusMap.tsx:1190 / 1273`** — `map.flyTo` is called inside the IP sweep and fly-to effects with no coordinate validation or `try/catch`. If coordinates contain `NaN`, `undefined`, or out-of-bounds values, MapLibre may throw. **Fix:** Validate `lat`/`lng` with `Number.isFinite` and bounds checks before calling `map.flyTo`.
- **`page.tsx:1285`** — `SearchBar` receives `onLocate` as an inline anonymous function inside the mobile panel. This creates a new function reference on every `Dashboard` re-render, causing `SearchBar` to re-render unnecessarily. **Fix:** Wrap `onLocate` in `useCallback` at the `Dashboard` level.
- **`page.tsx:206`** — `applyAppearance(settings.appearance)` is called in a `useEffect` with no cleanup. If `applyAppearance` injects styles, event listeners, or DOM nodes, they are never removed on theme changes. **Fix:** Ensure `applyAppearance` returns a cleanup function and invoke it in the effect return.

### OSINT / Intelligence Components
- **`OsintPanel.tsx:706-1031`** — `renderContent()` is a ~325-line inline function recreated on every render. Combined with the inner component definitions, every keystroke or state change triggers a massive re-render cascade. **Fix:** Extract `renderContent` into a separate `memo` component.
- **`OsintPanel.tsx:102-272`** — `runLookup` is a 170-line `useCallback` with a dependency array that includes `loading`, `query`, `activeTab`, `scanType`, `sweepCidr`, and `onScanGeolocate`. `loading` flips constantly, so the callback is invalidated on every request start/end, causing dependent handlers to re-bind. **Fix:** Use a ref for `loading` (e.g., `isLoadingRef`) so it doesn't invalidate the callback.
- **`OsintPanel.tsx:251-260`** — Background geolocation `fetch` uses `.catch(() => {})` with no logging or fallback. **Fix:** At minimum log to `console.error`; ideally surface a subtle status indicator.
- **`LiveAlerts.tsx:208`** — `new Date(alert.time).toLocaleTimeString()` is called without guards. If `alert.time` is missing or invalid, `toLocaleTimeString` throws a `RangeError` in some environments. **Fix:** Wrap in a safe formatter or add a `try/catch`.
- **`MarketsPanel.tsx:82-84`** — `spaceWeather.solar_flares[0].class` is accessed after only checking `?.length > 0`. `spaceWeather` itself is typed as `any`, so if `solar_flares` is a non-array truthy value, the `.length` check could pass and `.map` or index access could fail elsewhere. **Fix:** Add `Array.isArray()` guards.
- **`MarketsPanel.tsx:104-111`** — `markets.scm_alerts.map` assumes `scm_alerts` is an array. If the API returns an object or string, the `.length` check may pass but `.map` will throw. **Fix:** Add `Array.isArray(markets.scm_alerts)`.
- **`CameraViewer.tsx:125-131`** — `AnimatePresence` wraps a single `motion.div` without a `key` tied to camera identity. If the parent swaps camera objects, `AnimatePresence` may skip exit/enter animations or confuse React's reconciliation. **Fix:** Add `key={camId}` to the `motion.div`.
- **`EntityGraphPanel.tsx:156-167`** — The `entity` change `useEffect` fires `expandEntity()` but does not abort an in-flight expansion when `entity` changes again. `expandAbortRef` is only cleaned up on unmount, not on entity switch. **Fix:** Return a cleanup function from the entity effect that calls `expandAbortRef.current?.abort()`.
- **`EntityGraphPanel.tsx:335`** — `ForceGraph2D` is dynamically imported and rendered without an explicit `pauseAnimation()` call on unmount. The library may not always stop the internal d3 simulation promptly, especially under rapid mount/unmount. **Fix:** Add a `useEffect` cleanup that calls `graphRef.current?.pauseAnimation?.()` if available.
- **`CameraViewer.tsx:84-86`** — On HLS fatal error, the code only calls `setError(true)`. It does not destroy the HLS instance. `hlsRef.current` continues to exist and may retry or hold resources until the component fully unmounts. **Fix:** Call `hls.destroy()` inside the fatal error handler and clear `hlsRef.current`.

### Settings / UI Utilities
- **`SettingsPanel.tsx:84`** — `setColor` passes `{ [token]: value }` as the entire `custom` object to `update`. If `update` performs a one-level shallow merge, every color change overwrites all other custom theme tokens. **Fix:** Merge the new token into the existing custom object explicitly: `update({ appearance: { custom: { ...custom, [token]: value } } })`.
- **`SettingsPanel.tsx:140,146`** — `value={custom[token]}` passes `undefined` to controlled inputs when `settings.appearance.custom` is missing or incomplete. React treats this as an uncontrolled-to-controlled transition warning. **Fix:** Default to an empty string: `value={custom?.[token] ?? ''}`.
- **`ExtensionsSettings.tsx:120-127`** — Raw mode mutates the parsed JSON object directly (`spec = parsed; spec.id = ...; delete (spec as any).intervalMs`). If `spec.label` is not a string, `slug(spec.label || 'source')` crashes because `slug` calls `.toLowerCase()` on a non-string. **Fix:** Clone the parsed object first (`spec = { ...parsed }`), then validate types before calling `slug`.
- **`ExtensionsSettings.tsx:39-49`** — `exportBundle` has no error handling around `serializeExtensionBundle` or `exportExtensionBundle`. If either throws, the error propagates uncaught from the click handler. **Fix:** Wrap the export logic in `try/catch` and surface the error to the user.
- **`ExtensionsSettings.tsx:161,327,328`** — `removeCustomSource`, `setPluginEnabled`, and `uninstallPlugin` are called synchronously without `try/catch`. If the plugin registry throws, the component crashes. **Fix:** Wrap all plugin mutation calls in `try/catch` with user-facing error feedback.
- **`ExtensionsSettings.tsx:48`** — `URL.revokeObjectURL(url)` is deferred via `setTimeout(..., 1000)` with no cleanup on unmount. If the component unmounts before the timeout fires, the blob URL leaks. **Fix:** Use `useRef` to track the URL and revoke it in a `useEffect` cleanup.
- **`WorkspacesSettings.tsx:94,108`** — `duplicate` and `load` pass `ws.state` by reference. If `onApply` mutates the snapshot object, the saved workspace data is corrupted. **Fix:** Deep-clone `ws.state` before passing to `onApply` or saving (e.g., `structuredClone(ws.state)`).
- **`WorkspacesSettings.tsx:206,221,228`** — `load`, `duplicate`, and `remove` call external callbacks (`onApply`, `persist`) without `try/catch`. If `onApply` or `update` throws, the error is unhandled. **Fix:** Wrap callback invocations in `try/catch` and show an error notice.
- **`SharePanel.tsx:41,51`** — `setTimeout(() => setCopied(false), 2000)` is created in `copyToClipboard` but never cleaned up. If the panel unmounts before the timeout fires, React will attempt a state update on an unmounted component. **Fix:** Store the timeout ID in a `useRef` and clear it in a `useEffect` cleanup.
- **`SharePanel.tsx:58`** — The `S` keyboard shortcut checks `!e.ctrlKey && !e.metaKey` but misses `e.altKey` and `e.repeat`. Holding `S` causes rapid toggling, and `Alt+S` accidentally triggers the panel. **Fix:** Add `!e.altKey && !e.shiftKey && !e.repeat` guards.
- **`KeyboardShortcuts.tsx:21-29`** — The global `keydown` listener does not call `e.stopPropagation()` or `e.preventDefault()`, and there is no collision-avoidance system. If another component also registers a global handler, both will fire. **Fix:** Add `e.stopPropagation()` inside the handler and consider a central keyboard manager.
- **`SettingsPanel.tsx:90`** — `window.horus?.relaunch?.()` is called without error handling. If the desktop API throws, the exception is unhandled. **Fix:** Wrap in `try/catch` and show an error message.

### Core Libraries / Data Layer
- **`ssrf-guard.ts:62`** — `AbortSignal.any(...)` is used without feature detection. This API is only available in Node.js ≥ 20.0.0 / v18.17.0+ and very recent browsers. Running on older runtimes throws a `TypeError` and crashes the request. **Fix:** Add a polyfill or guard: `typeof AbortSignal.any === 'function' ? AbortSignal.any([...]) : parentSignal || timeoutController.signal`.
- **`ssrf-guard.ts:268-279`** — `isRateLimited` mutates `rateMap` while iterating it with `for...of`. In some JS engine implementations, deleting entries ahead of the iterator can cause unvisited entries to be skipped, leaving stale rate-limit buckets alive. **Fix:** Collect expired keys into a separate array and delete after the loop.
- **`sanctions.ts:120-127`** — `loadList` throws on non-OK HTTP status before consuming the response body. The undici fetch body remains unread, leaking the underlying connection. **Fix:** Call `await res.body?.cancel()` before throwing, or read the body first and then validate.
- **`ai-engine.ts:204-213`** — `rotateApiKey` relies on a module-level mutable counter (`_keyIndex`) with no synchronization primitive. In a concurrent server environment, interleaved requests can cause the same key to be selected repeatedly or the counter to drift. **Fix:** Use an atomic increment (e.g., `Atomics.add` on a shared buffer, or a per-request key selection based on a hash).
- **`osint-utils.ts:166-189`** — `batchFetch` accepts `concurrency` without validation. A `concurrency` of `0` creates zero workers and returns an array of `null`s; a very large value creates an enormous array of worker promises and can OOM. **Fix:** Clamp `concurrency` to a sensible range (e.g., `Math.max(1, Math.min(concurrency, 100))`) and log a warning if adjusted.
- **`stealthFetch.ts:58-79`** — `stealthHeaders` generates a random residential IP via `generateResidentialIP()` but then discards it; the IP is never attached to any header. The computation is wasted on every request. **Fix:** Either attach the IP to a relevant header (e.g., `X-Forwarded-For`) or remove the generation entirely.
- **`stealthFetch.ts:90-98`** — Header normalization uses `Object.fromEntries`, which silently drops duplicate header names (e.g., multiple `Cookie` values). **Fix:** Pass the original `Headers` object directly into the new fetch init instead of converting to a plain object.
- **`proxy.ts:17`** — `ip` extraction from `x-forwarded-for` falls back to the raw header string, which may contain multiple comma-separated IPs. This malformed value is passed back as the `x-forwarded-for` header to Umami and into the payload. **Fix:** Always split and trim the first IP, or use a dedicated `getClientIp` utility.
- **`http-utils.ts:91-93`** — `cloneJson` uses `JSON.parse(JSON.stringify(value))` without circular-reference protection. On circular input it throws a `TypeError`. **Fix:** Document the limitation or replace with a safe structured-clone fallback.
- **`ai-engine.ts:356-417`** — `analyzeIntelligence` and `generateBriefing` call `client.getGenerativeModel({ ... })` on every invocation, creating a new model instance. If the SDK re-instantiates a gRPC channel each time, this adds latency and resource churn. **Fix:** Cache the `GenerativeModel` instance per client/system-instruction combo.
- **`ai-engine.ts:377-384`** — No retry logic for transient Gemini failures (5xx, rate-limit, timeout). The `withTimeout` wrapper aborts at 30 s, but a single hiccup fails the whole analysis. **Fix:** Add 1–2 retries with exponential backoff for idempotent timeout/rate-limit errors.
- **`ssrf-guard.ts:101-111`** — `lookupWithTimeout` races DNS lookup against a timer, but the `lookup` promise is never cancelled if the timer wins. It lingers in the event loop until the OS resolver returns. **Fix:** Use a cancellable DNS resolver or bound the number of concurrent lookups.
- **`sanctions.ts:120-123`** — `AbortSignal.timeout(30_000)` is used without feature detection. Same compatibility risk as `AbortSignal.any`. **Fix:** Add a guard or use a manual `AbortController` + `setTimeout` wrapper.

### Desktop / Backend / Config
- **`intel/server.js:801`** — `isRateLimited` iterates over the entire `rateMap` (up to 10,000 entries) on every request to evict stale entries. **Fix:** Switch to a periodic cleanup interval or a time-ordered Map/queue.
- **`desktop/main.js:444`** — `createWindow` only attaches `webContents.on('did-fail-load')` in `SMOKE` mode. In normal operation, if the embedded server or dev URL fails to load, the user is left with a blank window and no automatic recovery. **Fix:** Attach a `did-fail-load` handler that falls back to the splash page and logs the failure.
- **`desktop/main.js:76 / 86`** — `readSettingsFile` and `writeSettingsFile` use synchronous `fs.readFileSync` / `fs.writeFileSync` inside the main process. **Fix:** Use `fs.promises.readFile` and `fs.promises.writeFile` (or atomic temp-write + rename).
- **`docker-compose.yml:32 / 52`** — The `horus` healthcheck hits `http://127.0.0.1:3000/api/health` and the `horus-cache` healthcheck hits `http://127.0.0.1:8080/health`. Neither endpoint is visible in the reviewed source files. **Fix:** Verify the routes exist or align the healthcheck URLs with actual endpoints.
- **`docker-compose.yml:73 / 149`** — The `horus` app service does not declare `depends_on` for `horus-intel` or `scanner`. **Fix:** Add `depends_on` with `condition: service_healthy` where the app truly requires the backend.
- **`scanner/server.js:372`** — No rate limiter or global concurrency cap exists on any scanner endpoint. **Fix:** Add a per-IP rate limiter (similar to `intel/server.js`) and a global semaphore for concurrent `portScan` jobs.
- **`scanner/server.js:388`** — Each `/scan/quick` request launches `PORT_SCAN_CONCURRENCY = 100` sockets, but there is no global cap on total sockets across concurrent requests. 10 simultaneous requests = 1,000 open sockets, risking file-descriptor exhaustion. **Fix:** Add a global semaphore for `probePort` sockets.
- **`intel/server.js:839 / 840`** — `req.query.type` and `req.query.id` are accessed with `.toLowerCase()` and `.trim()` without checking if Express returned an array (duplicate query params). **Fix:** Coerce to string first: `String(req.query.id || '').trim()`.
- **`scanner/server.js:374 / 91`** — `req.query.target` is passed to `validateTarget` which does `(raw || '').trim()`. If `raw` is an array (repeated `target` param), this throws `TypeError`. **Fix:** Coerce to string before trimming.
- **`desktop/main.js:341`** — `startEmbeddedServer` has a synchronous `if (serverChild) return` guard, but the function is async. Concurrent calls could both pass the guard before `serverChild` is assigned. **Fix:** Add a promise-based lock or an `isStarting` flag.
- **`desktop/main.js:22–31`** — Heavy reliance on mutable top-level variables (`win`, `serverChild`, `managedBackends`, etc.). **Fix:** Encapsulate state in a class or closure.
- **`intel/server.js:1`** — `intel/server.js` is a ~920-line god module mixing configuration, data loading, caching, SPARQL, resolvers, rate limiting, and HTTP routes. **Fix:** Split into separate modules (e.g., `resolvers/`, `routes/`, `cache/`).
- **`desktop/main.js:1`** — `desktop/main.js` is a ~593-line god module mixing window management, child-process lifecycle, backend orchestration, IPC, and smoke testing. **Fix:** Split into `window-manager.js`, `server-lifecycle.js`, and `ipc-handlers.js`.
- **`desktop/main.js:571–587`** — `SIGTERM`/`SIGINT` handlers plus `unhandledRejection`/`uncaughtException` all call `app.quit()`. On Windows, Electron may not receive these signals, and `uncaughtException` cannot reliably prevent a crash. **Fix:** Add a hard `app.exit()` fallback after a timeout.

---

## Medium Issues (Moderate Impact — Should Fix)

### Frontend
- **`AiAnalyst.tsx:218-220`** — `messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })` runs on every `messages` change. With rapid updates, this can cause jank. **Fix:** Debounce or use `requestAnimationFrame` guard.
- **`AiAnalyst.tsx:224-227`** — `setTimeout(() => inputRef.current?.focus(), 300)` has no cleanup if the panel closes before the timeout fires. **Fix:** Store timeout ID and clear in cleanup.
- **`LiveAlerts.tsx:62-99`** — `data.news` is iterated without an upstream slice. If the parent feeds thousands of items, `alerts` becomes huge. **Fix:** Cap `data.news` intake to a reasonable limit (e.g., 50) inside the `alerts` builder.
- **`LiveAlerts.tsx:179`** — Inline `onClick` arrow created for every alert item on every render. **Fix:** Extract to a stable handler or wrap items in `React.memo`.
- **`MarketsPanel.tsx:28-33`** — `d.change_percent?.toFixed(2)` renders `undefined%` when `change_percent` is missing. **Fix:** Coalesce to `0` or `—` before formatting.
- **`MarketsPanel.tsx:129-131`** — `createPortal` used with a `mounted` guard that defers portal creation to the second render. On first SSR/hydration render, the fixed positioned content is rendered in the normal DOM tree. **Fix:** Use `useSyncExternalStore` or check `typeof window !== 'undefined'` at render time.
- **`CameraViewer.tsx:76`** — HLS is initialized with `enableWorker: false`. Demuxing runs on the main thread and can cause frame drops. **Fix:** Remove the flag and let HLS use its default worker.
- **`CameraViewer.tsx:22-28`** — Clock `setInterval` (1s) runs regardless of whether a camera is active. The component returns `null` when `!camera`, but the effect is already running. **Fix:** Move clock effect inside the main conditional or add `if (!camera) return;` early.
- **`SearchBar.tsx:62`** — Nominatim `fetch` has no timeout. **Fix:** Add an `AbortController` with a 5 s timeout.
- **`page.tsx:775 / 1250`** — `AnimatePresence` in the mobile drawer and slideout panels is missing `mode="wait"`. Rapid toggling can cause overlapping animations. **Fix:** Add `mode="wait"` where children are mutually exclusive.
- **`HorusMap.tsx:1285`** — `(map as any).setProjection` bypasses TypeScript safety. **Fix:** Use proper MapLibre typings or check for method existence.
- **`HorusMap.tsx:1307`** — Satellite style switch adds `satellite-tiles` source and `satellite-layer` once, but never removes them when switching back to dark mode. **Fix:** Remove the source and layer when switching back, or document the overhead.
- **`GlobalStatusBar.tsx:23`** — The fetch interval has no retry logic on failure. If the backend is temporarily down, the component waits 30 minutes before retrying. **Fix:** Add retry with exponential backoff (e.g., retry 3 times with 5 s, 15 s, 45 s delays).
- **`page.tsx:571`** — `(window as any).openHorusIntel = ...` is a mutable global assignment. If the component mounts/unmounts rapidly, the window property may be deleted while a callback is still trying to use it. **Fix:** Use a ref-stable callback registry instead of `window` globals.
- **`page.tsx:1182`** — `iframe` for live feeds has no `onLoad` or `onError` handlers. **Fix:** Add loading and error states.
- **`page.tsx:162`** — Extensive use of `any` across the codebase (`data`, `globalStats`, `regionDossier`, `spaceWeather`, `sweepData`, etc.). **Fix:** Gradually replace `any` with domain-specific interfaces.
- **`LayerPanel.tsx:13`** — `data` and `activeLayers` props are typed as `any`. **Fix:** Define strict interfaces.

### Settings / UI
- **`WorkspacesSettings.tsx:176`** — `activeCount` is computed inline inside the `workspaces.map` callback for every workspace on every render. **Fix:** Precompute counts or use `useMemo` on the workspace list.
- **`ExtensionsSettings.tsx:304`** — `onFile` processes all files from `e.target.files` without a batch limit. A user dropping hundreds of files could freeze the UI. **Fix:** Cap the loop at a reasonable number (e.g., 20 files) and show a warning for the rest.
- **`ExtensionsSettings.tsx:306`** — `setError` is called inside a `for` loop over files. Each iteration overwrites the previous error, so only the last file's error is surfaced. **Fix:** Collect all errors into an array and display them together.
- **`SharePanel.tsx:120`** — `generateShareUrl()` is called inline four times per render when the panel is open. **Fix:** Compute the URL once when `isOpen` is true and store it in state or `useMemo`.
- **`SharePanel.tsx:58`** — The `tagName` check only excludes `INPUT` and `TEXTAREA`. It misses `SELECT`, elements with `contentEditable`, and custom interactive components. **Fix:** Also check `contentEditable === 'true'` and consider a `data-shortcuts="disabled"` attribute.
- **`KeyboardShortcuts.tsx:23`** — Same incomplete `tagName` check as SharePanel. **Fix:** Same fix as above.
- **`WorkspacesSettings.tsx:54,58`** — `nameTaken` and `uniqueName` are recreated on every render. **Fix:** Memoize with `useCallback`.
- **`SettingsPanel.tsx:83-84,86-92`** — `setColor` and `saveKeys` are recreated on every render. **Fix:** Wrap in `useCallback`.
- **`SettingsPanel.tsx:247`** — `memo(SettingsPanel)` is used, but if the parent passes new function references for `getWorkspaceSnapshot` or `onApplyWorkspace` on every render, memoization is ineffective. **Fix:** Ensure the parent memoizes these callbacks.

### Core Libraries
- **`bulgaria-sources.ts:68`** — `parseNigggXml` uses global `isNaN` instead of `Number.isNaN`. `isNaN` coerces non-number values, which can produce false positives. **Fix:** Use `Number.isNaN(parseFloat(...))`.
- **`bulgaria-sources.ts:46-87`** — `parseNigggXml` does not bound the input size. An accidentally huge XML payload could pin the process in regex matching. **Fix:** Add a length guard before running the regex.
- **`ssrf-guard.ts:79-87`** — `ipv4InBlocked` recomputes `ipv4ToInt` for every block on every call. The block list is static. **Fix:** Precompute block min/max integers once at module load.
- **`proxy.ts:31-37`** — `send()` swallows all errors with `.catch(() => {})`. Analytics failures are invisible. **Fix:** Log failures with `console.warn` or a lightweight logger.
- **`ai-engine.ts:277`** — `generateLocalBriefing` falls back to `new Date().toISOString()` without respecting the user's locale or the platform's configured timezone. **Fix:** Use the NZST timezone explicitly or accept a timezone parameter.
- **`ai-engine.ts:24-59`** — `withTimeout` creates an `abortPromise` listener that remains on the `controller.signal` until garbage collected, even if the main promise wins the race. **Fix:** Remove the `abortPromise` listener in the `finally` block as well.
- **`osint-utils.ts:91-93`** — `calculateSubnetStart` assumes `cidr` is in `[0, 32]`. No runtime validation. Invalid `cidr` produces wrong bitmasks due to JavaScript's modulo-32 shift behavior. **Fix:** Clamp `cidr` to `[0, 32]` or throw on invalid input.

### Desktop / Backend / Config
- **`desktop/after-pack.js:32`** — `fs.cpSync` is used inside an async `afterPack` hook. **Fix:** Use `fs.cp` (async) for better hygiene.
- **`electron-builder.yml`** — Only Windows (`nsis`) is configured. If macOS/Linux support is intended, targets are missing. Also, the Windows executable will be unsigned, causing SmartScreen warnings. **Fix:** Add platform targets and signing config if needed.
- **`next.config.ts:15`** — `images.remotePatterns` allows `hostname: '**'` over HTTPS. Very broad; images from unreliable hosts can slow page loads or fail. **Fix:** Restrict to known intelligence domains.
- **`scanner/server.js:111`** — The hostname regex in `validateTarget` rejects IDNs and underscores. **Fix:** Broaden the regex if internationalized domains are needed.
- **`desktop/main.js:356`** — `logFd` is closed synchronously with `fs.closeSync` before opening a new one. Could be async for consistency. **Fix:** Use `fs.close` for consistency.

---

## Low Issues (Minor Improvements)

- **`ScaleBar.tsx:18`** — `useMemo` is used for a trivial arithmetic calculation. The overhead likely exceeds the cost. **Fix:** Remove `useMemo` and compute inline.
- **`page.tsx:52`** — `UptimeClock` and `ZuluClock` are not wrapped in `memo`. They re-render whenever `Dashboard` re-renders. **Fix:** Wrap in `memo` if profiling shows a benefit.
- **`SearchBar.tsx:123`** — Result list `key` is built from `${r.lat}:${r.lng}:${r.label}`. If two results share the same coordinates and label, React will warn about duplicate keys. **Fix:** Use a stable index or a hash if the API provides an ID.
- **`ViewPresets.tsx:37`** — `(p as any).hot` is a type assertion. **Fix:** Add `hot?: boolean` to the preset interface.
- **`layout.tsx:176`** — `import ErrorBoundary` is placed at the bottom of the file after module-level code. Valid ESM but unconventional. **Fix:** Move the import to the top.
- **`page.tsx:1401`** — `vignette` and `crt-scanlines` overlays are always rendered, even on mobile where they add DOM nodes that may not be visible. **Fix:** Conditionally render based on `isMobile` or a performance flag.
- **`SharePanel.tsx:43-49`** — The fallback `document.execCommand('copy')` is deprecated and can fail silently. The code still calls `setCopied(true)` even if the fallback fails. **Fix:** Check the return value of `document.execCommand('copy')` before setting the success state.
- **`ExtensionsSettings.tsx:45`** — The download anchor is clicked without being appended to the DOM. This works in most modern browsers but is not guaranteed everywhere. **Fix:** Append to `document.body`, click, then remove.
- **`ExtensionsSettings.tsx:81`** — Error list keys use `key={`${item}-${i}`}`, which can still collide if the same error message appears twice. **Fix:** Use a stable unique ID or just `i` if the list is append-only.
- **`SharePanel.tsx:13`** — Component is not wrapped in `React.memo`. It will re-render whenever the parent re-renders, even if props are unchanged. **Fix:** Add `memo` since the panel is likely a persistent UI element.
- **`WorkspacesSettings.tsx:17-19`** — `newId()` uses `Math.random()` for entropy. **Fix:** Use `crypto.randomUUID()` if the target environment supports it.
- **`OsintPanel.tsx:34 / 197`** — `TABS` does not include a `crypto` tab, but the `runLookup` switch handles `case 'crypto'`. **Fix:** Either add a `crypto` tab to `TABS` or remove the case.
- **`OsintPanel.tsx:682-704`** — `renderFallback` does `JSON.stringify(value, null, 1)` on every render. If `value` is large, this is expensive. **Fix:** Only stringify once or memoize.
- **`ScmPanel.tsx:127`** — `p.volume.split(' | ')[1]` is used without checking that `volume` is a string or contains the delimiter. **Fix:** Defensive split.
- **`EntityGraphPanel.tsx:313 / 364`** — IIFE pattern `(() => { const I = ...; return <I ... /> })()` is used twice for icon resolution. Slightly obfuscates the JSX. **Fix:** Extract a small `EntityIcon` component.
- **`IntelFeed.tsx:93`** — `news.slice(0, 25)` caps the render list, but the `key` fallback uses `item.link` which may be undefined. **Fix:** Ensure stable IDs upstream.
- **`AiAnalyst.tsx:640-711`** — Message list uses `motion.div` per message. With 100 messages, this is acceptable, but there is no virtualizer. **Fix:** Consider `react-window` if conversations grow beyond 100.
- **`MarketsPanel.tsx:116-118`** — `Object.entries(markets[activeSection]).map(...)` iterates over the entire section object every render. **Fix:** Wrap in `useMemo`.
- **`MarketsPanel.tsx:51`** — `className` string includes `transition-all duration-300` on a glass panel that may re-render frequently. **Fix:** Remove `transition-all` or scope it to `maximized` only.
- **`OsintPanel.tsx:113`** — `Math.pow(2, 32 - cidr)` is safe because CIDR is restricted to `[24,28]`, but if the state is ever manipulated externally, it could explode. **Fix:** Clamp `cidr` before calculating `totalHosts`.
- **`OsintPanel.tsx:59 / 64-66`** — `cveCache` state and `cveCacheRef` are kept in sync via a dedicated `useEffect`. Slightly redundant. **Fix:** Use `useRef` only for reads and `useState` only for UI-triggered updates.
- **`IntelFeed.tsx:99-100`** — `onClick` and `onKeyDown` have divergent behavior: `onClick` falls back to `setSelectedIdx` when `item.link` is missing, but `onKeyDown` does nothing. **Fix:** Align both handlers.
- **`MarketsPanel.tsx:22`** — `Ticker` returns `null` if `!d`, but if `d` is an empty object, it renders with empty/undefined values. **Fix:** Validate required fields (`price`, `change_percent`) explicitly.
- **`EntityGraphPanel.tsx:387-391`** — `expandedIds` check uses `selectedNode.id.includes(':') ? ...` to derive `rawId`. If the ID format changes, the logic falls back to the full ID. **Fix:** Use a stable helper for ID parsing.
- **`OsintPanel.tsx:274-277`** — `lookupAbortRef` and `cveAbortRef` are only aborted on unmount. If the panel is mounted/unmounted frequently, requests are aborted after the user has already left the view. **Fix:** Ensure parent also gates lookups when the panel is hidden.
- **`AiAnalyst.tsx:209-215`** — `localStorage.getItem('horus-gemini-key')` has no `try/catch`. In sandboxed environments this can throw. **Fix:** Wrap in `try/catch`.

---

## Positive Observations

**Bounded Growth & Caching:**
- `page.tsx:98-125` — `capDataPayload` enforces strict per-type array size limits (e.g., cameras 5,000, news 500).
- `page.tsx:220` — `geocodeCache` uses a `Map` with FIFO eviction (max 500 entries).
- `OsintPanel.tsx:36-41` — CVE cache is explicitly capped at `MAX_CVE_CACHE_ENTRIES = 200` with a FIFO eviction policy.
- `OsintPanel.tsx:54` — Scan history is hard-capped at 10 entries via `slice(0, 9)`.
- `EntityGraphPanel.tsx:31-32` — Graph nodes and links are hard-capped at 500 and 2,000 respectively.
- `intel/server.js` — `wdCache` capped at 10,000 entries and `rateMap` at 10,000 IPs.
- `scanner/server.js` — Port scan concurrency limited to 100 sockets per request with a curated ~120-port list.
- `WorkspacesSettings.tsx` — Enforces `MAX_WORKSPACES = 50`.
- `AiAnalyst.tsx:190-194` — Chat messages are capped at `MAX_MESSAGES = 100` with a FIFO slice.

**Resource Cleanup & Abort Hygiene:**
- `HorusMap.tsx:836-842` — Explicit cleanup for `ResizeObserver`, `Popup`, and `Map` on unmount.
- `CameraViewer.tsx:49-67` — HLS cleanup is thorough: destroys HLS instance, removes event listeners, pauses video, removes `src`, and calls `load()`.
- `CameraViewer.tsx:118-120` — JPG auto-refresh interval is correctly scoped and cleaned up.
- `EntityGraphPanel.tsx:72-85` — `ResizeObserver` is properly disconnected in the effect cleanup.
- `ai-engine.ts:24-59` — `withTimeout` helper links an external `AbortSignal`, creates a local timeout, and **clears the timer and removes the parent listener in `finally`**, preventing the most common fetch-timeout leaks.
- `stealthFetch.ts:100-117` — `stealthFetch` correctly propagates the caller's `AbortSignal` into a composite controller and cleans up both the timeout and the external listener in `finally`.
- `ssrf-guard.ts:218-252` — `safeFetch` implements manual redirect chasing with **re-validation at every hop**, including `res.body?.cancel()` before following a redirect.
- `sanctions.ts:116-187` — `loadList` uses a correct **single-flight** pattern (`inflight` promise) so concurrent callers share one fetch and never stampede the upstream CSV.

**Error Boundaries & Resilience:**
- `ErrorBoundary` wraps both the root layout and the map, providing resilience against child crashes.
- `page.tsx:613-615` — `ifVisible` wrapper throttles background polling when the tab is hidden, saving battery and bandwidth.
- `page.tsx:356-373` — URL state sync is debounced (1500ms), preventing excessive `history.replaceState` calls.
- `GlobalStatusBar.tsx:29` — Uses `Promise.allSettled` for concurrent fetches, ensuring one failed request doesn't block the other.
- `SearchBar.tsx:58-76` — Uses `AbortController` + `setTimeout` debounce for geocoding, preventing race conditions and redundant requests.
- `SettingsPanel.tsx` — Correctly avoids a hydration mismatch by reading `window.horus` inside `useEffect` rather than during render.
- `WorkspacesSettings.tsx` — Implements flash auto-dismiss with proper `clearTimeout` cleanup in the effect teardown.
- `WorkspacesSettings.tsx` — Has case-insensitive name collision detection, protecting data integrity.
- `SharePanel.tsx` and `KeyboardShortcuts.tsx` — Both register and properly clean up global `keydown` listeners.
- `ExtensionsSettings.tsx` — Wraps `JSON.parse` in `try/catch` and validates specs before persisting.
- `SettingsPanel.tsx` — Uses `memo` to reduce unnecessary re-renders.

**Electron Hardening:**
- `BrowserWindow` hardening: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a minimal `preload.js` surface reduce renderer crash blast radius.
- `app.requestSingleInstanceLock()` prevents duplicate app instances.
- Resilient child-process restarts: Both the Next.js server and bundled backends have exponential backoff, attempt caps, and stable-reset timers.
- IPC safety: `main.js` uses `ipcMain.handle` (async) instead of sync `ipcMain.on` for all channels.
- Robust build script: `prepare-standalone.js` has a three-tier fallback strategy for npm install failures.

**Docker & Orchestration:**
- `docker-compose.yml` — Every service has a healthcheck and `unless-stopped` restart policy.
- Graceful shutdown hooks: Both backend servers close their HTTP servers and exit on `SIGTERM`/`SIGINT`.

---

## Priority Action Plan

### 🔥 Immediate (This Week)

1. **Split `Dashboard` and `data` state** — `src/app/page.tsx`  
   Decompose the 1,430-line root component and split the monolithic `data` object into independent state atoms (or use context selectors) to eliminate full-tree re-renders. This is the single biggest performance win.

2. **Extract inner components from `OsintPanel`** — `src/components/OsintPanel.tsx:283-339`  
   Move `ResultRow`, `StatusBadge`, `SanctionsBadge`, `SectionHeader`, and `PortRow` to top-level module declarations. This alone eliminates catastrophic layout thrashing.

3. **Add fetch timeouts everywhere** — `src/app/page.tsx:590`, `src/components/AiAnalyst.tsx:252-289`, `src/components/SearchBar.tsx:62`  
   Wrap every `fetch` in `Promise.race` with a 15 s / 5 s timeout using `AbortController`.

4. **Guard `stableStringify` against circular references** — `src/lib/http-utils.ts:10-25`  
   Add a `seen` `WeakSet` to prevent stack-overflow crashes.

5. **Store and clear restart timers in Electron** — `desktop/main.js:149 / 320`  
   Prevent orphaned child processes on app quit by storing timer refs and clearing them in stop handlers.

6. **Harden MapLibre lifecycle** — `src/components/HorusMap.tsx:151 / 836`  
   Wrap `new maplibregl.Map()` and `map.remove()` in `try/catch`, and validate coordinates with `Number.isFinite` before `map.flyTo`.

7. **Add response byte limits to scanner** — `scanner/server.js:256`  
   Prevent OOM from unbounded HTML fetches by using a streaming reader or aborting at a byte limit.

8. **Cancel fetch response bodies in proxy** — `src/proxy.ts:31-37`  
   Chain `.then(async (res) => { await res.body?.cancel(); })` to prevent connection-pool exhaustion.

9. **Fix API key race condition in SettingsPanel** — `src/components/SettingsPanel.tsx:73-78`  
   Remove `settings.apiKeys` from the `useEffect` dependency array to prevent wiping user edits.

10. **Validate `mapView.zoom` before `toFixed`** — `src/components/SharePanel.tsx:23,105`  
   Guard with `Number.isFinite` to prevent `TypeError` crashes.

### 📅 Short-Term (Next 2 Weeks)

11. **Add `try/catch` around `JSON.parse` in `ScmPanel`** — `src/components/ScmPanel.tsx:85`
12. **Wrap workspace snapshot in `try/catch`** — `src/components/WorkspacesSettings.tsx:78,83`
13. **Add `AbortController` to `EntityGraphPanel` expansion** — `src/components/EntityGraphPanel.tsx:156-167`
14. **Destroy HLS on fatal error** — `src/components/CameraViewer.tsx:84-86`
15. **Feature-detect `AbortSignal.any` and `AbortSignal.timeout`** — `src/lib/ssrf-guard.ts:62`, `src/lib/sanctions.ts:120-123`
16. **Fix `setColor` shallow-merge bug** — `src/components/SettingsPanel.tsx:84`
17. **Deep-clone workspace state before passing** — `src/components/WorkspacesSettings.tsx:94,108`
18. **Clamp `batchFetch` concurrency** — `src/lib/osint-utils.ts:166-189`
19. **Cache `GenerativeModel` instances** — `src/lib/ai-engine.ts:356-417`
20. **Add retry with exponential backoff to AI calls** — `src/lib/ai-engine.ts:377-384`

### 🏗️ Architectural (Next Month)

21. **Decompose `intel/server.js`** (~920 lines) into `resolvers/`, `routes/`, `cache/`
22. **Decompose `desktop/main.js`** (~593 lines) into `window-manager.js`, `server-lifecycle.js`, `ipc-handlers.js`
23. **Replace `any` types with domain interfaces** across `page.tsx`, `LayerPanel.tsx`, `MarketsPanel.tsx`
24. **Add a central keyboard manager** to prevent shortcut collisions
25. **Implement a global socket semaphore** in `scanner/server.js` to cap total open sockets across all concurrent requests
26. **Switch `intel/server.js` rate-limiter to a periodic cleanup** or time-ordered queue instead of O(n) per-request eviction
27. **Add graceful shutdown timeout fallback** in Electron (`app.exit()` after `SIGTERM`/`uncaughtException`)
28. **Validate Docker healthcheck endpoints** or align `docker-compose.yml` with actual routes
29. **Add `depends_on` with `condition: service_healthy`** in `docker-compose.yml`

---

## Appendix: Grades by Domain

| Domain | Stability | Functionality | Performance |
|---|---|---|---|
| **Frontend Main App + Map** | B | B | C |
| **OSINT + Intelligence Components** | C– | C | D+ |
| **Settings + UI Utilities** | C+ | B | B+ |
| **Core Libraries + Data Layer** | C+ | B | B |
| **Desktop + Backend + Config** | C+ | B | B– |
| **Overall** | **C+** | **C+** | **C** |

---

*Review conducted across 5 parallel specialist agents covering: Frontend App & Map, OSINT & Intelligence Components, Settings & UI Utilities, Core Libraries & Data Layer, and Desktop/Backend/Config.*
