# Waze Police/Camera Scraper Handoff

## 2026-11-05: RT transport is now primary — GeoRSS is the fallback

Branch `feat/waze-rt-transport`. The scraper gained Waze's mobile **RT protocol** as its
primary transport. Everything below this section — the GeoRSS / reCAPTCHA / headed-Chromium
story — stays intact and accurate, but now reads as the **fallback** story, not the only
story.

### Why RT exists

User reports (`POLICE`, hazards, etc.) arrive **only** over RT. The Waze *web* GeoRSS feed
is server-side sanitized (`hideUserReportsAndWazers=true`) and carries just road closures
and jams — which is exactly what the healthy 2026-11-03 probes showed (`raw=85
ROAD_CLOSED=85`, zero police in view). If you want police sightings, you need the mobile
protocol. That is why RT exists.

### Transport modes

| `--transport` / `?transport=` | behaviour |
|---|---|
| `auto` (default) | **RT-first per tile.** If RT fails for a tile, that tile falls back **once** to the legacy GeoRSS chain (Electron proxy → plain HTTP → headed browser); the next tile still tries RT. No RT retry at this level — the RT call already consumed (or tried) the capped register budget. |
| `rt` | Waze mobile RT protocol only: protobuf over `POST /rtserver/distrib/{static,login,command}` against `rt-xlb-{am,il,row}.waze.com` (region picked per tile centre). No GeoRSS, no browser, no reCAPTCHA. |
| `http` | GeoRSS plain HTTP only — pure legacy, no RT (usually 403s, see history below). |
| `browser` | GeoRSS via headed Chromium (Playwright) only — pure legacy, no RT. |

### How an RT scrape works

1. **register** — anonymous account via `/static`, only when no cached credentials exist.
2. **login** — once per scrape via `/login`.
3. **command sweep per tile** — a `circleToBox` handshake at the tile centre, then 5
   `MapDisplayed` commands over shrinking boxes (×0.5 steps) under a 10 s wall-clock
   deadline checked before each command. The server never re-sends alerts within one
   session, so the shrinking series is what recovers coverage on big viewports.

Concurrent tiles share one RT session (and its handshake). The cached account works across
RT regions: switching region costs one extra `login`, never a re-`register`.

### Credentials cache and the register cap

- Credentials are cached at `~/.horus/waze-rt-credentials.json`. In the packaged app,
  `desktop/main.js` sets `WAZE_RT_CREDS_FILE` to the Electron userData dir, i.e. a
  per-installation `waze-rt-credentials.json` under `%APPDATA%` on Windows.

- **Register is capped at roughly 10 accounts/day per IP**, so the cache is what keeps
  normal use inside the cap. Deleting the creds file forces re-registration; if the cap is
  exhausted, `auto` still serves data through the GeoRSS fallback chain.

### Requirements

- **Node ≥ 22 for the `rt` path** (it uses `AbortSignal.any`; the dev machine runs Node
  25.5.0). Everything else keeps the repo-wide `engines.node >= 20.9.0`.
- `protobufjs` is a new **runtime** dependency (`protobufjs-cli` stays dev-only).
- `src/lib/traffic-alerts/waze.proto` is vendored and the committed
  `waze-rt.proto.json` descriptor is generated from it — run `npm run waze:proto` after
  editing the proto.

### Test accounting

`npx tsx --test tests/waze-alerts.test.mjs tests/waze-rt-alerts.test.mjs` → **30 pass / 0
fail** (20 legacy GeoRSS/CLI + 10 new RT tests; the RT fixtures are built with the real
vendored proto, so framing and parsing are exercised for real). Note:
`tests/performance-stability.test.mjs` has a **pre-existing failure unrelated to this
branch** — its expected `console.warn` source predates `feat/waze-rt-transport` — out of
scope, not a regression.

### Live acceptance (measured 2026-11-05)

- Auckland `-36.90,174.70,-36.80,174.85` `--transport=rt`: **18 s cold** (one register) →
  30 raw alerts incl. 3 `POLICE`, `errors: []`; **5 s warm** (login only, creds file hit).
- Cross-region warm (LA right after Auckland): **4.3 s**, 1 `POLICE` — extra login, no
  register.
- `GET /api/waze-alerts?...` with `?transport=rt` and with plain `auto`: both returned 3
  police alerts with `errors: []`, ~3 s warm.
- Overnight `POLICE=0` with `errors: []` is a legitimate upstream state, **not a bug** —
  the `--debug` per-tile histogram still distinguishes "raw>0, none police" from "every
  tile failed".

