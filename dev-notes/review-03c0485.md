# HORUS Code Review — Commit `03c0485`
**feat(intel): on-the-go compile framework (Phase 1)**

**Scope:** Stability, Functionality, Performance  
**Security:** Out of scope (per request)  
**Date:** 2026-06-25  
**Files reviewed:** 15 files, ~911 lines added  

---

## Executive Summary

The Phase 1 intel framework is well-architected and readable, with good separation of concerns (gather → synthesize), graceful LLM fallback chains, and bounded caches. However, **four Critical issues** create production stability risks: the Gemini adapter ignores abort signals/timeouts, the LLM fallback chain continues after client cancellation, the settings store can silently overwrite user edits during hydration, and the Settings UI crashes when switching to a custom theme before colors are initialized.

| Dimension | Grade | Trend (after fixes) |
|-----------|-------|---------------------|
| **Stability** | **C+** | **B+** |
| **Functionality** | **B** | **A-** |
| **Performance** | **B+** | **A-** |

---

## Critical Issues (fix before prod)

### 1. Gemini adapter ignores `AbortSignal` and `opts` — requests can hang indefinitely
- **File:** `src/lib/llm/gemini-adapter.ts` (line 24)
- **Issue:** `geminiChat` accepts `_opts?: LLMChatOptions` but never passes the caller's `AbortSignal`, `maxTokens`, or `temperature` into the SDK. When the Ollama rung fails and the framework falls back to Gemini, the request can hang forever if the network stalls.
- **Fix:** Pass `opts?.signal` into the SDK call or wrap `generateContent` in `Promise.race` with a timeout. Honor `maxTokens` and `temperature` if the SDK supports them.

### 2. LLM fallback chain continues after client abort
- **File:** `src/lib/llm/index.ts` (lines 37–46)
- **Issue:** `getLLM().chat()` catches an Ollama failure and proceeds to Gemini without checking whether `opts.signal` was already aborted. If the HTTP client disconnects, the handler stays busy and may still call Gemini.
- **Fix:** After each `catch`, check `if (opts?.signal?.aborted) throw new Error('Aborted');` before continuing to the next backend.

### 3. Settings hydration can overwrite live user edits
- **File:** `src/lib/settings/index.ts` (lines 136–151)
- **Issue:** `hydrate()` merges persisted settings over `DEFAULT_SETTINGS` after an `await backend().getAll()`. If `updateSettings()` is called while `getAll()` is still in flight, the new in-memory state is overwritten by stale persisted data.
- **Fix:** Track an `initialized` flag (or queue pending patches). Once the store has been mutated, skip the initial overwrite in `hydrate`.

### 4. SettingsPanel crashes when switching to Custom theme before colors exist
- **File:** `src/components/SettingsPanel.tsx` (~line 161)
- **Issue:** `const custom = settings.appearance.custom` is `undefined` when the user switches to **CUSTOM** theme via `Segmented` before any custom color has ever been set. `value={custom[token]}` throws `TypeError: Cannot read properties of undefined`.
- **Fix:** Defensive initialization: `const custom = settings.appearance.custom ?? {};` or guard the custom color block with `custom &&`.

---

## High Issues

### 5. `deterministicChat` can OOM on unbounded input
- **File:** `src/lib/llm/index.ts` (lines 33–34)
- **Issue:** `content.split('\n')` on a multi-gigabyte string will allocate an enormous array and crash the process.
- **Fix:** Cap `content` before parsing: `const capped = content.slice(0, 10_000);` then split/filter on `capped`. Also cap `bullets.join('\n')` to the same 1500-char limit already applied to the fallback body.

### 6. `bboxOfPoints` returns invalid bbox for empty array
- **File:** `src/lib/geo.ts` (lines 29–35)
- **Issue:** Returns `[90, 180, -90, -180]` when `points` is empty. Downstream code (e.g., map rendering, Overpass queries) may crash or produce undefined behavior.
- **Fix:** Return `null` for an empty array, or throw a descriptive error so callers handle it explicitly.

### 7. Firecrawl search lacks null-element guard
- **File:** `src/lib/search/firecrawl.ts` (lines 44–52)
- **Issue:** `Array.isArray` validates the array, not its contents. If Firecrawl returns `[null]`, `it.title` throws a `TypeError`.
- **Fix:** Add a guard before property access: `const it = (raw && typeof raw === 'object') ? raw : {};`.

