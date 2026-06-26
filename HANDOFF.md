# HORUS — Session Handoff

`horus-native-desktop` — Next.js 16 + Electron OSINT/counter-surveillance map app (MapLibre GL),
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
  `dossier` map layer (pin / radius ring / nearby markers / sightlines), `openHorusDossier`
  global, entry points (SearchBar "INTEL" action + Surveillance panel "ADDRESS INTEL" box).
- ✅ **P3 — location tracking** (`02dbe12`): `LocationTracker` (opt-in GPS `watchPosition`,
  follow-me, throttled reverse-geocode, "INTEL ON MY LOCATION"), headless `user_position` layer
  (cyan dot + accuracy ring).
- ✅ **P4 — route planning + exposure**: `kind:'route'` provider (`src/lib/intel/providers/route.ts`)
  — resolve start/end → OSRM polyline (`src/lib/routing.ts` + `/api/route` proxy) → corridor bbox
  (tiled under the 25° cap) → one Overpass call per tile → devices within 150m of the line, ordered
  start→end → LLM exposure briefing. Headless `route` map layer (cyan line + glow, corridor buffer
  fill, kind-coloured on-route markers); `HorusMap` `routeOverlay` prop + setGeo effect + click
  popup; `RoutePlanner` entry point in the Surveillance panel. Settings: `ROUTING_URL`. Reuses the
  `DossierPanel` (kind-agnostic) for display. **Also fixed a latent streaming bug** (see below).
- ⏭️ **P5 — generalize** the intel side (person/company/vehicle providers; "Compile dossier" on
  graph nodes; optionally route `/api/ai/*` + AiAnalyst through `getLLM()`). **NEXT — see below.**

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
- **`src/lib/intel/providers/{index,stub,address,route}.ts`** — `registerProvider` registry keyed by
  `kind`. Add new kinds here (mirrors `RESOLVERS` in the sidecar).
- **`src/lib/routing.ts`** — `routeBetween(start,end)` / `routingBaseUrl()` (OSRM via `ROUTING_URL`,
  plain fetch). Shared by `/api/route` (proxy) and the route provider.
- **`src/lib/geo.ts`** route additions — `projectPointOnLine` (perp + along distance, for corridor
  filtering/ordering), `bufferPolygon` (corridor fill ring), `tileBbox` (split a corridor bbox under
  the Overpass area cap).
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
  `HorusMap` takes `dossierOverlay` + `userPosition` props and `setGeo`s the sources in effects
  (mirrors the `scanTargets` pattern). `geo.circlePolygon` builds the radius/accuracy rings.
- **`page.tsx` wiring:** `window.openHorusDossier(ref)` global + `onDossierLoaded` (flyTo +
  overlay), state `dossierTarget/showDossier/dossierOverlay/userPosition`, `<DossierPanel>` +
  `<LocationTracker>` renders, `SearchBar onIntel`, Surveillance panel ADDRESS INTEL box.

### Settings keys (flow `ApiKeys` → `buildEngineEnv` → `process.env` on desktop; `.env` on web)
`LLM_URL` (default `http://127.0.0.1:11434/v1`), `LLM_MODEL` (default `llama3.1`),
`FIRECRAWL_URL` (default `http://127.0.0.1:3002`), `FIRECRAWL_KEY?`, `MAPILLARY_TOKEN?`,
`ROUTING_URL` (default the public OSRM demo `https://router.project-osrm.org`; self-host for prod).
Desktop defaults live in `desktop/runtime-config.js`.

---

## ✅ Phase 4 — route planning + surveillance exposure (DONE)

Shipped exactly per the plan. Notes for whoever builds on it:
- **Route ref encoding:** the route provider takes `ref.id = "<start>|<end>"` where each side is
  either `"lat,lng"` or a free-text place it geocodes. `RoutePlanner` builds that id and calls the
  `window.openHorusDossier` global with `kind:'route'`; the kind-agnostic `DossierPanel` renders the
  result and `page.tsx`'s `onDossierLoaded` branches on `d.kind === 'route'` to build `routeOverlay`
  (line/corridor/surveil) from the dossier `geometry`. No separate route panel — reuse the dossier UI.
- **Geometry roles:** `route` (LineString), `corridor` (Polygon ring), `surveil` (Points). The panel's
  "nearby" list now also accepts `role:'surveil'` (shown as "SURVEILLANCE ON ROUTE").
- **Corridor:** devices kept within `CORRIDOR_W_M = 150`m of the line (`projectPointOnLine`), ordered
  by `alongM`. Corridor bbox padded `200`m then `tileBbox`-split under a 24° cap (≤16 tiles), one
  Overpass call per tile in `Promise.allSettled`, deduped by node id.

### ⚠️ Fixed a latent SSE streaming bug (affected ALL kinds on cache hits)
The compile route's `send()` drops events when `controller.desiredSize <= 0`. The **cache-hit path**
(`emitDossier`) emits `graph → section → done` *synchronously*, so with the default highWaterMark of 1
every event after `graph` was dropped — a revisited (cached) address/route rendered "No dossier". The
live path only escaped this because its inter-stage `await`s let the consumer drain. **Fix:** the
`ReadableStream` now uses `new CountQueuingStrategy({ highWaterMark: 1024 })`
(`src/app/api/intel/compile/route.ts`). If you touch that stream, keep the headroom.

## ⏭️ Phase 5 — generalize the intel side (start here)

Per the plan: add more `kind`s (person / company / vehicle) as `IntelProvider`s registered in
`src/lib/intel/providers/index.ts`, following the `address`/`route` template (split `gather`
deterministic + cited from `synthesize` one-LLM-call). Wire "Compile dossier" actions on
`EntityGraphPanel` nodes (call `window.openHorusDossier({ kind, id, label })`). Optionally route
`/api/ai/*` + `AiAnalyst` through `getLLM()` so the whole app shares the local→Gemini→deterministic
fallback chain. Reuse `ctx.resolve(type,id)` to enrich graphs from the intel sidecar.

---

## How to run / verify SAFELY

- **NEVER run raw `next dev`** — Turbopack's dev server has fork-bombed `node.exe` on Windows
  (handle exhaustion). `npm run dev` is the **guarded watchdog** (`scripts/dev-watchdog.ps1`).
- **Agent verification this stream used the Claude_Preview MCP:** `preview_start "horus-web"`
  (runs the guarded `npm run dev` on port 3000) → then `curl http://localhost:3000/...`,
  `preview_eval`, `preview_console_logs`, `preview_screenshot`. This worked cleanly all of P1–P3.
  (The standalone build path — `npm run build && npm run desktop:prepare` then
  `preview_start "horus-standalone"` — also exists in `.claude/launch.json`.)
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
# route exposure (OSRM + tiled Overpass corridor; id = "start|end", place or "lat,lng")
curl 'http://localhost:3000/api/route?from=51.501,-0.142&to=51.505,-0.075'
curl 'http://localhost:3000/api/intel/compile?kind=route&id=Buckingham%20Palace%2C%20London%7CTower%20Bridge%2C%20London&stream=0'
curl 'http://localhost:3000/api/llm/health'
```
The Buckingham Palace → Tower Bridge route returns a 5.7km line with ~67 CCTV / 12 ALPR within 150m —
a good route smoke test. **Cache-hit tip:** re-request *without* `force=1` and confirm the SSE still
emits `graph`+`section`+`done` (this is the path the streaming bug above broke).
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
