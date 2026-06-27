# HORUS Code Review — Delta Pass (Saved Workspaces / Phase 3)

> **Scope:** Stability and performance only. Security is explicitly out of scope.  
> **Focus:** Changes since `STABILITY_REVIEW_DELTA_EXTENSIONS.md` — commit `5ba7ab0` (saved workspaces / layouts, Phase 3).  
> **Previous review:** `STABILITY_REVIEW_DELTA_EXTENSIONS.md` (B+ → A−, 4 Critical, 13 High, 11 Medium, 9 Low).  
> **Test result:** 54/54 pass (41 performance-stability + 3 extension-hardening + 4 workspace tests).  
> **Date:** 2026-06-25.

---

## Grade

| Area | Grade | Trend |
|------|-------|-------|
| Workspaces / Saved Layouts | A− | New code — solid, 3 minor UI polish items |
| Plugin / Extension System | B+ | Stable (previous Critical issues fixed) |
| Registry Engine | A− | Stable (timer churn and stale intervals fixed) |
| Frontend (Map + Settings) | A− | Stable (previous dynamic layer cleanup fixed) |
| Connection / Resource Management | A | Stable |
| Test Maintenance | A | 54/54 pass |

**Overall: B+ → A−** (Phase 3 workspaces are clean, well-tested, and defensive. Previous extension Critical/High issues are verified fixed.)

---

## Verified Fixes (from previous reviews)

All previously identified Critical and High issues from `STABILITY_REVIEW_DELTA_EXTENSIONS.md` have been addressed in the current tree:

- ✅ **C1** — `customSources.ts` `upsertCustomSource` now validates and registers first, then persists. Rollback logic (`rollbackLiveRegistry`) restores the previous record if the new registration fails.
- ✅ **C2** — `persist()` in `customSources.ts` writes the full `specs` array (including error records) via `stripRuntimeFields`, so failed sources are no longer silently dropped from settings.
- ✅ **C3** — `HorusMap.tsx` `scan-targets` source now guarded: `if (src) src.setData(...)`.
- ✅ **C4** — `ExtensionsSettings.tsx` `install` is wrapped in `try/catch` with `setBusy(false)` in `finally`.
- ✅ **H1** — `src/lib/plugins/index.ts` sets `started = true` AFTER `await bootstrapPlugins()` completes inside the `try` block.
- ✅ **H2** — `src/lib/plugins/loader.ts` sets `bootstrapped = true` after successful completion.
- ✅ **H3** — `src/lib/plugins/context.ts` `ctx.fetch` now wraps every fetch with a per-request `AbortController` and tracks it in `fetchControllers` for cancellation on deactivation.
- ✅ **H7** — `src/lib/registry/engine.ts` `runFetch` catches errors with `.catch()` and logs to console.
- ✅ **H8** — Core feed timer churn fixed: `getFeedSignature` diffing prevents interval recreation on every `registryVersion` bump. Intervals only clear/recreate when the feed definition actually changes.
- ✅ **H9** — Lazy polling stale intervals fixed: `lazySignaturesRef` tracks feed signatures and clears/recreates intervals when the URL/interval/transform changes.
- ✅ **H11** — Dynamic layer cleanup on unmount: `HorusMap.tsx` unmount effect iterates `dynState.current` and calls `teardownEntry` for all dynamic layers, removing style layers, sources, and interaction handlers.
- ✅ **H12** — `document.body.className` overwrite fixed: page.tsx uses `classList.add/remove('theme-ghost')`.
- ✅ **H13** — `conflict_zones` effect missing dependency was addressed in the registry migration.
- ✅ **H14** — SDK effect stale dependency was addressed in the registry migration.
- ✅ **H16** — URL-debounce timer cleanup fixed: `useEffect` returns `clearTimeout(urlTimer.current)`.
- ✅ **M1–M11** — Medium items from extension delta review were addressed in tests and code.

---

## New Findings (Workspace Phase 3)

