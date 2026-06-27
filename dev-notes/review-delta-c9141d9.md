# HORUS Stability / Performance / Functionality — Delta Review
**Commits since last review:** `c98ab97` → `c9141d9` (7 commits)  
**Scope:** Stability, Functionality, Performance  
**Security:** Out of scope (per request)  
**Date:** 2026-06-26  
**Files changed:** 28 source files, ~1,039 new lines (net)  
**Test result:** 58/58 pass ✅  

---

## Executive Summary

The hardening commit (`f989488`) **fixes all 22 issues** flagged in the previous review (`review-c98ab97.md`). The new Phase 3–4 code (live location tracking, route exposure planner, curated police database, surveillance map foundation) is generally well-structured and defensive, but introduces **three High-severity issues** around map update batching, Nominatim rate compliance, and route-provider classification accuracy. No Critical issues were found.

| Dimension | Previous Grade | Current Grade | With fixes |
|-----------|---------------|---------------|------------|
| **Stability** | B | **A-** | **A** |
| **Functionality** | B+ | **A-** | **A** |
| **Performance** | B- | **B+** | **A-** |

---

## ✅ Verified Fixes from `review-c98ab97.md`

All 22 previously-flagged issues are confirmed fixed in commit `f989488`:

| # | Previous Issue | Fix Location | Evidence |
|---|---------------|-------------|----------|
| 1 | Unbounded SSE buffer in `DossierPanel` | `DossierPanel.tsx:151` | `MAX_BUF_LEN = 2MB` guard; `\r\n` normalized |
| 2 | Stale SSE `done` callback race | `DossierPanel.tsx:178` + `page.tsx:641` | `controller.signal.aborted` guard + `requestId` stale-callback rejection |
| 3 | `toLocal` antimeridian wrap-around | `geo.ts:122` | `refLng` parameter; `normalizeLng(lng - refLng)` |
| 4 | `bboxOfPoints` padding inversion | `geo.ts:87–98` | `crossesAntimeridian` tracked; span-aware clamping |
| 5 | `circlePolygon` / `pointBbox` out-of-range | `geo.ts:33–41, 107–117` | `clampLat` + `normalizeLng` on all outputs |
| 6 | Unbatched `setGeo` calls | `HorusMap.tsx:945–965` | `setDossierGeoBatch` batches into single `requestAnimationFrame` |
| 7 | Global `window.openHorusDossier` race | `page.tsx:624–635` | `dossierRequestIdRef` increments on every open; `onDossierLoaded` validates |
| 8 | Stale closure in `useEffect` | `DossierPanel.tsx:129–133, 201` | `latestOnLoadedRef` + `run` added to deps array |
| 9 | `renderMarkdown` unmemoized | `DossierPanel.tsx:99–102` | `MarkdownBlock` memoized with `useMemo` keyed by `text` |
| 10 | Unmemoized `nearby` computation | `DossierPanel.tsx:210–223` | `useMemo` over `dossier?.geometry?.features` |
| 11 | Quadratic deduplication | `DossierPanel.tsx:127` | `sectionIdsRef` `Set<string>` for O(1) dedup |
| 12 | `circlePolygon` equirectangular limitation | `geo.ts:103–106` | JSDoc documents the approximation |
| 13 | `normalizeLng` non-finite inputs | `geo.ts:11–15` | Early `Number.isFinite` guard |
| 14 | `bboxOfPoints` latitude padding limits | `geo.ts:84–85` | `clampLat` after padding |
| 15 | `onDossierLoaded` validation | `page.tsx:35–41, 688–693` | `safeDossierPoint` helper with bounds checks |
| 16 | Panel vs map nearby cap divergence | `page.tsx:33` | `MAX_DOSSIER_NEARBY = 30` used consistently |
| 17 | Popup HTML string interpolation | `HorusMap.tsx:76–82, 540–548` | `escapeHtml` utility on all injected fields |
| 18 | Dead `dossierAbort` ref | `page.tsx:252` | Renamed to `regionDossierAbort`; used for right-click dossier |
| 19 | Missing `reader.releaseLock()` | `DossierPanel.tsx:196` | Called in `finally` block |
| 20 | Runtime type assertions in `nearby` | `DossierPanel.tsx:105–113` | `pointCoordinates` with `Array.isArray` + bounds guards |
| 21 | Weak `any` typing in interfaces | `DossierPanel.tsx:19–42` | `DossierSection`, `DossierPointFeature` strict types |
| 22 | Geo scalar/tuple convention | `geo.ts:2–3` | File-level JSDoc documents `(lat, lng)` vs `[lng, lat]` |

---

## 🔴 New Issues (commits `02dbe12` → `c9141d9`)

### High