### 8. `llmModel()` returns empty string on whitespace env var
- **File:** `src/lib/llm/ollama.ts` (line 17)
- **Issue:** If `process.env.LLM_MODEL` is whitespace (e.g., `"   "`), the `||` short-circuit sees it as truthy, `.trim()` collapses it to `""`, and Ollama receives `model: ""`.
- **Fix:** `return (process.env.LLM_MODEL?.trim() || DEFAULT_MODEL);`.

### 9. Compile cache is FIFO, not LRU
- **File:** `src/lib/intel/compile.ts` (lines 19–39)
- **Issue:** `Map.prototype.set()` does **not** update insertion order for existing keys, and `cacheGet` never promotes an entry. A frequently accessed entry can be evicted before a rarely used one.
- **Fix:** Delete and re-insert on `cacheSet` to move the key to the end of the `Map` iteration order, or maintain a separate `lastAccessed` timestamp.

### 10. Compile pipeline lacks error isolation / error-event emission
- **File:** `src/lib/intel/compile.ts` (lines 97–103)
- **Issue:** `provider.gather` and `provider.synthesize` are awaited without `try/catch`. The `CompileEvent` union includes an `'error'` event, but it is never emitted. A throw in `gather` or `synthesize` aborts the entire call without graceful degradation.
- **Fix:** Wrap `gather` and `synthesize` in `try/catch`. Emit `{ event: 'error', data: { message } }` before re-throwing (or returning a partial dossier).

### 11. Module-level cache is shared across all requests (memory pressure)
- **File:** `src/lib/intel/compile.ts` (line 19)
- **Issue:** `CACHE` is a process-global `Map`. While bounded to 200 entries, large dossier objects can create memory pressure in a long-running Next.js server process.
- **Fix:** Inject a cache instance via `CompileOptions`, or add a `maxByteSize` limit in addition to entry count.

### 12. `resolveGraph` ignores the caller's `AbortSignal`
- **File:** `src/lib/intel/compile.ts` (lines 42–61)
- **Issue:** Uses a fixed 12 s timeout but does not accept or chain `opts.signal`. If the consumer aborts the compile, the underlying fetch remains open until its own timeout expires.
- **Fix:** Accept an optional `signal` parameter and race it with the 12 s timeout via `safeAbortAny`.

### 13. `buildEngineEnv` has inverted precedence for overrides vs settings
- **File:** `desktop/runtime-config.js` (lines 27–31)
- **Issue:** `settings` is spread **after** `overrides`, so a non-blank value in `settings` silently shadows `overrides`. By design, overrides should be the highest-priority layer (e.g., CLI flags or temporary session overrides).
- **Fix:** Swap order: `...cleanSettingsEnv(settings), ...cleanSettingsEnv(overrides)` so overrides win.

### 14. `setColor` may overwrite the entire custom palette due to shallow merge
- **File:** `src/components/SettingsPanel.tsx` (line 90–91)
- **Issue:** `setColor` sends `custom: { [token]: value }` (single key). If `useSettings().update` performs a shallow merge on nested objects, each color change overwrites the entire `custom` palette, losing previously set colors.
- **Fix:** Merge into the existing custom object: `update({ appearance: { custom: { ...custom, [token]: value } } })` (or verify `deepMerge` is used).

---

## Medium Issues

### 15. Firecrawl `fetchPage` `validateHost` lacks timeout and error guard
- **File:** `src/lib/search/firecrawl.ts` (lines 66–76)
- **Issue:** `await validateHost(host)` has no timeout and no `try/catch`. If DNS hangs or throws unexpectedly, `fetchPage` hangs or leaks an unhandled rejection.
- **Fix:** Wrap in `try/catch` and add a timeout (e.g., `Promise.race` with a 5 s timer).

### 16. LLM health route returns HTTP 200 on error
- **File:** `src/app/api/llm/health/route.ts` (lines 14–18)
- **Issue:** Standard health probes (Kubernetes, load balancers) expect a non-2xx status to detect an unhealthy state.
- **Fix:** Return `status: 503` in the catch block.

### 17. SSE stream lacks backpressure guard
- **File:** `src/app/api/intel/compile/route.ts` (lines 82–86)
- **Issue:** The `send` function does not check `controller.desiredSize`. If `compile` emits events faster than the client consumes, the internal queue grows unbounded.
- **Fix:** Gate `send` with `if (controller.desiredSize !== null && controller.desiredSize <= 0) return;` before enqueuing, or pause the emitter until the stream is ready.

