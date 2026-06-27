# HORUS Code Review — Commit `c98ab97`
**feat(intel): Dossier UI + address-intel map overlay (Phase 2b)**

**Scope:** Stability, Functionality, Performance  
**Security:** Out of scope (per request)  
**Date:** 2026-06-25  
**Files reviewed:** 8 files, ~446 lines changed (net)  
**Previous commit reviewed:** `03c0485` (Phase 1)

---

## Executive Summary

Phase 2b delivers a polished user-facing dossier panel and map overlay. The feature works end-to-end and the commit fixes several issues from the Phase 1 review (empty `bboxOfPoints`, antimeridian handling). However, **five Critical issues** remain: the DossierPanel SSE buffer can grow unbounded, stale SSE callbacks can race, the geo utilities have antimeridian bugs in `pointToSegmentMeters` and `bboxOfPoints` padding, and `circlePolygon` can emit out-of-range coordinates. The map integration also suffers from 4 unbatched `setGeo` calls per dossier load. These are all localized and fixable.

| Dimension | Grade | With fixes |
|-----------|-------|------------|
| **Stability** | **B** | **A-** |
| **Functionality** | **B+** | **A-** |
| **Performance** | **B-** | **A-** |

---

## Fixed from Previous Review (`03c0485`)

| # | Previous Issue | Status | Evidence |
|---|---------------|--------|----------|
| 1 | `bboxOfPoints` returned invalid `[90, 180, -90, -180]` on empty array | **Fixed** | `geo.ts:33` now returns `null` for `points.length === 0` |
| 2 | `bboxOfPoints` did not handle antimeridian crossing | **Fixed** | `geo.ts:37–61` adds `normalizeLng` and largest-gap detection |
| 3 | `circlePolygon` was missing (radius ring needed for map overlay) | **Added** | `geo.ts:73–81` new `circlePolygon` function |

---

## Critical Issues (fix before prod)

### 1. Unbounded SSE buffer in DossierPanel — can OOM on malformed/massive stream
- **File:** `src/components/DossierPanel.tsx` (~line 102)
- **Issue:** `buf += decoder.decode(value, { stream: true })` accumulates indefinitely. If the server emits a massive event without `\n\n`, or uses `\r\n\r\n` line endings the parser mishandles, the buffer grows until the tab runs out of memory.
- **Fix:** Add a `MAX_BUF_LEN` guard (e.g., 1–2 MB) and truncate/throw if exceeded. Also normalize `\r\n` → `\n` before splitting on `\n\n`.

### 2. Stale SSE `done` callback race — old dossier can overwrite new one
- **File:** `src/components/DossierPanel.tsx` (~lines 118–122)
- **Issue:** Inside the `while` loop, the `case 'done'` block calls `onLoaded?.(payload.dossier)` without checking `controller.signal.aborted` *after* entering the case. If `run()` is called for a new target while the old buffer is mid-process, the old `done` event can still fire `onLoaded` and push stale data into `page.tsx`.
- **Fix:** Add `if (controller.signal.aborted) return;` immediately inside `case 'done':`, before `onLoaded` is invoked.

### 3. `pointToSegmentMeters` / `toLocal` antimeridian wrap-around bug
- **File:** `src/lib/geo.ts` (lines 86–90, 93–108)
- **Issue:** `toLocal` projects absolute longitudes into a local Cartesian plane. When a segment straddles the antimeridian (e.g., `aLng = 179`, `bLng = -179`), the raw difference is `−358°` instead of the shortest `2°`. `dx` becomes huge, so the perpendicular distance is completely wrong. Same issue affects `pointToLineMeters`.
- **Fix:** Compute longitudinal delta relative to the segment start before projecting, or change `toLocal` to take a reference longitude:
  ```typescript
  function toLocal(lat, lng, lat0, refLng) {
    const x = normalizeLng(lng - refLng) * D2R * EARTH_R * Math.cos(lat0 * D2R);
    const y = lat * D2R * EARTH_R;
    return [x, y];
  }
  ```