## App Integration — DONE (2026-06-27)

The scraper is now wired into the app as an **on-demand viewport scan** (not an
auto-refreshing layer). This was a deliberate choice: at the time the only working Waze
transport was a headed Chromium window (see findings below; superseded 2026-11-05 — RT is
now primary, see the top section) and `playwright` is a devDependency,
so an auto-refetch-on-pan layer would pop a browser window on every viewport change and
would not work in a packaged build. Instead the user explicitly scans the current view.

What was added:
- `src/app/api/waze-alerts/route.ts` — `GET ?bbox=s,w,n,e`, Node runtime, rate-limited
  (6/min/IP), area-capped (4 deg²), returns `{ alerts, total, timestamp, errors }`.
- `src/lib/registry/builtins.ts` — headless `waze_alerts` registry layer (glow/dot/label,
  colored by kind: police = red `#FF1744`, camera = amber `#FFC400`) + `waze_alerts` bucket.
- `src/components/HorusMap.tsx` — layer registration, render-sync effect, visibility, and a
  `waze-dots` click popup ("Police Reported" / "Speed Camera" with report time + reliability).
- `src/components/SurveillancePanel.tsx` — "WAZE LIVE ALERTS" section with a **Scan this area**
  button (loading/result/error states, count + timestamp, show/hide-on-map toggle).
- `src/app/page.tsx` — `scanWazeAlerts()` reads the live viewport bounds, calls the route,
  writes the `waze_alerts` bucket, and flips the layer on.

Verified live: scanning a viewport near Dubrovnik returned a real `POLICE` alert on the M20
that rendered as a red marker with a working popup. Typecheck clean; 8/8 unit tests pass;
lint has 0 new errors. Still intentionally NOT done: no registry **feed** (on-demand, not
polled) and no Electron/background polling.

## Original State (library + CLI)

Branch: `codex/waze-police-camera-scraper`

The Waze scraper is implemented as a standalone TypeScript library plus CLI.

Implemented:
- `src/lib/traffic-alerts/`
  - bbox parsing/validation/tiling
  - Waze Live Map GeoRSS URL construction
  - Waze police/camera classification
  - alert normalization and dedupe
  - HTTP transport with browser fallback
- `scripts/scrape-waze-alerts.ts`
  - CLI wrapper around the library
  - supports fixture mode for offline tests
- `tests/waze-alerts.test.mjs`
  - unit/fixture coverage for bbox, tiling, URL shape, classification, dedupe, scraper filtering, and CLI fixture mode
- `package.json`
  - added `scrape:waze-alerts`
  - added `tsx` and `playwright`
- `tsconfig.json`
  - enabled `allowImportingTsExtensions`

Not implemented at the time of this section (see "App Integration — DONE" above for status):
- ~~no `/api/...` route~~ → done (`/api/waze-alerts`)
- ~~no map layer~~ → done (headless `waze_alerts` layer)
- no registry feed (intentional — on-demand scan, not polled)
- ~~no panel integration~~ → done (Surveillance panel "Scan this area")
- no Electron/background polling integration (intentional)

## CLI Usage

`--transport` takes `auto | rt | http | browser` (2026-11-05; see the modes table at the
top). Live RT example:

```powershell
npx tsx scripts/scrape-waze-alerts.ts --bbox=-36.90,174.70,-36.80,174.85 --transport=rt --debug
```

Legacy GeoRSS example:

```powershell
npm run scrape:waze-alerts -- --bbox=33.80,-118.55,34.20,-118.05 --transport=auto --max-tile-degrees=1 --concurrency=1
```

Write output to a file:

```powershell
npm run scrape:waze-alerts -- --bbox=-36.95,174.65,-36.75,174.95 --transport=auto --out=alerts.json
```

Fixture/offline mode:

```powershell
npm run scrape:waze-alerts -- --bbox=-36.95,174.65,-36.75,174.95 --fixture=fixture-georss.json --out=alerts.json
```

Output shape:

```json
{
  "timestamp": "2026-06-26T16:40:37.885Z",
  "provider": "waze",
  "alerts": [],
  "errors": []
}
```

Each normalized alert includes:
- `id`
- `provider`
- `kind`: `police` or `camera`
- `lat`
- `lng`
- `type`
- `subtype`
- `reportTime`
- `reliability`
- `confidence`
- `description`
- `raw`

## Important Waze Findings

*(GeoRSS history, kept verbatim. The RT transport in the top section never touches GeoRSS
or reCAPTCHA — these findings now apply to the fallback chain.)*

Waze does not allow a simple server-side fetch anymore.