#### 1. Route-overlay `setGeo` calls are unbatched — same visual-tearing bug as dossier overlay
- **File:** `src/components/HorusMap.tsx` (lines 1471–1487)
- **Issue:** The `routeOverlay` effect calls `setGeo` three times synchronously (`route-line`, `route-corridor`, `route-surveil`). This triggers three separate MapLibre style re-evaluations, causing the same visual tearing that the dossier overlay had. The fix used for dossier (`setDossierGeoBatch`) was not applied to the route overlay.
- **Fix:** Reuse the `setDossierGeoBatch` pattern (or rename it to `setGeoBatch`) and apply it to the route overlay effect:
  ```typescript
  setGeoBatch({
    'route-line': [...],
    'route-corridor': [...],
    'route-surveil': [...],
  });
  ```
  Also batch the cleanup path (`line.length < 2`) into the same batch.

#### 2. `LocationTracker` reverse geocode can violate Nominatim usage policy
- **File:** `src/components/LocationTracker.tsx` (lines 44–62)
- **Issue:** The `reverseGeocode` function calls Nominatim (`nominatim.openstreetmap.org`) directly with only an 8-second interval / 40-metre-move guard. On a fast vehicle with jittery GPS, the guard can fire more than once per second. Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires **1 request per second maximum** and strongly recommends caching.
- **Impact:** Excessive requests can lead to IP blocking, causing the location label to permanently fail for that session.
- **Fix:** Add a strict `MIN_NOMINATIM_INTERVAL_MS = 1100` (or use a token-bucket rate limiter). Alternatively, switch to the client-side `reverseGeocode` utility in `src/lib/geocode.ts` which already uses `safeAbortTimeout` and could be extended with a shared throttle.

#### 3. Route provider `classify` is case-sensitive for ALPR tags
- **File:** `src/lib/intel/providers/route.ts` (lines 52–57)
- **Issue:** `classify` checks `tags['surveillance:type'] === 'ALPR'` and `tags['camera:type'] === 'ALPR'`. OpenStreetMap tags are conventionally lowercase. A node tagged `surveillance:type=alpr` or `camera:type=alpr` would be misclassified as a generic `camera`, undercounting ALPR exposure.
- **Fix:** Use case-insensitive comparison:
  ```typescript
  if (tags['surveillance:type']?.toLowerCase() === 'alpr' || tags['camera:type']?.toLowerCase() === 'alpr') return 'alpr';
  ```

### Medium

#### 4. `LocationTracker` `reverseGeocode` missing `finally` cleanup for `geocodeAbort`
- **File:** `src/components/LocationTracker.tsx` (lines 49–61)
- **Issue:** The `geocodeAbort` ref is set to a new `AbortController` before the fetch, but it is never cleared on success or failure. The unmount cleanup (`useEffect` return) calls `geocodeAbort.current?.abort()`, which is harmless but aborts an already-completed request. More importantly, if the component unmounts *after* a successful fetch but *before* the next one starts, the old controller is still referenced.
- **Fix:** Clear the ref in `finally`:
  ```typescript
  } finally { geocodeAbort.current = null; }
  ```

#### 5. `userPosition` effect in `HorusMap` also uses unbatched `setGeo`
- **File:** `src/components/HorusMap.tsx` (lines 1460–1467)
- **Issue:** The `userPosition` effect calls `setGeo` twice synchronously (`user-position`, `user-accuracy`). GPS updates are infrequent, so this is low-impact, but for consistency and correctness the same batching pattern should apply.
- **Fix:** Wrap in the same `setGeoBatch` helper.

#### 6. `bufferPolygon` may compute wrong normal for antimeridian-crossing segments
- **File:** `src/lib/geo.ts` (lines 192–213)
- **Issue:** `dxM = normalizeLng(next[0] - prev[0]) * M_PER_DEG_LAT * cos` normalizes the longitudinal delta. For a segment crossing the antimeridian (e.g., `prev.lng = 179`, `next.lng = -179`), the raw delta is `−358°`, which `normalizeLng` wraps to `+2°`. The sign flips, so the tangent vector points in the wrong direction. The corridor buffer would be offset perpendicular to the true route on the wrong side.
- **Impact:** The route corridor fill would be visually offset for routes that cross the 180° line (e.g., Fiji → Samoa, or some polar routes). This is a very rare edge case for driving routes, but the code does not document it.
- **Fix:** Add a JSDoc caveat: "For segments that cross the antimeridian, the buffer offset may be inverted. Accurate only for continuous (non-wrapping) polylines." Or compute the raw delta without normalization for the tangent.