### 4. `bboxOfPoints` padding inverts non-crossing bboxes near the antimeridian
- **File:** `src/lib/geo.ts` (lines 57–62)
- **Issue:** When `padM > 0`, the function independently normalizes `w` and `e`. If the original bbox did **not** cross the antimeridian but is large enough that `w − dLng < −180` or `e + dLng > 180`, the normalized values wrap around and create a *crossing* bbox with a tiny span. Example: a non-crossing bbox `[-170, 170]` padded by 20° becomes `[170, −170]` (20° span instead of 340°).
- **Fix:** Track whether the original bbox already crossed the antimeridian (`w > e`). If it did not, clamp `w` and `e` to `[-180, 180]` without wrapping, or if the padded span would exceed 360°, return the full world.

### 5. `circlePolygon` and `pointBbox` emit out-of-range coordinates
- **File:** `src/lib/geo.ts` (lines 21–25, 66–75)
- **Issue:** `circlePolygon` can generate longitudes outside `[-180, 180]` and latitudes outside `[-90, 90]`. `pointBbox` can also return latitudes `> 90` or `< -90`. GeoJSON consumers and Mapbox sources generally expect normalized coordinates; unbounded values can cause rendering artifacts or silent rejections.
- **Fix:** In `circlePolygon`: wrap generated longitudes with `normalizeLng` and clamp latitudes to `[-90, 90]`. In `pointBbox`: clamp latitudes to `[-90, 90]`.

---

## High Issues

### 6. Unbatched `setGeo` calls trigger 4 redundant map style updates
- **File:** `src/components/HorusMap.tsx` (lines ~1359–1379)
- **Issue:** The dossier overlay effect calls `setGeo` four times synchronously (`dossier-pin`, `dossier-radius`, `dossier-nearby`, `dossier-sightlines`). Each call hits `GeoJSONSource.setData()`, which triggers a separate MapLibre style re-evaluation and re-render. With 40+ nearby items and 64+ polygon points, this wastes frame budget and can cause visual tearing (intermediate frames showing only the pin, or only the radius).
- **Fix:** Batch the updates into a single `requestAnimationFrame` or use a combined GeoJSON source with `filter`/`match` layer expressions so only one `setData` is needed.

### 7. Global `window.openHorusDossier` bypasses React reactivity and creates race surface
- **File:** `src/app/page.tsx` (lines ~609–614)
- **Issue:** Assigning a handler to `window` bypasses React's state flow. While the three `setState` calls inside the handler are batched by React 18, there is no guard against rapid re-entry. A caller can invoke the global function while the previous dossier stream is still in flight, and the stale SSE `done` callback can overwrite the new overlay state.
- **Fix:** Replace the global with a React context or a typed event emitter. At minimum, add a `dossierRequestIdRef` that increments on each open and have `onDossierLoaded` validate it before applying state.