Observed behavior:
- Plain HTTP request to `https://www.waze.com/live-map/api/georss` returns `403`.
- Headless Playwright also returns `403`.
- A headed Chromium session works after:
  - loading Waze Live Map,
  - waiting briefly for the page anti-abuse bootstrap,
  - executing Waze's reCAPTCHA Enterprise `livemap` action,
  - calling GeoRSS with `x-recaptcha-token`.

The browser fallback currently defaults to headed Chromium because headless was rejected during live testing.

Waze also rejected `types=alerts` alone. The working request shape mirrors the Waze Live Map app:

```text
types=alerts,traffic,users
```

The scraper still returns only police/camera alerts and discards traffic/users.

## Verification Already Run

Passed:

```powershell
npx tsx --test tests/waze-alerts.test.mjs
```

Result: 8/8 tests passed.

Passed:

```powershell
npx tsc --noEmit
```

Passed with warnings only:

```powershell
npm run lint
```

Lint warnings are existing repo-wide warnings, not scraper errors.

Live Waze probe:

```powershell
npm run scrape:waze-alerts -- --bbox=33.80,-118.55,34.20,-118.05 --transport=auto --max-tile-degrees=1 --concurrency=1
```

Returned real Waze `POLICE` alerts with `errors: []`. One returned subtype was `POLICE_WITH_MOBILE_CAMERA`.

## Known Caveats

*(Pre-RT list, kept as history — every item applies to the GeoRSS fallback chain; an RT
scan opens no window at all, and `auto` is RT-first since 2026-11-05, see top section.)*

- The working live transport opens a visible Chromium window briefly.
- Waze may change its anti-abuse/reCAPTCHA flow.
- Camera classification is covered by fixtures, but live testing only confirmed police and `POLICE_WITH_MOBILE_CAMERA`; no standalone live speed-camera alert was observed during testing.
- `transport=auto` tries HTTP first, then headed browser fallback on 403.
- `--browser-headless=true` exists but may fail live Waze due to reCAPTCHA/headless rejection.

## Suggested Next Step: Wire Into App — IMPLEMENTED

This plan was followed (steps 1–5) except step 6/7: rather than an always-on "separate live
layer" that auto-refetches per viewport, it's an **on-demand scan** (Surveillance panel
button) because the headed-browser transport would otherwise pop a Chromium window on every
pan. See "App Integration — DONE" at the top. The layer naming below was kept verbatim.

Original minimal app integration path:

1. Add a Next route, e.g. `src/app/api/waze-alerts/route.ts`.
2. Accept `bbox=s,w,n,e`.
3. Rate limit like other OSINT/map APIs.
4. Call `scrapeWazePoliceCameraAlerts({ bbox, transport: 'auto' })`.
5. Return `{ alerts, total, timestamp, errors }`.
6. Add a registry feed/layer only after the API route works.
7. Render police/camera alerts as a separate live layer, not mixed with static OSM surveillance cameras.

Recommended layer naming:
- layer id: `waze_alerts`
- bucket: `waze_alerts`
- group: likely `surveil`
- marker colors:
  - police: blue/red
  - camera: yellow/orange

## Suggested Future Improvement: Camoufox

Camoufox may improve the browser fingerprint story, but it is Python-first. Best approach is to add it as an optional transport later:

```powershell
--transport=camoufox
```

Keep output schema identical. Do not replace the deterministic TypeScript normalizer.

## Suggested Future Improvement: LLM

Do not use an LLM in the core extraction path.

Good LLM uses:
- summarize extracted alerts,
- review unknown Waze `type`/`subtype` values,
- suggest new deterministic classifier rules.

Bad LLM uses:
- deciding core police/camera classification for known Waze fields,
- driving the browser,
- bypassing Waze protections.

## Existing Dirty Worktree Note

Before this work, the repo already had unrelated dirty files in app/map/registry areas. Those were not part of the scraper implementation and should be reviewed separately before staging or committing.

## 2026-11-03: GeoRSS action gate — breakage, fix, validation

Supersedes parts of the "Important Waze Findings" section above (kept intact as history).

### Symptom & root cause

- Waze moved `/live-map/api/georss` behind a reCAPTCHA Enterprise **action gate**: the old
  recipe's action name `livemap` now 403s at the georss call itself; the action `api` is
  accepted. Minting succeeds either way — only the fetch verdict differs.
- Separately, the `ms-playwright` browser binaries were simply **missing on this machine**,
  so the dev HTTP→browser fallback was dead before Waze even got a vote. `npx playwright
  install chromium` restores it.
