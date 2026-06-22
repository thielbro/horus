# OSIRIS — Session Handoff

**This is `osiris-native-desktop`** — a standalone repo (branch `main`), forked from the
original `osiris` repo as a clean snapshot to escape worktree/branch trouble. The full
phase-by-phase history lives in the original osiris repo; here it's **squashed into the
initial commit**, so the commit hashes named below (e.g. `9b23f2f`, `704c366`) refer to
that original repo — `git log` here shows one commit. The tree is clean; **continue at
Phase 2 Step 4c** (see below). Run `npm install` first (node_modules was not copied).
Read this top-to-bottom, then skim `git log`.

> ⚠️ Read `AGENTS.md` first: this is Next.js 16 with breaking changes — consult
> `node_modules/next/dist/docs/` before touching Next config/conventions.

---

## The goal
Turn the OSIRIS OSINT dashboard (Next.js 16 web app) into a **Windows Electron desktop
app** with deep customization: no-code custom sources/layers, **trusted single-author JS
plugins** (no sandbox — see decisions), custom themes, saved layouts. The keystone is a
**declarative source/layer registry** (`src/lib/registry/`) that replaces the old
3-place-hardcoded layer model, so plugins + builtins target one surface.

## ⛔ How to run/verify SAFELY (this has crashed the machine twice — do not repeat)
- **NEVER run raw `next dev`.** Turbopack's dev server fork-bombs `node.exe` to 3000+ on
  Windows (handle exhaustion, `os error 1450`). Root cause was the deprecated `middleware.ts`
  (now migrated to `proxy.ts`), but treat dev as dangerous.
- `npm run dev` is now the **guarded watchdog** (`scripts/dev-watchdog.ps1`); `npm run dev:raw`
  is the unguarded server. The agent's sandboxed PowerShell **cannot `Start-Process`**
  (`EPERM uv_spawn`), so it can't run the watchdog — the **user** runs `npm run dev` themselves.
- **Agent verification path = the standalone production build** (never fork-bombed, runs in
  ~1 node process):
  ```
  npm run build && npm run desktop:prepare
  # then preview_start "osiris-standalone"  (config already in .claude/launch.json)
  ```
  Verify via preview_eval / preview_console_logs / preview_network. The preview renders at
  ~417px (mobile) by default — `preview_resize` to width 1440 to see the desktop layer rail.
- `tsc --noEmit` is safe and the fastest correctness gate. `next build` is safe (0 leaked procs).
- **Never mass-kill `node`** — the harness + MCP servers run on node. Ask the user to restart.

---

## What's done (committed)
- **Plugin SDK** `@osiris/plugin-sdk` (`plugins-sdk/`) — the locked contract (`36a2a1d`).
- **Phase 0 — Electron shell** (`desktop/`): forks the Next standalone server, secure
  preload bridge, NSIS build (`189190d`, `0770ab0`). Packaged `.exe` proven to serve.
- **Phase 1 — Settings** (`src/lib/settings/`, `SettingsPanel.tsx`): web localStorage +
  desktop userData store, themes, map defaults, desktop API keys (`aca4e18`).
- **Stability / the fork-bomb fix**: `middleware.ts → proxy.ts`, lazy AIS socket, globalThis
  rate-limit maps, EventSource/HLS/timer leak fixes, dev watchdog (`4841b11`, `69e3354`,
  `ff2db9d`, `373032e`, `20bdec1`). Plus user+Codex stability/optimization passes (`4d711f6`,
  `337845f`, `e74c79c`, `da5abdd`, `31b85eb`).
- **Phase 2 — registry refactor (the active work):**
  - `c7f0785` — Step 1+2: registry module (`src/lib/registry/`) + LayerPanel reads from it.
  - `c423073` — Step 3: feed loading → `useFeedEngine` (page.tsx fetch wiring removed).
  - `9b23f2f` — Step 4a: map render engine (`mapEngine.ts`) + **earthquakes** migrated.

## Current state (ALL COMMITTED in the initial commit of this repo)
Everything below is already in the tree — the working tree is clean. The last work done was:
- **Phase 2 through Step 4b**: registry module, LayerPanel + feed engine, map render engine,
  and the **earthquakes, fires, global_incidents (gdelt), gps_jamming** layers migrated to
  the registry. Verified tsc + next build + standalone (no console errors).
- A Codex stability/optimization review batch (api routes, ai-engine, ssrf-guard, sdk, the
  hardened `registry/engine.ts` with abort-on-unmount + per-feed intervals, tests).

**Step 4c — DONE (static-paint groups migrated):** weather, infrastructure, malware
(dots/glow/label only — network-mesh stays raw for 4z), satellites, live_news, and maritime
(maritime + chokepoint style layers + all 3 render bindings; **ship-dots/ship-label stay raw**
in OsirisMap init because they sit after the SDK mesh lines in z-order). Verified: tsc 0,
next build 0, standalone preview — layers paint globally and the satellite click-popup still
fires; no `[OSIRIS] Registry … failed` errors. NOT committed yet.