### 8. Stale closure / missing `run` dependency in DossierPanel `useEffect`
- **File:** `src/components/DossierPanel.tsx` (lines ~128–133)
- **Issue:** The effect deliberately omits `run` from its deps array (`eslint-disable-next-line react-hooks/exhaustive-deps`). Because `run` is recreated whenever `onLoaded` changes, the effect retains an old `run` closure. If the parent passes an unstable `onLoaded` (e.g., an inline arrow), the stale callback is invoked.
- **Fix:** Either add `run` to the deps array (and memoize the parent's `onLoaded` with `useCallback`), or use a ref to track the latest `onLoaded` inside `run`.

### 9. `renderMarkdown` is not memoized — dominates render path
- **File:** `src/components/DossierPanel.tsx` (lines ~40–64)
- **Issue:** Every render of `DossierPanel` re-runs the regex, re-splits every line, and re-creates the entire React element tree for every section. This is O(n) in characters per render and dominates the render path when the panel is open.
- **Fix:** Convert `renderMarkdown` into a memoized sub-component (`React.memo`) or wrap the call site in `useMemo` keyed by `text`.

### 10. Unmemoized heavy `nearby` computation
- **File:** `src/components/DossierPanel.tsx` (lines ~136–142)
- **Issue:** `filter` → `map` → `slice` on `dossier.geometry.features` runs on **every** render (including streaming stage updates). If the GeoJSON feature collection is large, this causes frame drops during SSE streaming.
- **Fix:** Wrap in `useMemo` keyed by `dossier?.geometry?.features`.

### 11. Quadratic deduplication in `setStreamSections`
- **File:** `src/components/DossierPanel.tsx` (line ~117)
- **Issue:** `prev.some((s) => s.id === payload.id)` scans the entire array for every incoming section event. If the server emits 100+ sections, this is O(n²).
- **Fix:** Use a local `Set<string>` or `Map<string, Section>` for O(1) deduplication, or accumulate in a ref and batch-update.

### 12. `circlePolygon` equirectangular approximation produces ellipses at high latitudes
- **File:** `src/lib/geo.ts` (lines 66–75)
- **Issue:** The radius is converted to degrees using a constant metres-per-degree factor and a simple cosine scaling for longitude. Above ~60° latitude this produces an ellipse stretched east-west, not a circle. The user explicitly flagged this.
- **Fix:** Add a JSDoc comment documenting the limitation: “Uses an equirectangular approximation; at high latitudes the ring is elongated east-west. Accurate only for small radii (< ~10 km) and mid/low latitudes.”

### 13. `normalizeLng` does not guard against non-finite inputs
- **File:** `src/lib/geo.ts` (lines 8–11)
- **Issue:** `NaN` or `Infinity` propagates silently through the modulo chain and returns `NaN`. Downstream consumers may behave unpredictably.
- **Fix:** Add an early guard:
  ```typescript
  function normalizeLng(lng: number): number {
    if (!Number.isFinite(lng)) return NaN;
    const normalized = ((((lng + 180) % 360) + 360) % 360) - 180;
    return normalized === -180 ? 180 : normalized;
  }
  ```

### 14. `bboxOfPoints` / `pointBbox` latitude padding can exceed physical limits
- **File:** `src/lib/geo.ts` (lines 21–25, 57–62)
- **Issue:** After padding, `s` (south) and `n` (north) are not clamped to `[-90, 90]`. A point near the pole with a large `radiusM` can produce `lat ± dLat` outside the valid range.
- **Fix:** Clamp after padding:
  ```typescript
  s = Math.max(-90, s - dLat);
  n = Math.min(90, n + dLat);
  ```

---

## Medium Issues

### 15. `onDossierLoaded` lacks defensive validation of malformed API data
- **File:** `src/app/page.tsx` (lines ~620–631)
- **Issue:** The callback receives `d: any` and directly accesses `radiusAction.lat`, `f.geometry.coordinates[1]`, etc., without `Array.isArray` checks or `Number()` coercion. A malformed SSE payload can set `NaN` coordinates into React state, which MapLibre will silently ignore or throw on.
- **Fix:** Add a validation helper:
  ```typescript
  const center = radiusAction && typeof radiusAction.lat === 'number' && typeof radiusAction.lng === 'number'
    ? { lat: radiusAction.lat, lng: radiusAction.lng }
    : null;
  ```

### 16. Inconsistent capping between panel list and map overlay
- **File:** `src/components/DossierPanel.tsx` (line ~145) vs `src/app/page.tsx` (line ~626)
- **Issue:** The panel caps the nearby list to 30 items (`slice(0, 30)`), but `onDossierLoaded` maps **all** nearby features into the map overlay state. If the API returns 100+ devices, the map renders the full set while the UI truncates the list.
- **Fix:** Cap both at the same limit (e.g., 30 for the panel, 50 for the map), or document the divergence explicitly in a comment.

### 17. Popup HTML string interpolation lacks escaping, risking broken DOM
- **File:** `src/components/HorusMap.tsx` (lines ~510–513)
- **Issue:** `p.name`, `p.osmUrl`, and `p.distanceM` are interpolated directly into raw HTML strings. If `name` contains `"`, `<`, or `&`, the popup attribute or tag structure breaks and the link may become unclickable. (Security/XSS is out of scope, but DOM stability is affected.)
- **Fix:** Add a minimal `escapeHtml` utility:
  ```typescript
  const escapeHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  ```

### 18. Dead `dossierAbort` ref in `page.tsx`
- **File:** `src/app/page.tsx` (line ~243)
- **Issue:** `const dossierAbort = useRef<AbortController | null>(null);` is declared but never used; the `DossierPanel` manages its own abort internally. This is a code smell that can confuse future refactors.
- **Fix:** Remove the unused ref, or lift the `AbortController` into `page.tsx` and pass it down to `DossierPanel` for a single source-of-truth cancellation model.

### 19. Architecture anti-pattern: global mutable state in SurveillancePanel
- **File:** `src/components/SurveillancePanel.tsx` (line ~137)
- **Issue:** `window.openHorusDossier` is a global function attached to `window`, bypassing React props/context entirely. This is brittle, untestable, and creates an implicit cross-component contract.
- **Fix:** Lift the dossier open state into a React context or a prop-driven callback chain.

### 20. Missing `reader.releaseLock()` in DossierPanel
- **File:** `src/components/DossierPanel.tsx` (lines ~95–125)
- **Issue:** If the loop exits early (error, abort, or exception), the reader lock is never explicitly released. The browser usually recovers, but it can delay stream cleanup and cause backpressure on the server connection.
- **Fix:** Call `reader.releaseLock()` in a `finally` block inside the `try` that wraps the read loop.

### 21. Runtime type assertions masking errors in `nearby` map
- **File:** `src/components/DossierPanel.tsx` (lines ~138–140)
- **Issue:** `f.geometry.coordinates[1] as number` assumes the array exists and has two elements. If the backend sends malformed GeoJSON, `lat`/`lng` become `undefined`, and `onLocate?.(n.lat, n.lng)` is called with invalid arguments.
- **Fix:** Add runtime guards: `Array.isArray(f.geometry?.coordinates)` and `typeof coord === 'number'`.

### 22. Weak `any` typing in DossierPanel interfaces
- **File:** `src/components/DossierPanel.tsx` (lines ~23–24)
- **Issue:** `graph` uses `any[]`, and `geometry` uses `Array<{ geometry: any; properties: any }>`. This defeats TypeScript's ability to catch structural mismatches at build time.
- **Fix:** Replace with strict GeoJSON types (`[number, number]` for coordinates, discriminated unions for nodes/links).

### 23. Parameter order convention is inconsistent with GeoJSON tuple order
- **File:** `src/lib/geo.ts` (throughout)
- **Issue:** Functions accept `(lat, lng)` as scalar parameters, but `Array<[number, number]>` tuples are `[lng, lat]` (GeoJSON order). The convention is internally consistent, but it is a common source of caller confusion because many GIS libraries expect `(lng, lat)` scalars.
- **Fix:** Document the convention clearly in a file-level JSDoc: “Scalar args are `(lat, lng)`; arrays / tuples are `[lng, lat]` (GeoJSON).”

---

## Low Issues

| # | File | Line(s) | Issue | Suggested Fix |
|---|------|---------|-------|---------------|
| 24 | `src/components/HorusMap.tsx` | ~508–509 | Color logic duplicated between registry style expressions and popup handler. A palette change requires editing both sites. | Extract a `DOSSIER_KIND_COLOR` record into a shared constants file. |
| 25 | `src/components/HorusMap.tsx` | ~1229–1265 | Dossier layers not included in `setVis` visibility effect. They are always present in the map style and hidden only by setting GeoJSON sources to empty arrays. | Add explicit visibility guard in `setVis`. |
| 26 | `src/components/DossierPanel.tsx` | ~292 | Ineffective `memo()`. `open` toggles on every panel show/hide, and `target` changes on every selection. React almost always re-renders. | Remove `memo` unless you add a custom comparator that only compares `target.id`/`kind`/`lat`/`lng`. |
| 27 | `src/components/DossierPanel.tsx` | ~163 | Missing image error handling. No `onError` handler on `<img>` tags. | Add `onError` to fallback to a placeholder or hide the broken image. |
| 28 | `src/components/DossierPanel.tsx` | ~163 | Non-descriptive `alt` text. `alt="street-level"` is identical for every image. | Use `alt={\`Street view from ${m.source} — ${i + 1}\`}`. |
| 29 | `src/lib/geo.ts` | ~32–38 | `bboxOfPoints` sorts longitudes unnecessarily. Finding min/max and detecting antimeridian wrap is possible in O(n) without sorting. | (Optional) Replace `sort` with a single pass that tracks min, max, and largest gap. |

---

## Positive Findings

- **`bboxOfPoints` empty-array fix** — returns `null` instead of garbage, preventing downstream crashes.
- **Antimeridian handling added to `bboxOfPoints`** — correctly detects and wraps longitude ranges across the dateline.
- **`circlePolygon` added** — enables the radius ring visualization without a Turf dependency.
- **`HorusMap` is correctly wrapped with `memo`** — prevents unnecessary re-renders when `page.tsx` `mapView` state changes and `dossierOverlay` is stable.
- **`onDossierLoaded` and `closeDossier` use `useCallback` with stable setter deps** — so `DossierPanel` does not receive new function references on every parent render.
- **`closeDossier` correctly nulls `dossierOverlay`** — which triggers the cleanup effect in `HorusMap` and empties all four GeoJSON sources.
- **`setGeo` safely checks `if (src) src.setData(...)`** — so missing sources do not throw.
- **Dossier registry layer (`builtins.ts`) is clean** — well-formed Mapbox GL JS expressions, `headless: true` correctly signals no React UI component is required.

---

## Priority Action Plan

### Sprint 1 (blockers)
1. Add `MAX_BUF_LEN` guard to SSE buffer in DossierPanel (Critical #1).
2. Add `controller.signal.aborted` guard inside `case 'done'` in DossierPanel (Critical #2).
3. Fix `toLocal` antimeridian wrap-around in `pointToSegmentMeters` (Critical #3).
4. Fix `bboxOfPoints` padding inversion near antimeridian (Critical #4).
5. Clamp `circlePolygon` and `pointBbox` coordinates to valid ranges (Critical #5).

### Sprint 2 (high impact)
6. Batch `setGeo` calls into a single map update (High #6).
7. Replace `window.openHorusDossier` with a React context or request-id guard (High #7).
8. Fix stale `useEffect` closure in DossierPanel (High #8).
9. Memoize `renderMarkdown` (High #9).
10. Memoize `nearby` computation with `useMemo` (High #10).
11. Replace quadratic deduplication with `Set`/`Map` (High #11).
12. Document `circlePolygon` equirectangular limitation (High #12).
13. Guard `normalizeLng` against non-finite inputs (High #13).
14. Clamp latitudes in `bboxOfPoints` / `pointBbox` padding (High #14).

### Sprint 3 (polish / scale)
15. Add runtime validation in `onDossierLoaded` (Medium #15).
16. Cap panel and map nearby lists consistently (Medium #16).
17. Add `escapeHtml` to popup string interpolation (Medium #17).
18. Remove dead `dossierAbort` ref or lift it properly (Medium #18).
19. Add `reader.releaseLock()` to SSE cleanup (Medium #20).
20. Add runtime type guards for GeoJSON coordinates (Medium #21).
21. Tighten DossierPanel TypeScript interfaces (Medium #22).
22. Document geo.ts scalar/tuple parameter convention (Medium #23).

---

*End of report.*