- Live evidence of the fix working: attempts trail `[livemap->403, api->200]`, returning
  85 raw alerts (all `ROAD_CLOSED`, Los Angeles) on a good run.

### Architecture change (branch `fix/waze-georss-2026-11`)

- `desktop/waze-in-page.js` (+ `.d.ts`) is now the **single shared CJS in-page fetch
  routine** used by BOTH the Playwright browser transport (`src/lib/traffic-alerts/waze.ts`)
  and the Electron proxy (`desktop/main.js`). electron-builder ships `desktop/**/*`, and the
  Next bundle inlines the same module, so there is exactly one implementation.
- Token minting tries `WAZE_TOKEN_ACTIONS = ['livemap', 'api']` in order and records an
  `attempts[]` trail (`{action, status}` per attempt) that surfaces inside Waze browser HTTP
  403 messages, e.g. `Waze browser HTTP 403 [livemap->403, api->403]` when both actions
  are rejected (a `->200` last entry only appears on successful runs, where no throw occurs).
- Per-mint timeout `mintTimeoutMs` (default 10 s) around `grecaptcha.enterprise.execute`,
  plus a 35 s race around `page.evaluate` so a wedged page can't hang a tile forever.
- Stealth launch is **chrome-channel-first** (`channel: 'chrome'` with a bundled-Chromium
  fallback): `--disable-blink-features=AutomationControlled`, `navigator.webdriver`
  stripped via init script, and **no UA override** — the old override pinned a UA that
  exactly matched bundled Chromium 149 anyway, i.e. it added mismatch risk for nothing.
- Diagnostics: `--debug` / `debugLog` prints a per-tile raw alert-type histogram
  (`[waze-debug] tile [...]: raw=85 ROAD_CLOSED=85`); `summarizeWazeErrors` groups CLI
  errors and hints `npx playwright install chromium` when the launch itself failed;
  SurveillancePanel now distinguishes "Scan failed — Waze rejected every tile request"
  (with the first error) from a genuinely empty "No Waze alerts in this view".

### Validation (measured 2026-11-03, all gates green)

- `npx tsx --test tests/waze-alerts.test.mjs` → **20 pass / 0 fail** (incl. the electron-transport attempts-trail regression test added at final review).
- `npx tsc --noEmit` → silent, exit 0.
- `npm run lint` → **0 errors / 92 warnings** (all pre-existing repo-wide style warnings).
- `npm run build` → exit 0, standalone tree produced.
- Bundle proof (new shared module inside the production server bundle):
  `grep -r "mint timeout" .next/standalone/` hits
  `.next/standalone/.next/server/chunks/[root-of-the-server]__0kn_jk2._.js` and
  `[root-of-the-server]__0wke99q._.js` (module also shows `["livemap","api"]`,
  `mintTimeoutMs`, `recaptchaActionSiteKey`, attempts trail);
  `grep -rlo "recaptchaActionSiteKey" .next/standalone/ | wc -l` → **2**;
  `.next/standalone/server.js` present (fresh build).
- `npm run desktop:smoke` → **HORUS_SMOKE_OK**, exit 0 (running the fresh standalone build).
- Live probes (`--transport=browser --concurrency=1 --debug`, one per bbox):
  - LA `33.80,-118.55,34.20,-118.05`: exit 0, `[waze-debug] tile [...]: raw=85
    ROAD_CLOSED=85`, **0 police/camera alerts, `errors: []`** — channel exercised
    (only 200 responses yield raw alerts); no police/camera reports in view at that hour.
  - Auckland `-36.95,174.65,-36.75,174.95`: exit 0, `[waze-debug] tile [...]: raw=94
    ROAD_CLOSED=94`, **0 police/camera alerts, `errors: []`** — same shape: raw>0 with no
    police/camera types is a legitimate outcome; the histogram proves it.

### Known caveats now

*(GeoRSS fallback chain caveats — since 2026-11-05, RT-first `auto` bypasses the web-side
bot-scoring whenever the RT sweep succeeds; see the top section.)*

- Waze bot-scores this residential IP: intermittent **all-403** with a well-formed trail
  `[livemap->403, api->403]` happens minutes after a good run. Wait and rescan; the
  Electron proxy self-heals via page reload + retry.
- Police reports near you can legitimately be zero at 3 a.m. — the `--debug` histogram
  distinguishes "raw>0, none police/camera" from "every tile 403'd".
- `--transport=browser` still opens a **visible** Chromium window during a scan.
- Paid feeds (e.g. OpenWeb Ninja) and camoufox remain unimplemented options, not gaps in
  the current fix.