### 18. No concurrent-request deduplication for identical compiles
- **File:** `src/lib/intel/compile.ts` (lines 55–68)
- **Issue:** Two simultaneous calls with the same `cacheKey` both miss the cache and execute the full gather/synthesize pipeline, wasting LLM/search calls.
- **Fix:** Maintain an `INFLIGHT` `Map<string, Promise<Dossier>>`. Return the in-flight promise if one exists for the same key.

### 19. Shallow cache-hit copy allows mutation of cached object
- **File:** `src/lib/intel/compile.ts` (lines 55–68)
- **Issue:** `const dossier = { ...cached, provenance }` copies the top-level object, but nested arrays (`sections`, `citations`, `graph.nodes`) remain shared references. A caller mutating the returned dossier corrupts the cache entry.
- **Fix:** Deep-clone the cached dossier before returning it (e.g., `cloneJson(cached)` or `structuredClone`).

### 20. `deepMerge` destroys non-plain objects
- **File:** `src/lib/settings/index.ts` (lines 88–96)
- **Issue:** `const out: Plain = { ...base }` on a `Date` (or any object with non-enumerable internals) produces an empty object. `customSources: unknown[]` is unbounded and could contain them.
- **Fix:** Guard non-plain, non-array objects: if `base instanceof Date`, return `patch` if defined else `base`. Alternatively, reject patches with non-serializable values.

### 21. `notify()` iteration stops if a listener throws
- **File:** `src/lib/settings/index.ts` (line 133)
- **Issue:** `listeners.forEach((l) => l())` stops calling remaining listeners if one throws.
- **Fix:** Wrap each invocation: `listeners.forEach((l) => { try { l(); } catch (e) { console.error(...); } });`.

### 22. Silent provider overwrite in registry
- **File:** `src/lib/intel/providers/index.ts` (line 10)
- **Issue:** `registerProvider` overwrites an existing `kind` without warning.
- **Fix:** Check `PROVIDERS.has(provider.kind)` and throw or log a warning before overwriting.

### 23. Provider calls lack hard timeout in compile
- **File:** `src/lib/intel/compile.ts` (lines 97–98)
- **Issue:** If a provider ignores `ctx.signal`, `gather` or `synthesize` can hang indefinitely.
- **Fix:** Wrap the provider calls in `Promise.race` with a hard timeout (e.g., 30 s) that aborts the provider context.

### 24. SettingsPanel `useEffect` has unstable object dependency
- **File:** `src/components/SettingsPanel.tsx` (line 85)
- **Issue:** `settings.apiKeys` is an object reference in the effect deps. If `useSettings` returns a new object every render, the effect fires repeatedly (guarded by `wasOpenRef`, so it does nothing, but adds unnecessary cycles).
- **Fix:** Use a deep-comparison hook or move the snapshot logic into an `onOpen` transition handler.

### 25. Inline options arrays prevent future memoization
- **File:** `src/components/SettingsPanel.tsx` (lines 134, 174, 184, etc.)
- **Issue:** `options={[{ value: 'core', label: 'CORE' }, ...]}` are recreated every render. Since `Segmented` is not memoized today this is harmless, but it blocks future perf optimization.
- **Fix:** Hoist constant arrays outside the component or memoize them with `useMemo`.

### 26. Unmemoized callback creators
- **File:** `src/components/SettingsPanel.tsx` (lines 90, 93)
- **Issue:** `setColor` and `saveKeys` are re-created every render. If child components are wrapped in `memo` later, the prop references break memoization.
- **Fix:** Wrap in `useCallback` with stable dependency arrays.

### 27. No error handling on settings `update`
- **File:** `src/components/SettingsPanel.tsx` (line 94)
- **Issue:** `saveKeys` calls `update({ apiKeys: keys })` and immediately sets `saved(true)`. If persistence throws (e.g., `localStorage` quota exceeded), the UI falsely reports **SAVED**.
- **Fix:** Wrap `update` in `try/catch`; set `saved` only after success, and display an error state on failure.

### 28. Non-idiomatic `wasOpenRef` pattern
- **File:** `src/components/SettingsPanel.tsx` (line 73–85)
- **Issue:** `wasOpenRef` is used to track previous state. This works but is error-prone if logic branches are added later.
- **Fix:** Replace with a `usePrevious` hook or derive state transitions in a dedicated `useEffect`.

---

## Low Issues