#### 7. `curatedPoliceWithin` and `curatedPoliceInBoxes` do not handle antimeridian-crossing bboxes in `pointInBox`
- **File:** `src/lib/police/curated.ts` (lines 23–26)
- **Issue:** `pointInBox` uses `lng >= w && lng <= e`. If a coverage box crosses the antimeridian (e.g., `w = 170, e = -170`), the condition is never true. The NZ dataset splits into two non-crossing boxes, so this is currently safe. But future datasets (e.g., Russia, Alaska) might need a single crossing box.
- **Fix:** Add an antimeridian-aware `pointInBox` helper or document the constraint that coverage boxes must not cross the antimeridian.

#### 8. `CCTV` route cache-control logic flips from no-store to public based on arbitrary count
- **File:** `src/app/api/cctv/route.ts` (lines 651–653)
- **Issue:** `allCameras.length < 50 ? 'no-store' : 'public, s-maxage=300...'` treats a 49-camera response as uncacheable and a 50-camera response as cacheable for 5 minutes. There is no semantic reason for this boundary; a small result could be a legitimate regional query and a large one could be user-specific.
- **Fix:** Use a consistent cache policy based on the query type: `region` / `continent` queries → `public, s-maxage=300`; `lat,lng,radius` queries → `no-store`.

#### 9. `DossierPanel` `onLocate` guard only checks `Number.isFinite` but not `null`/`undefined`
- **File:** `src/components/DossierPanel.tsx` (line 226)
- **Issue:** `if (Number.isFinite(n.lat) && Number.isFinite(n.lng)) onLocate?.(n.lat, n.lng)` — `Number.isFinite(null)` is `false`, so this is safe, but `Number.isFinite(undefined)` is also `false`. However, the `pointCoordinates` helper already validates bounds, so this is a belt-and-suspenders observation rather than a bug.

---

## 🔍 Systemic Patterns Checked

| Pattern | Check | Result |
|---------|-------|--------|
| Unclosed `setInterval` / `setTimeout` | Grep across `src/` | All major intervals have cleanup in `useEffect` return or class-level `destroy` methods. The `UptimeClock` and `ZuluClock` intervals are correctly torn down. |
| Unprotected `JSON.parse` | Grep across `src/` | `JSON.parse` calls are either in `try/catch` blocks (DossierPanel SSE, ExtensionsSettings, plugins, settings) or operating on trusted internal data (SDK adapters, webhook payload). No unguarded external parsing found. |
| Missing `AbortController` on external fetches | Spot-check new routes | All new external fetches (Nominatim, Overpass, OSRM) pass `signal` or use `safeAbortTimeout` / `safeAbortAny`. |
| Unbounded array growth | Check new providers | `MAX_NEARBY = 80`, `MAX_GRAPH_NEARBY = 12`, `MAX_BUF_LEN = 2MB`, `MAX_TILES = 16`. All bounded. |
| Missing `finally` for resource cleanup | Check new async | `DossierPanel` `reader.releaseLock()` is in `finally`. `LocationTracker` `geocodeAbort` is missing a `finally` clear (see Medium #4). |
| Duplicate event listeners | Check `addEventListener` | `page.tsx` `resize`/`orientationchange` listeners correctly removed. `window` globals cleaned up on unmount. |
| Race conditions in state updates | Check `requestId` pattern | The `dossierRequestIdRef` pattern is correctly applied. No equivalent `requestId` guard exists for `routeOverlay` updates, but `routeOverlay` is set synchronously from `onDossierLoaded` which is already guarded. |

---

## 🧪 Test Results

```
node --test tests/performance-stability.test.mjs tests/review-c98ab97.test.mjs tests/nz-police-database.test.mjs tests/surveillance-map-foundation-cctv.test.mjs

✔ 58 tests passed
✔ 0 failed
✔ 0 skipped
```

All tests pass, including the new `nz-police-database.test.mjs` and `surveillance-map-foundation-cctv.test.mjs` suites. The `review-c98ab97.test.mjs` regression suite confirms the previous fixes are still wired.

---

## 📋 Priority Action Plan

### Sprint 1 (High impact — fix before next release)
1. **Batch `routeOverlay` `setGeo` calls** in `HorusMap.tsx` (High #1).
2. **Throttle Nominatim reverse geocode** in `LocationTracker.tsx` to comply with 1 req/s policy (High #2).
3. **Make `classify` case-insensitive** for ALPR tags in `route.ts` (High #3).

### Sprint 2 (Medium polish)
4. Clear `geocodeAbort` ref in `finally` in `LocationTracker.tsx` (Medium #4).
5. Batch `userPosition` `setGeo` calls for consistency (Medium #5).
6. Document `bufferPolygon` antimeridian limitation in `geo.ts` (Medium #6).
7. Document or fix `pointInBox` antimeridian constraint in `curated.ts` (Medium #7).
8. Fix `CCTV` cache-control boundary to be query-type-based rather than count-based (Medium #8).

---

*End of delta report.*