**Deferred out of 4c (need the 4d theme extension or a new registry layer):**
- **surveillance** — uses `surveillanceColor` (a ghost-theme recolor), so it belongs with the
  4d theme-aware work next to cctv, not the static batch.
- **sigint-news / `news_intel`** — has live style layers + a setGeo body but **no registry
  layer entry exists**; migrating it means adding a new layer, beyond the verbatim-copy recipe.

**Next: Phase 2 Step 4d** — theme-aware groups (see below).

---

## Phase 2 — the registry migration recipe (follow this for each remaining group)
The strangler pattern: **zero visible change** per group; verify after each.

For a layer group, in `src/lib/registry/builtins.ts` add to its `RegistryLayer`:
- `styleLayers: [...]` — verbatim copy of the group's `map.addLayer({...})` paint/layout/filter
  (shape: `{ id, source, type, paint?, layout?, filter?, minzoom?, maxzoom? }`).
- `render: [{ source, toFeatures: (data, active) => active.<key> && data.<bucket> ? data.<bucket>.map(...) : [] }]`
  — verbatim copy of the group's `setGeo('<source>', ...)` body.

Then in `src/components/OsirisMap.tsx`:
- Replace the group's `map.addLayer({...})` block(s) — **at the same init position** — with
  `addRegistryLayer(map, '<layerId>');` (same ids ⇒ z-order, click handlers, cursor list all keep working).
- Replace the group's `setGeo(...)` effect **body** with `renderRegistryLayer(setGeo, '<layerId>', data, activeLayers);`
  (keep the effect's existing fine-grained deps → no perf regression).

`mapEngine.ts` already try/catches and logs `[OSIRIS] Registry … failed` instead of crashing,
so a bad spec shows in the console.

## Remaining Phase 2 work
- **Step 4c — DONE** (see Current state above).
- **Step 4d — theme-aware groups** (need a small engine extension first): cctv (cameraColor),
  **surveillance (surveillanceColor)**, flights (4 layers + plane icons + decimation), other
  ghost-recolored ones. Also fold in **sigint-news/`news_intel`** here (needs a new registry
  layer entry). **Extension TODO:**
  let `addRegistryLayer` resolve theme-dependent paint — e.g. allow paint values to be
  `(theme) => value` (or palette tokens), and pass `theme` to `addRegistryLayer`. Decide this
  before migrating cctv/flights.
- **Step 4z — computed bindings** (last, trickiest): SDK lines (`sdk-links`), `network-mesh`
  (derived from malware nodes), day/night solar terminator (`computeSolarTerminator`),
  ip-sweep / scan-targets (RECON viz), conflict-zones, war-alerts. These compute features from
  multiple buckets / functions — `RenderBinding.toFeatures` already receives the whole `data`,
  so most fit; the terminator is a special non-data source.
- **Step 5 — cleanup**: prune migrated source names from the `sources = [...]` array in
  OsirisMap init; converge the internal `RegistryLayer` with the `@osiris/plugin-sdk` `LayerDef`;
  delete dead code.

## After Phase 2 (the original plan)
Phase 3 — no-code custom sources/layers + JS plugins (both register into this registry);
saved workspaces. The plugin model is **trusted in-process** (no sandbox) — see decisions.

---

## Key decisions (don't re-litigate)
- **Electron** (not Tauri) — keeps the ~60 Next API routes working via the embedded server.
- **Windows-only**, **one shared codebase** with the web app.
- **Plugins are trusted single-author** (user + their AI agents, never published) → **no
  sandbox / permissions / IPC marshaling**; plugins are in-process ES modules registering into
  the registry. The sandboxed-process design exists only as a documented upgrade path if they
  ever publish.
- **Umami analytics is opt-in** behind `UMAMI_ENDPOINT` (set in docker-compose for prod; unset
  in dev/desktop so the Docker-only host is never contacted).

## Registry file map (`src/lib/registry/`)
- `types.ts` — RegistryGroup/RegistryLayer/FeedDef/StyleLayerSpec/RenderBinding + `resolveColor`.
- `builtins.ts` — the builtin groups + layers (metadata + styleLayers/render as migrated).
- `feeds.ts` — builtin feeds (core/lazy, transforms, intervals, activatedBy).
- `store.ts` — group/layer registry (register/get); seeded on import.
- `engine.ts` — `useFeedEngine` (data loading; user-hardened with abort + interval lifecycle).
- `mapEngine.ts` — `addRegistryLayer` / `renderRegistryLayer` (map render glue, try/catch-safe).
- `icons.tsx` — lucide icon-name resolver (+ local Shield). `index.ts` — barrel.

## Memory
The auto-loaded memory files (`~/.claude/projects/.../memory/`) carry the desktop-app plan,
the registry-refactor status, and the fork-bomb caution. A new session loads those automatically;
this file is the deep reference.