| # | File | Line(s) | Issue | Suggested Fix |
|---|------|---------|-------|---------------|
| 29 | `src/lib/llm/index.ts` | 32 | `deterministicChat` creates unnecessary shallow copy of `messages` just to find last user message. | Iterate backwards with a `for` loop, or use `messages.findLast()`. |
| 30 | `src/app/api/intel/compile/route.ts` | 45, 46 | `providerKinds()` is called twice per request. | Call once and store: `const allowed = providerKinds();`. |
| 31 | `src/lib/geo.ts` | 22–25 | `bboxOfPoints` does not handle antimeridian crossing. Points at `179°` and `-179°` produce a 358° wide bbox instead of 2°. | Detect when `e - w > 180` and wrap the longitude range. |
| 32 | `src/lib/geo.ts` | 33–54 | `pointToSegmentMeters` uses local equirectangular projection, which is inaccurate for large segments (> ~100 km). | Document the intended use case (short distances), or switch to spherical geometry for long segments. |
| 33 | `src/lib/llm/gemini-adapter.ts` | 8–13 | `geminiKeys()` re-reads `process.env` on every call. Env vars are immutable at runtime. | Memoize the result at module load time. |
| 34 | `src/lib/llm/index.ts` | 61 | `llmHealth()` hardcodes the Gemini model name (`'gemini-2.0-flash'`), which can drift from the `GEMINI_MODEL` constant in `gemini-adapter.ts`. | Export `GEMINI_MODEL` from `gemini-adapter.ts` and import it. |
| 35 | `src/lib/search/firecrawl.ts` | 31 | `available()` always returns `true`, even if the service is unreachable or unconfigured. | Perform a lightweight health check or env-var validation. |
| 36 | `src/lib/search/firecrawl.ts` | 35 | `search` does not validate that `query` is non-empty before calling the API. | Early-return or throw if `!query?.trim()`. |
| 37 | `src/lib/intel/compile.ts` | 46 | Cache key omits `ref.label` and `ref.type`. If those fields materially change provider behavior, the cache returns stale data. | Include `ref.type` in the hash (or document that `type`/`label` are non-functional). |
| 38 | `src/lib/settings/index.ts` | 197–201 | `hexToRgb` only accepts 6-digit `#RRGGBB`. Shorthand (`#abc`) or CSS variables silently fall back to `null`. | Support 3-digit shorthand, or document the accepted format. |
| 39 | `src/lib/intel/providers/stub.ts` | 35 | `String(s.value)` on an object or array yields `"[object Object]"`, destroying data integrity. | Use `JSON.stringify` for non-primitive values, or guard the type. |
| 40 | `src/lib/intel/types.ts` | 173 | `canHandle?` is defined on `IntelProvider` but never used in `compile.ts`. | Either implement it in `getProvider` or remove it from the interface. |
| 41 | `desktop/runtime-config.js` | 15–17 | `cleanSettingsEnv` filters out empty strings. A user intentionally setting a key to `""` to clear it will be ignored, and the default will re-apply. | Document this behavior or accept `null` as an explicit "unset" signal. |
| 42 | `desktop/runtime-config.js` | 22 | Default parameter `processEnv = process.env` evaluates eagerly. If bundled in a non-Node context, `process` access could throw. | Default to `{}` and merge `process.env` inside the function body with a guard. |
| 43 | `src/components/SettingsPanel.tsx` | 116 | Unnecessary `as Partial<CustomThemeTokens>` in `setColor`. If the key is already `keyof CustomThemeTokens`, the assertion is redundant. | Remove the `as` cast. |

---

## Priority Action Plan

### Sprint 1 (blockers)
1. Fix Gemini adapter timeout/signal propagation (Critical #1).
2. Add `signal.aborted` check in LLM fallback chain (Critical #2).
3. Fix settings hydration race condition (Critical #3).
4. Defensively initialize `custom` palette in SettingsPanel (Critical #4).

### Sprint 2 (high impact)
5. Cap `deterministicChat` input size (High #5).
6. Guard `bboxOfPoints` against empty array (High #6).
7. Add null-element guard in Firecrawl search mapper (High #7).
8. Fix `llmModel()` whitespace fallback (High #8).
9. Implement LRU cache semantics in compile (High #9).
10. Add error isolation in compile pipeline (High #10).
11. Fix `buildEngineEnv` precedence (High #13).
12. Fix `setColor` shallow merge (High #14).

### Sprint 3 (polish / scale)
13. Add concurrent-request deduplication (Medium #18).
14. Deep-clone cache hits (Medium #19).
15. Add backpressure to SSE stream (Medium #17).
16. Return 503 from health endpoint on error (Medium #16).
17. Memoize inline arrays and callbacks in SettingsPanel (Medium #25, #26).
18. Fix `notify()` listener fault isolation (Medium #21).

---

*End of report.*
