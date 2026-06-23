# OSIRIS Code Review — Delta Pass (Phase 2 Step 4z)

> **Scope:** Stability and performance only. Security is out of scope.
> **Focus:** Changes since commit `a931f34` (`f552ff3` and `52a68c2`) — registry Phase 2 Step 4z.
> **Previous review:** `STABILITY_PERFORMANCE_REVIEW.md` (130 findings, 8 Critical, 25 High).
> **Test result:** 38/39 pass, 1 failure (test maintenance issue, not a code bug).

---

## Grade

| Area | Grade | Trend |
|------|-------|-------|
| Connection / Resource Management | A | Stable |
| Rendering Performance | A− | Stable |
| Error Handling & Resilience | A | Stable |
| Frontend State & Lifecycle | B+ | Slight regression risk |
| Test Maintenance | B | 1 test stale after refactor |

**Overall: B+ → A−** (Phase 2 registry migration is well-engineered, minor polish items remain.)

---

## Verified Fixes (from previous review)

These patterns confirmed fixed in the current tree:

- ✅ `releaseResponseBody` / `await res.body?.cancel()` wired into all affected API routes.
- ✅ `AbortController` on all frontend fetch calls (page.tsx, EntityGraphPanel, OsintPanel, SearchBar, GlobalStatusBar).
- ✅ `PolybolosClient` has SSE reconnect with backoff (`sseReconnectAttempts`, `SSE_RECONNECT_MAX_MS`, `scheduleSseReconnect`, `lastSseHeartbeatAt`).
- ✅ `desktop/main.js` has `SERVER_STABLE_RESET_MS`, `MAX_RENDERER_RELOADS`, `scheduleRendererReload`.
- ✅ `sdk/stream/route.ts` has bounded connection limit (`MAX_SDK_STREAM_CONNECTIONS`, `MAX_SDK_STREAM_LIFETIME_MS`).
- ✅ CCTV fanout uses `Promise.allSettled`, `AbortController`, and `seenCameraIds` dedup.
- ✅ `DATA_ARRAY_LIMITS` / `capDataPayload` in page.tsx.
- ✅ `MAX_GRAPH_NODES`, `MAX_GRAPH_LINKS` in EntityGraphPanel.
- ✅ Feed engine (`engine.ts`) has `controllersRef`, `lazyIntervalsRef`, abort-on-unmount.
- ✅ `mapEngine.ts` isolates bad specs with `try { map.addSource/addLayer } catch`.
- ✅ `MAX_MESH_NODES = 750` cap in `builtins.ts` (moved from OsirisMap).

---

## New Findings

### M1 — Test stale after `MAX_MESH_NODES` migration *(Low / Maintenance)*

| | |
|---|---|
| **File** | `tests/performance-stability.test.mjs:449` |
| **Issue** | The test `map popups and computed meshes guard malformed or oversized data` asserts `/MAX_MESH_NODES/` against `src/components/OsirisMap.tsx`. As part of the Phase 2 registry migration, `MAX_MESH_NODES` was moved to `src/lib/registry/builtins.ts:16`. The test fails because the constant no longer lives in the old file. |
| **Fix** | Change the test assertion to read `src/lib/registry/builtins.ts` instead of `src/components/OsirisMap.tsx`. |
| **Effort** | Trivial (1 line). |

---

### M2 — Dynamic layer re-registration on every `theme` change *(Low / Performance)*

| | |
|---|---|
| **File** | `src/components/OsirisMap.tsx:916` |
| **Issue** | The dynamic layers `useEffect` depends on `theme`. When the user toggles ghost mode, every custom/plugin layer is torn down and re-registered via `addRegistryLayer`. This is unnecessary for dynamic layers that do **not** use `Themed<T>` paint/layout — most plugin layers will have static colors. The builtin theme-aware layers (cctv, surveillance) are already handled in-place by the dedicated `setPaint` effect at line 936. |
| **Impact** | Bounded work (number of dynamic layers × style layers), but causes map layer add/remove churn and interaction handler re-wiring on every theme switch. With many plugins this could cause frame drops. |
| **Fix** | Skip `theme` in the dynamic layer effect. For dynamic layers that *do* need theme-aware paint, either (a) resolve `Themed<T>` in the existing `setPaint` effect by inspecting `getLayer(id).styleLayers`, or (b) add a lightweight `updateRegistryLayerTheme(map, layerId, theme)` that only re-resolves paint/layout without tearing down sources. |
| **Effort** | Low–Medium. |

---

### M3 — Dynamic layer `onEntityClick` interaction handler closure captures stale `onEntityClick` ref *(Low / Correctness)*

| | |
|---|---|
| **File** | `src/components/OsirisMap.tsx:883–905` |
| **Issue** | The `onClick` handler inside the dynamic layer effect closes over `onEntityClick` directly: `inter.onClick({ ... })` and `(onEntityClick ?? getHost().openEntityGraph)(ref)`. Because `onEntityClick` is stable (`useCallback([], ...)` in page.tsx), this is currently safe. However, if a future refactor changes `handleEntityClick` to include state variables in its dependency array, the captured `onEntityClick` in already-wired handlers will be stale. The builtin click handlers in `OsirisMap` (e.g. flights at line 346) use the same pattern and are stable. |
| **Impact** | Low — currently works because `onEntityClick` is stable. Risk is future-proofing. |
| **Fix** | Store `onEntityClick` in a ref (`const onEntityClickRef = useRef(onEntityClick); onEntityClickRef.current = onEntityClick;`) and read from the ref inside the click handler. This decouples the event handler closure from the React render cycle. |
| **Effort** | Low. |