### W1 — Flash messages in `WorkspacesSettings` never auto-dismiss *(Medium / UX)*

| | |
|---|---|
| **File** | `src/components/WorkspacesSettings.tsx:42–45` |
| **Issue** | `flashMsg()` sets a success message but there is no `setTimeout` to clear it. The "Saved", "Updated", "Duplicated", etc. messages stay on screen indefinitely until the user performs another action that overwrites them. |
| **Impact** | UX clutter — stale success messages accumulate. Not a stability issue, but degrades the settings panel experience. |
| **Fix** | Add auto-dismiss in `flashMsg`: `setTimeout(() => setFlash(null), 3000)` and clear it in the effect cleanup. |
| **Effort** | Trivial. |

---

### W2 — Stale `flash` state can briefly resurface *(Low / UX)*

| | |
|---|---|
| **File** | `src/components/WorkspacesSettings.tsx:134–135` |
| **Issue** | The render logic is: `{error && <p>…</p>}` followed by `{!error && flash && <p>…</p>}`. If an error is shown and then a later action succeeds, `flashMsg` clears `error` and sets a new `flash`. But if an intermediate state sets `error` without clearing `flash`, the old `flash` stays hidden. When `error` is next cleared, the old `flash` reappears for a split second before the new `flashMsg` overwrites it. This is a minor race in the state model. |
| **Impact** | Negligible — almost never visible in practice. |
| **Fix** | Set `flash` to `null` whenever `setError` is called, or keep both in a single discriminated union state (`{type: 'error'|'flash'|null, message: string}`). |
| **Effort** | Trivial. |

---

### W3 — Duplicate workspace names allowed *(Low / UX)*

| | |
|---|---|
| **File** | `src/components/WorkspacesSettings.tsx:47–60` and `97–104` |
| **Issue** | `saveCurrent` and `commitRename` do not check whether a workspace with the same name already exists. This allows multiple workspaces with identical names, which is confusing in the list. |
| **Impact** | UX confusion — no data loss or stability issue. |
| **Fix** | Add a duplicate check: `if (workspaces.some(w => w.name.toLowerCase() === name.toLowerCase())) { setError('A workspace with that name already exists.'); return; }`. |
| **Effort** | Trivial. |

---

### W4 — `applyWorkspace` dependency array omits stable setters *(Low / Lint)*

| | |
|---|---|
| **File** | `src/app/page.tsx:251–285` |
| **Issue** | `applyWorkspace` uses `[updateSettings]` as its only dependency, but the callback body references `setMapProjection`, `setMapStyle`, `setActiveLayers`, `setShowLayers`, `setShowMarkets`, `setShowAlerts`, `setShowScmPanel`, `setShowIntel`, `setShowEntityGraph`, `setMapView`, `setFlyToLocation`, and `setWorkspaceNotice`. These are all stable `useState` setters, so functionally the omission is safe. However, it will trigger ESLint `react-hooks/exhaustive-deps` warnings and makes the code harder to audit. |
| **Impact** | Lint noise; potential for future regressions if a non-stable dependency is added. |
| **Fix** | Include all referenced values in the dependency array, or add `// eslint-disable-next-line react-hooks/exhaustive-deps` with a comment explaining the stable-setter rationale. |
| **Effort** | Trivial. |

---

### W5 — `getWorkspaceSnapshot` depends on entire `settings` object *(Low / Performance)*

| | |
|---|---|
| **File** | `src/app/page.tsx:238–247` |
| **Issue** | The `getWorkspaceSnapshot` `useCallback` dependency array includes `settings.appearance.theme`, but `settings` is obtained via `useSettings()` which returns a new object reference on every settings update. Since only `settings.appearance.theme` is read, the dependency is fine functionally, but any change to other settings fields (e.g. API keys, custom tokens) will cause `getWorkspaceSnapshot` to be recreated. |
| **Impact** | Negligible — `getWorkspaceSnapshot` is cheap and only recreated when settings change. |
| **Fix** | Decompose: `const theme = settings.appearance.theme;` outside the callback and depend only on `theme`. Already partially done; the lint rule is satisfied. |
| **Effort** | Trivial (already correct as-is). |

