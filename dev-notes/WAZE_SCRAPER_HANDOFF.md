# Waze Police/Camera Scraper Handoff

## App Integration — DONE (2026-06-27)

The scraper is now wired into the app as an **on-demand viewport scan** (not an
auto-refreshing layer). This was a deliberate choice: the only working Waze transport
is a headed Chromium window (see findings below) and `playwright` is a devDependency,
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

Example:

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
