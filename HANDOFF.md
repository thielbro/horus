# OSIRIS — Session Handoff

`osiris-native-desktop` — Next.js 16 + Electron OSINT/counter-surveillance map app (MapLibre GL),
branch `main`. Read this top-to-bottom, then skim `git log`.

> ⚠️ Read `AGENTS.md` first: this is **Next.js 16 with breaking changes** — consult
> `node_modules/next/dist/docs/` before touching Next config/conventions.

The full roadmap for the current work stream lives at
`~/.claude/plans/alright-so-one-big-hazy-frog.md` (the "On-the-go Intel Framework" plan).

---

## Current work stream: the on-the-go intel framework

**Goal (user's words):** address search with intel, location tracking, and route planning —
but the real deliverable is a **broad, reusable "compile intel on the go" framework**: at
request time a **web search engine + a local LLM** gather & synthesize a dossier for an
entity. **No static database.** Address is the first provider; the same seam later wraps
person/company/vehicle/route across the whole intel side.

**Confirmed decisions:** local LLM = configurable **OpenAI-compatible endpoint, default
Ollama** (`127.0.0.1:11434`), fallback chain local→Gemini→deterministic. Search/scrape =
**self-hosted Firecrawl** (`/v1/search` + `/v1/scrape`). Photos = **Mapillary**. All three are
**user-run external services**, configured by URL in Settings — never bundled. The app
degrades gracefully when any is absent.

### Phase status
- ✅ **P1 — framework** (`03c0485`): Dossier schema + IntelProvider contract, `getLLM()` fallback
  chain, Firecrawl search, compile orchestrator (SSE), `/api/intel/compile`, `/api/llm/health`,
  geo primitives, settings keys. Stub provider proves the pipeline.
- ✅ **P2a — address provider** (`0ddb9dd`): geocode → nearby CCTV/ALPR/speed/police within a
  radius (one Overpass call, distance-filtered) → Firecrawl occupant → Mapillary photos → LLM
  exposure synth. `src/lib/geocode.ts` (Nominatim fwd/reverse).
- ✅ **P2b — Dossier UI + map overlay** (`c98ab97`): `DossierPanel` (SSE-streamed), headless
  `dossier` map layer (pin / radius ring / nearby markers / sightlines), `openOsirisDossier`
  global, entry points (SearchBar "INTEL" action + Surveillance panel "ADDRESS INTEL" box).
- ✅ **P3 — location tracking** (`02dbe12`): `LocationTracker` (opt-in GPS `watchPosition`,
  follow-me, throttled reverse-geocode, "INTEL ON MY LOCATION"), headless `user_position` layer
  (cyan dot + accuracy ring).
- ⏭️ **P4 — route planning + exposure** (NEXT — see below).
- ⏭️ **P5 — generalize** the intel side (person/company/vehicle providers; "Compile dossier" on
  graph nodes; optionally route `/api/ai/*` + AiAnalyst through `getLLM()`).

Also note: the user has done several **stability/optimization passes** on this work
(`f989488` "Harden dossier streaming and overlay handling", and inline hardening of the P1/P2
files). Build on those — see "Conventions" below.

---

## Intel framework — file map & contracts (`src/lib/intel`, `src/lib/llm`, `src/lib/search`)

- **`src/lib/intel/types.ts`** — the contract hub (pure types). `Dossier` is a *superset* of the
  intel sidecar's `/resolve` payload (its `graph` drops into `EntityGraphPanel`). `IntelProvider`
  splits **`gather`** (deterministic, parallel, cited — NO LLM) from **`synthesize`** (one LLM
  call). `ProviderCtx` gives a provider `search`, `llm`, `resolve(type,id)`, `fetchPage(url)`,
  `emit(ev)`, `signal`. `MediaItem` carries photos. `CompileEvent` is the SSE union.
- **`src/lib/intel/compile.ts`** — orchestrator. Byte-bounded LRU dossier cache + **single-flight
  `INFLIGHT`** dedup (user-hardened), per-stage 30s abort (`runProviderStage`/`abortable`),
  `/resolve` graph enrichment, provenance. Streams `status → graph → section → done`.
- **`src/lib/intel/providers/{index,stub,address}.ts`** — `registerProvider` registry keyed by
  `kind`. Add new kinds here (mirrors `RESOLVERS` in the sidecar).
- **`src/lib/llm/{index,ollama,gemini-adapter}.ts`** — `getLLM()` returns one `chat()` with the
  fallback chain. `llmHealth()` reports the live rung. Gemini keys are read once at module load.
- **`src/lib/search/{index,firecrawl}.ts`** — `getSearch()` → Firecrawl. `search()` + `fetchPage()`
  (scrape → markdown). **LLM-proposed scrape URLs are SSRF-validated** (`validateHostWithTimeout`).
- **`src/lib/geocode.ts`** — `geocode` / `reverseGeocode` / `formatAddress` (Nominatim, server-side).
- **`src/lib/geo.ts`** — `haversineMeters`, `pointBbox`, `bboxOfPoints` (antimeridian-aware,
  returns `null` if empty), `pointToSegmentMeters`/`pointToLineMeters`, `circlePolygon`. Pure
  math, safe to import client-side.
- **Routes:** `src/app/api/intel/compile/route.ts` (SSE; `?stream=0` → JSON; backpressure-aware),
  `src/app/api/llm/health/route.ts`.
- **UI:** `src/components/DossierPanel.tsx` (SSE reader + render), `src/components/LocationTracker.tsx`.
- **Map overlays:** headless `dossier` + `user_position` layers in `src/lib/registry/builtins.ts`;
  `OsirisMap` takes `dossierOverlay` + `userPosition` props and `setGeo`s the sources in effects
  (mirrors the `scanTargets` pattern). `geo.circlePolygon` builds the radius/accuracy rings.
- **`page.tsx` wiring:** `window.openOsirisDossier(ref)` global + `onDossierLoaded` (flyTo +
  overlay), state `dossierTarget/showDossier/dossierOverlay/userPosition`, `<DossierPanel>` +
  `<LocationTracker>` renders, `SearchBar onIntel`, Surveillance panel ADDRESS INTEL box.

### Settings keys (flow `ApiKeys` → `buildEngineEnv` → `process.env` on desktop; `.env` on web)
`LLM_URL` (default `http://127.0.0.1:11434/v1`), `LLM_MODEL` (default `llama3.1`),
`FIRECRAWL_URL` (default `http://127.0.0.1:3002`), `FIRECRAWL_KEY?`, `MAPILLARY_TOKEN?`.
(`ROUTING_URL` lands in P4.) Desktop defaults live in `desktop/runtime-config.js`.

---

## ⏭️ Phase 4 — route planning + surveillance exposure (start here)

Per the plan, reuse the framework with a new `kind: 'route'`:
1. **`src/app/api/route/route.ts`** — thin proxy (template = `src/app/api/entity/expand/route.ts`)
   to OSRM via `ROUTING_URL` (default the public OSRM demo `https://router.project-osrm.org` for
   dev; **note self-host for prod**). Input start/end (lat,lng); return `{geometry:LineString,
   distance, duration}`. Use `safeAbortTimeout` + `releaseResponseBody`.
2. **`src/lib/intel/providers/route.ts`** (`kind:'route'`): `gather` = call routing → route
   polyline; compute corridor bbox via `geo.bboxOfPoints(coords, padM)` (tile if it exceeds the
   25° Overpass cap); query nearby surveillance (one Overpass call like `address.ts`); filter to
   points within W metres of the line via `geo.pointToLineMeters`; order by distance-along.
   `synthesize` = LLM "surveillance exposure" briefing (counts by type, densest segments, ALPR
   chokepoints). `geometry` = FeatureCollection (route line + corridor + exposure points).
3. **Map overlay:** headless `route` layer in `builtins.ts` (`route-line` glow/core, `route-corridor`
   fill, `route-surveil` markers — reuse `osmPointStyle`); `OsirisMap` `routeOverlay` prop + a
   `setGeo` effect (mirror the dossier overlay effect). Add `route-surveil-dots` to the cursor
   list + a click popup.
4. **`src/components/RoutePlanner.tsx`** — start/end inputs (geocode via `src/lib/geocode` or the
   SearchBar pattern), trigger `kind:'route'` compile, render the exposure summary. Mount in
   `page.tsx` (add `routeTarget`/`routeOverlay` state + an entry point, e.g. in the Surveillance
   panel next to ADDRESS INTEL).
5. **Settings:** add `ROUTING_URL` to `ApiKeys` + `SettingsPanel` + `runtime-config` defaults.

**Verify:** start/end → route drawn; markers only inside the corridor; exposure counts match
markers; long routes tile under the 25° cap. `curl '/api/route?...'` + `/api/intel/compile?kind=route`.

---

## How to run / verify SAFELY

- **NEVER run raw `next dev`** — Turbopack's dev server has fork-bombed `node.exe` on Windows
  (handle exhaustion). `npm run dev` is the **guarded watchdog** (`scripts/dev-watchdog.ps1`).
- **Agent verification this stream used the Claude_Preview MCP:** `preview_start "osiris-web"`
  (runs the guarded `npm run dev` on port 3000) → then `curl http://localhost:3000/...`,
  `preview_eval`, `preview_console_logs`, `preview_screenshot`. This worked cleanly all of P1–P3.
  (The standalone build path — `npm run build && npm run desktop:prepare` then
  `preview_start "osiris-standalone"` — also exists in `.claude/launch.json`.)
- **`npx tsc --noEmit`** is the fastest correctness gate — run it after every change; it's been
  clean through P3.
- **Never mass-kill `node`** — the harness + MCP servers run on node.

### Curl recipes (dev server on :3000)
```
# stub pipeline (no external services needed)
curl 'http://localhost:3000/api/intel/compile?kind=stub&id=test&stream=0'
# address dossier (geocode + Overpass nearby; deterministic LLM if no Ollama)
curl 'http://localhost:3000/api/intel/compile?kind=address&id=Trafalgar%20Square,%20London&stream=0'
curl -N 'http://localhost:3000/api/intel/compile?kind=address&id=Eiffel%20Tower&force=1'   # SSE
curl 'http://localhost:3000/api/llm/health'
```
Address compile returns ~39 CCTV near Trafalgar Square — good smoke test. With Ollama/Firecrawl/
Mapillary running, the summary becomes a real LLM assessment + web results + photos.

### Verifying GPS (P3) in the headless preview
No real GPS — mock it before clicking "LOCATE ME":
```js
navigator.geolocation.watchPosition = (ok) => { setTimeout(() => ok({ coords:{ latitude:51.5085, longitude:-0.1285, accuracy:28, heading:null }, timestamp:Date.now() }), 60); return 1; };
navigator.geolocation.clearWatch = () => {};
```
Then `preview_eval` to click the button and read `map.querySourceFeatures('user-position')`.

---

## Conventions (the codebase is defensively hardened — match it)
- **Outbound fetches:** use `safeAbortTimeout(ms)` / `safeAbortAny([signal, ...])` /
  `releaseResponseBody(res)` from `@/lib/http-utils` (feature-detected AbortSignal polyfills).
  For **our own configured local services** (Ollama, Firecrawl, OSRM, intel sidecar) use plain
  `fetch` — `safeFetch` would block `127.0.0.1`. For **user/LLM-supplied external URLs**, use
  `safeFetch` / `validateHost` (SSRF guard).
- Providers run outbound calls in **`Promise.allSettled`** and tolerate partial failure; pass
  `ctx.signal` to every fetch (the per-stage 30s timeout rides on it).
- `stableHash` (from `http-utils`) keys caches; `cloneJson` for cache isolation.
- **Commits:** the user often does a stability pass on each commit — keep commits focused and
  verified; end messages with the `Co-Authored-By: Claude Opus 4.8` trailer. On `main`, the user
  commits directly here. Leave pre-existing unrelated working-tree changes alone.

---

## Reused seams (don't reinvent)
- **Intel sidecar** `intel/server.js` `GET /resolve?type=&id=` → `{nodes,links}` (aircraft/vessel/
  company/person/ip/country; Wikidata/OFAC/RIPEstat). Proxied by `src/app/api/entity/expand/route.ts`,
  rendered by `EntityGraphPanel.tsx`. The dossier graph reuses this shape + enriches via `ctx.resolve`.
- **Overpass** `src/lib/overpass.ts` (`runOverpassLayer`, bbox `[s,w,n,e]`, 25° cap) backs the
  `/api/{police,flock,mass-surveillance,surveillance}` layers; the address/route providers do their
  own single combined Overpass call for radius/corridor.
- **Registry** `src/lib/registry/` (RegistryLayer/FeedDef/customSource) — declarative layers/feeds.
  Headless layers render on the map with no sidebar toggle (how `dossier`/`user_position` work).
- **AI layer** `src/lib/ai-engine.ts` (Gemini) is the Gemini rung behind `getLLM()`; `AiAnalyst` +
  `/api/ai/*` are untouched (optional P5: route them through `getLLM()`).

---

## Previously shipped (background — all done & on `main`)
The Electron desktop shell, the **declarative source/layer registry** that replaced the old
3-place-hardcoded layer model, no-code **custom sources** + trusted in-process **JS plugins**
(`src/lib/plugins/`), custom themes, **saved workspaces/layouts** (`src/lib/workspaces.ts`),
bundled **scanner + intel** backends (forked by `desktop/main.js`), and a continent-split CCTV
surveillance menu + counter-surveillance OSM layers (police/flock/mass-surveillance) + a source
tester. See `git log` and `FINAL_CODE_REVIEW.md` for that history.

### Key decisions (don't re-litigate)
- **Electron** (not Tauri); **Windows-first**; one shared codebase with the web app.
- **Plugins are trusted single-author**, in-process, **no sandbox**.
- External intel services (Ollama/Firecrawl/OSRM/Mapillary) are **user-run, URL-configured, never
  bundled**; graceful degradation is mandatory.
- **No static DB** for intel — compile on demand and cache with a TTL. This is the whole point.

---

## Memory
Auto-loaded memory files (`~/.claude/projects/.../memory/`) carry the project plan + cautions; a
new session loads those automatically. This file is the deep reference, and the plan file
(`~/.claude/plans/alright-so-one-big-hazy-frog.md`) has the full P1–P5 roadmap.