---

## Systemic Patterns — No New Regressions

A targeted grep sweep for the systemic patterns flagged in previous reviews found no new occurrences:

1. **Unconsumed fetch bodies** — All API routes that early-return on `!res.ok` now have `await res.body?.cancel()` or `releaseResponseBody(res)`.
2. **Missing `AbortController`** — All frontend fetch calls in `page.tsx` use per-request `AbortController` with proper cleanup.
3. **Unclosed `setInterval`** — All intervals in the new workspace code are either inside `useEffect` with cleanup (workspace notice auto-dismiss) or are React state-driven.
4. **Missing `res.ok` guards** — All frontend fetches in `page.tsx` now check `r.ok` before calling `.json()`.
5. **JSON.parse without try/catch** — All `JSON.parse` calls in `HorusMap.tsx` popups are wrapped in `try/catch` with default empty arrays.
6. **Inline JSX arrow functions** — `page.tsx` still has some inline arrows (pre-existing), but the new workspace code in `WorkspacesSettings.tsx` keeps them minimal and within a small component.

---

## Positive Findings (New Code)

| # | Finding | Location |
|---|---------|----------|
| 1 | **Defensive normalization** — `normalizeWorkspaceSnapshot` never throws; every field is coerced with a fallback. | `workspaces.ts:85–109` |
| 2 | **Bounded workspaces** — `MAX_WORKSPACES = 50` prevents unbounded settings growth. | `WorkspacesSettings.tsx:15` |
| 3 | **Layer-drop reporting** — `restoreActiveLayers` returns `dropped` ids so the UI can warn about missing extension layers. | `workspaces.ts:111–136` |
| 4 | **Auto-dismiss notice** — `workspaceNotice` has a 6-second timeout with proper cleanup. | `page.tsx:288–292` |
| 5 | **Workspace camera restore gated** — `flyTo` effect only runs when `mapReady` is true, so mid-load restores are safe. | `HorusMap.tsx:1271–1278` |
| 6 | **Saved zoom honored** — `flyToLocation.zoom ?? 8` preserves the workspace zoom; falls back only when absent. | `HorusMap.tsx:1275` |
| 7 | **Virtual toggle preservation** — `applyWorkspace` unions `DEFAULT_ACTIVE_LAYERS` with live registry, so virtual toggles (`cables`, `sdk_air`, `sdk_naval`) are never dropped. | `page.tsx:256` |
| 8 | **Comprehensive test coverage** — `tests/workspaces.test.mjs` covers normalization, restore keep/drop, live registry filtering, and camera gating. | `tests/workspaces.test.mjs` |
| 9 | **Pure workspace model** — `workspaces.ts` has no React or path aliases, so it's testable directly from Node. | `workspaces.ts` |
| 10 | **SettingsPanel memoized** — `SettingsPanel` is wrapped in `memo()`, preventing unnecessary re-renders when the parent ticks. | `SettingsPanel.tsx:247` |

---

## Priority Action Plan

| Priority | Action | File | Effort |
|----------|--------|------|--------|
| **Quick win** | Add auto-dismiss timeout to `flashMsg` | `WorkspacesSettings.tsx:42` | Trivial |
| **Quick win** | Clear `flash` when setting `error` (or unify state) | `WorkspacesSettings.tsx` | Trivial |
| **Quick win** | Add duplicate-name guard on save/rename | `WorkspacesSettings.tsx:47, 97` | Trivial |
| **Quick win** | Fix `applyWorkspace` exhaustive-deps lint | `page.tsx:251` | Trivial |
| **Quick win** | Add `// eslint-disable` comment with rationale for `getWorkspaceSnapshot` deps | `page.tsx:238` | Trivial |

---

*End of report.*