---

### M4 — `popupRef` not explicitly removed on unmount *(Low / Defensive)*

| | |
|---|---|
| **File** | `src/components/OsirisMap.tsx:820–825` |
| **Issue** | The map cleanup effect calls `resizeObserver.disconnect()`, `map.remove()`, and `mapRef.current = null`, but does not call `popupRef.current?.remove()`. MapLibre's `map.remove()` *should* remove all attached popups from the DOM, but if a popup was created and then removed from the map (e.g. user closed it), `popupRef.current` still holds the JS object. On unmount, the ref is dropped but the DOM element is already gone. This is currently harmless because MapLibre cleans up, but it's a defensive gap. |
| **Impact** | Negligible — MapLibre handles DOM cleanup. |
| **Fix** | Add `popupRef.current?.remove();` before `map.remove()`. |
| **Effort** | Trivial. |

---

### M5 — Visibility effect re-evaluates all ~35 layer groups on any `activeLayers` key change *(Low / Performance)*

| | |
|---|---|
| **File** | `src/components/OsirisMap.tsx:1098–1131` |
| **Issue** | The visibility `useEffect` has `[mapReady, activeLayers, setVis]` as dependencies. Since `activeLayers` is an object with ~30 keys, toggling any single layer causes `setVis` to be called for all 35 layer groups. `setVis` is stable and the function body is cheap, but this means every layer visibility is checked on every toggle. |
| **Impact** | Low — `setVis` is a few MapLibre `setLayoutProperty` calls per layer. MapLibre batches these internally. Not noticeable in practice. |
| **Fix** | Optional: split into per-layer visibility effects, or memoize which layers changed. Not required unless profiling shows it as a hotspot. |
| **Effort** | Medium (mechanical but noisy). |

---

### M6 — `news_intel` `toFeatures` assumes `[lat, lng]` coordinate order without numeric validation *(Low / Data Integrity)*

| | |
|---|---|
| **File** | `src/lib/registry/builtins.ts:360–364` |
| **Issue** | The `news_intel` render binding does: `coordinates: [n.coords[1], n.coords[0]]`. This assumes the upstream data provides `[lat, lng]` and maps it to GeoJSON `[lng, lat]`. If the upstream source already provides `[lng, lat]`, the coordinates will be swapped. Additionally, `n.coords?.length === 2` only checks array length, not that elements are finite numbers. |
| **Impact** | Low — affects only the SIGINT news layer; if upstream format changes, markers would plot in wrong locations silently. |
| **Fix** | Add numeric validation: `n.coords?.length === 2 && n.coords.every(c => Number.isFinite(c))`. Document the expected coordinate order in a comment. |
| **Effort** | Low. |

---

### M7 — `LayerPanel` computes `ALL_LAYERS` but never uses it *(Low / Dead Code)*

| | |
|---|---|
| **File** | `src/components/LayerPanel.tsx:52` |
| **Issue** | `const ALL_LAYERS = LAYER_GROUPS.flatMap(g => g.layers);` is computed on every render but never referenced. Harmless but creates noise. |
| **Fix** | Remove the line. |
| **Effort** | Trivial. |

---

## Systemic Patterns (No new issues, but worth noting)

1. **Registry error isolation is solid.** `mapEngine.ts` wraps every `map.addSource`, `map.addLayer`, and `binding.toFeatures` in `try/catch` with `[OSIRIS] Registry … failed` console logging. This means a bad plugin spec cannot crash the map.

2. **Feed engine lifecycle is correct.** `engine.ts` aborts in-flight controllers on unmount, clears per-feed lazy intervals when layers deactivate, and uses a `fetched` ref to prevent duplicate lazy loads.

3. **The `headless` flag works correctly.** Headless layers (conflict-zones, sigint-news, ip-sweep styles, scan-targets styles) are registered and rendered by the map engine but hidden from the sidebar via `filter(l => !l.headless)`.

4. **Theme-aware paint migration is clean.** The `Themed<T>` type (`T | ((theme: ThemeMode) => T)`) allows ghost-mode recoloring without duplicating layer definitions. The in-place `setPaint` effect handles runtime switches efficiently.

---

## Priority Action Plan

| Priority | Action | File | Effort |
|----------|--------|------|--------|
| **Quick win** | Fix stale test: read `MAX_MESH_NODES` from `builtins.ts` | `tests/performance-stability.test.mjs` | Trivial |
| **Quick win** | Remove dead `ALL_LAYERS` | `src/components/LayerPanel.tsx:52` | Trivial |
| **Quick win** | Add `popupRef.current?.remove()` to unmount cleanup | `src/components/OsirisMap.tsx:823` | Trivial |
| **Low** | Guard `news_intel` coords with numeric validation | `src/lib/registry/builtins.ts:360` | Low |
| **Low** | Store `onEntityClick` in ref for dynamic layer handlers | `src/components/OsirisMap.tsx:859` | Low |
| **Low** | Consider removing `theme` from dynamic layer effect deps | `src/components/OsirisMap.tsx:916` | Low–Medium |

---

*Reviewed on the files changed since `a931f34`: `src/components/LayerPanel.tsx`, `src/components/OsirisMap.tsx`, `src/lib/registry/builtins.ts`, `src/lib/registry/types.ts`, `src/lib/registry/mapEngine.ts`, `src/lib/registry/engine.ts`, `src/lib/registry/reactive.ts`, `src/lib/registry/store.ts`, `HANDOFF.md`.*
