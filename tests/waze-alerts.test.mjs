import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';

import {
  buildWazeGeoRssUrl,
  classifyWazeAlert,
  dedupeAlerts,
  normalizeWazeAlert,
  parseBbox,
  scrapeWazePoliceCameraAlerts,
  tileBbox,
} from '../src/lib/traffic-alerts/index.ts';

const execFileAsync = promisify(execFile);

test('parseBbox validates south,west,north,east input', () => {
  assert.deepEqual(parseBbox('-36.95,174.65,-36.75,174.95'), [-36.95, 174.65, -36.75, 174.95]);
  assert.throws(() => parseBbox('-36.95,174.65,-37,174.95'), /south must be less than north/);
  assert.throws(() => parseBbox('-36.95,181,-36.75,174.95'), /longitude/);
  assert.throws(() => parseBbox('bad'), /expected south,west,north,east/);
});

test('tileBbox splits large boxes into bounded tiles', () => {
  const tiles = tileBbox([0, 0, 2.4, 2.1], 1);

  assert.equal(tiles.length, 9);
  assert.deepEqual(tiles[0], [0, 0, 1, 1]);
  assert.deepEqual(tiles.at(-1), [2, 2, 2.4, 2.1]);
});

test('tileBbox splits antimeridian-crossing boxes into two non-crossing halves', () => {
  // Fiji-ish box crossing 180°: west=178, east=-178. Every tile must be west<east.
  const tiles = tileBbox([-18, 178, -16, -178], 1);
  assert.ok(tiles.length > 0);
  for (const [s, w, n, e] of tiles) {
    assert.ok(w < e, `tile west(${w}) should be < east(${e})`);
    assert.ok(s < n);
    assert.ok(w >= -180 && e <= 180);
  }
  // Coverage reaches both sides of the antimeridian.
  assert.ok(tiles.some((t) => t[1] >= 178), 'expected a tile on the 178°E side');
  assert.ok(tiles.some((t) => t[3] <= -178), 'expected a tile on the -178°W side');
});

test('buildWazeGeoRssUrl mirrors the Waze Live Map request shape', () => {
  const url = buildWazeGeoRssUrl([40.7, -74.03, 40.85, -73.85], 'na');

  assert.match(url, /types=alerts,traffic,users/);
  assert.doesNotMatch(url, /alerts%2Ctraffic%2Cusers/);
});

test('classifyWazeAlert keeps only police and camera alert variants', () => {
  assert.equal(classifyWazeAlert({ type: 'POLICE', subtype: 'POLICE_HIDING' }), 'police');
  assert.equal(classifyWazeAlert({ type: 'POLICE_VISIBLE' }), 'police');
  assert.equal(classifyWazeAlert({ type: 'SPEED_CAM' }), 'camera');
  assert.equal(classifyWazeAlert({ type: 'CAMERA', subtype: 'RED_LIGHT_CAMERA' }), 'camera');
  assert.equal(classifyWazeAlert({ type: 'HAZARD', subtype: 'HAZARD_ON_ROAD' }), null);
});

test('normalizeWazeAlert preserves raw Waze details and coordinates', () => {
  const alert = normalizeWazeAlert({
    uuid: 'abc-123',
    type: 'POLICE',
    subtype: 'POLICE_HIDING',
    location: { x: 174.7633, y: -36.8485 },
    pubMillis: 1760000000000,
    reliability: 7,
    confidence: 3,
    street: 'Queen Street',
  });

  assert.equal(alert?.id, 'abc-123');
  assert.equal(alert?.kind, 'police');
  assert.equal(alert?.lat, -36.8485);
  assert.equal(alert?.lng, 174.7633);
  assert.equal(alert?.type, 'POLICE');
  assert.equal(alert?.subtype, 'POLICE_HIDING');
  assert.equal(alert?.reliability, 7);
  assert.equal(alert?.confidence, 3);
  assert.equal(alert?.description, 'Queen Street');
  assert.equal(alert?.raw.type, 'POLICE');
  assert.match(alert?.reportTime ?? '', /^2025-/);
});

test('dedupeAlerts prefers Waze ids and falls back to stable location hashes', () => {
  const first = normalizeWazeAlert({ uuid: 'dup', type: 'POLICE', location: { x: 1, y: 2 } });
  const second = normalizeWazeAlert({ uuid: 'dup', type: 'POLICE_VISIBLE', location: { x: 1.1, y: 2.1 } });
  const third = normalizeWazeAlert({ type: 'SPEED_CAM', location: { x: 3, y: 4 }, pubMillis: 1760000000000 });
  const fourth = normalizeWazeAlert({ type: 'SPEED_CAM', location: { x: 3, y: 4 }, pubMillis: 1760000000000 });

  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.ok(fourth);
  assert.deepEqual(
    dedupeAlerts([first, second, third, fourth]).map((alert) => alert.id),
    ['dup', third.id],
  );
});

test('scrapeWazePoliceCameraAlerts filters fixture responses to police and cameras only', async () => {
  const result = await scrapeWazePoliceCameraAlerts({
    bbox: [10, 20, 10.5, 20.5],
    transport: {
      fetchGeoRss: async () => ({
        alerts: [
          { uuid: 'police-1', type: 'POLICE', subtype: 'POLICE_VISIBLE', location: { x: 20.1, y: 10.1 } },
          { uuid: 'camera-1', type: 'SPEED_CAM', location: { x: 20.2, y: 10.2 } },
          { uuid: 'hazard-1', type: 'HAZARD', location: { x: 20.3, y: 10.3 } },
        ],
      }),
    },
  });

  assert.equal(result.provider, 'waze');
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.alerts.map((alert) => alert.kind), ['police', 'camera']);
  assert.deepEqual(result.alerts.map((alert) => alert.id), ['police-1', 'camera-1']);
});

test('scrape-waze-alerts CLI can run from a fixture without live Waze access', async () => {
  const dir = join(tmpdir(), `horus-waze-alerts-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const fixturePath = join(dir, 'georss.json');
  const outputPath = join(dir, 'alerts.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      alerts: [
        { uuid: 'police-cli', type: 'POLICE_HIDING', location: { x: 174.7, y: -36.8 } },
        { uuid: 'hazard-cli', type: 'HAZARD', location: { x: 174.8, y: -36.9 } },
      ],
    }),
    'utf8',
  );

  await execFileAsync(process.execPath, [
    'node_modules/tsx/dist/cli.mjs',
    'scripts/scrape-waze-alerts.ts',
    '--bbox=-36.95,174.65,-36.75,174.95',
    `--fixture=${fixturePath}`,
    `--out=${outputPath}`,
  ]);

  const output = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(output.provider, 'waze');
  assert.deepEqual(output.alerts.map((alert) => alert.id), ['police-cli']);
});

// ── shared in-page fetch (desktop/waze-in-page.js) ──────────────────────────
// The module is imported dynamically inside each test so a missing module fails
// only the in-page tests (TDD RED) and leaves the nine existing ones green.
// Run wazeInPageFetchGeoRss({ url, actions }) with stubbed document/grecaptcha/
// fetch globals; save/restore around each call.

const WAZE_STUB_URL = 'https://www.waze.com/live-map/api/georss?x=1';

function docStub(textContent) {
  return { querySelector: (selector) => (selector === '#gon' ? { textContent } : null) };
}

async function withInPageStubs(stubs, run) {
  const prev = {
    document: globalThis.document,
    grecaptcha: globalThis.grecaptcha,
    fetch: globalThis.fetch,
  };
  globalThis.document = stubs.document;
  globalThis.grecaptcha = stubs.grecaptcha;
  globalThis.fetch = stubs.fetch;
  try {
    return await run();
  } finally {
    globalThis.document = prev.document;
    globalThis.grecaptcha = prev.grecaptcha;
    globalThis.fetch = prev.fetch;
  }
}

test('falls back to the next token action when Waze 403s the first', async () => {
  const calls = [];
  const { result, script } = await withInPageStubs(
    {
      document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) => {
            calls.push(opts.action);
            return Promise.resolve('tok-' + opts.action);
          },
        },
      },
      fetch: async (url, init) => {
        const ok = init?.headers?.['x-recaptcha-token'] === 'tok-api';
        return { ok, status: ok ? 200 : 403, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss, buildWazeFetchScript } = await import('../desktop/waze-in-page.js');
      const result = await wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'] });
      return { result, script: buildWazeFetchScript(WAZE_STUB_URL) };
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.attempts, [
    { action: 'livemap', status: 403 },
    { action: 'api', status: 200 },
  ]);
  assert.deepEqual(calls, ['livemap', 'api']);
  assert.match(script, /"actions":\["livemap","api"\]/);
});

test('sends no token header when the page has no recaptcha site key', async () => {
  const seenHeaders = [];
  const result = await withInPageStubs(
    {
      document: docStub('{}'),
      grecaptcha: undefined,
      fetch: async (url, init) => {
        seenHeaders.push(init?.headers ?? {});
        return { ok: true, status: 200, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'] });
    },
  );

  assert.equal(result.status, 200);
  assert.equal(seenHeaders.length, 1);
  for (const headers of seenHeaders) {
    assert.ok(!('x-recaptcha-token' in headers), 'expected no x-recaptcha-token header');
  }
  assert.deepEqual(result.attempts, [{ action: null, status: 200 }]);
});

test('returns the last 403 when every action is rejected', async () => {
  const calls = [];
  const result = await withInPageStubs(
    {
      document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) => {
            calls.push(opts.action);
            return Promise.resolve('tok-' + opts.action);
          },
        },
      },
      fetch: async () => ({ ok: false, status: 403, text: async () => '{"alerts":[]}' }),
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'] });
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(calls, ['livemap', 'api']);
  assert.deepEqual(result.attempts.map((a) => a.action), ['livemap', 'api']);
});

test('mints the next action when execute() rejects', async () => {
  const result = await withInPageStubs(
    {
      document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) =>
            opts.action === 'livemap'
              ? Promise.reject(new Error('mint failed'))
              : Promise.resolve('tok-api'),
        },
      },
      fetch: async (url, init) => {
        const ok = init?.headers?.['x-recaptcha-token'] === 'tok-api';
        return { ok, status: ok ? 200 : 403, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'] });
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.attempts, [
    { action: 'livemap', status: 403 },
    { action: 'api', status: 200 },
  ]);
});

// ── review hardening (2026-11): serialized-form execution, mint stall, guards ─

// Finding 1: the script Playwright/Electron actually run must be self-contained.
// Executing it inside a brand-new vm context (no module scope, no imports, no
// WAZE_TOKEN_ACTIONS closure) turns any future closure reference into a suite
// failure instead of a browser-only failure.
test('serialized fetch script runs standalone in a bare vm context', async () => {
  const calls = [];
  const { buildWazeFetchScript } = await import('../desktop/waze-in-page.js');
  const script = buildWazeFetchScript(WAZE_STUB_URL);

  const raw = await vm.runInNewContext(script, {
    document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
    grecaptcha: {
      enterprise: {
        ready: (cb) => cb(),
        execute: (key, opts) => {
          calls.push(opts.action);
          return Promise.resolve('tok-' + opts.action);
        },
      },
    },
    fetch: async (url, init) => {
      const ok = init?.headers?.['x-recaptcha-token'] === 'tok-api';
      return { ok, status: ok ? 200 : 403, text: async () => '{"alerts":[]}' };
    },
    setTimeout,
    clearTimeout,
    console,
  });

  // The vm realm hands back that realm's prototypes, which strict deepEqual
  // rejects across realms; normalize through JSON before comparing values.
  const result = JSON.parse(JSON.stringify(raw));
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.attempts, [
    { action: 'livemap', status: 403 },
    { action: 'api', status: 200 },
  ]);
  assert.deepEqual(calls, ['livemap', 'api']);
});

// Finding 2a: a recaptcha.enterprise.ready/execute that never settles must not
// hang the page.evaluate forever — each mint is raced against arg.mintTimeoutMs
// (default 10s) and a stalled mint takes the existing mint-failure path.
// The explicit test timeout is the RED guard: before the race exists this hangs.
test('stalled mint falls through to the next action', { timeout: 5_000 }, async () => {
  const result = await withInPageStubs(
    {
      document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) =>
            opts.action === 'livemap'
              ? new Promise(() => {}) // never resolves: simulate a stalled recaptcha
              : Promise.resolve('tok-api'),
        },
      },
      fetch: async (url, init) => {
        const ok = init?.headers?.['x-recaptcha-token'] === 'tok-api';
        return { ok, status: ok ? 200 : 403, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'], mintTimeoutMs: 50 });
    },
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.attempts, [
    { action: 'livemap', status: 403 },
    { action: 'api', status: 200 },
  ]);
});

// Finding 3: a #gon element that is not valid JSON (interstitial, partial DOM)
// must degrade to the tokenless path instead of throwing out of the page.
test('malformed #gon JSON falls back to a tokenless attempt', async () => {
  const seenHeaders = [];
  const result = await withInPageStubs(
    {
      document: docStub('not json'),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) => Promise.resolve('tok-' + opts.action),
        },
      },
      fetch: async (url, init) => {
        seenHeaders.push(init?.headers ?? {});
        return { ok: true, status: 200, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: ['livemap', 'api'] });
    },
  );

  assert.equal(result.status, 200);
  assert.equal(seenHeaders.length, 1);
  for (const headers of seenHeaders) {
    assert.ok(!('x-recaptcha-token' in headers), 'expected no x-recaptcha-token header');
  }
  assert.deepEqual(result.attempts, [{ action: null, status: 200 }]);
});

// Finding 6: actions must never crash the routine when it is empty or missing.
test('empty actions with recaptcha present makes a single tokenless attempt', async () => {
  const seenHeaders = [];
  const result = await withInPageStubs(
    {
      document: docStub(JSON.stringify({ recaptchaActionSiteKey: 'site-key' })),
      grecaptcha: {
        enterprise: {
          ready: (cb) => cb(),
          execute: (key, opts) => Promise.resolve('tok-' + opts.action),
        },
      },
      fetch: async (url, init) => {
        seenHeaders.push(init?.headers ?? {});
        return { ok: true, status: 200, text: async () => '{"alerts":[]}' };
      },
    },
    async () => {
      const { wazeInPageFetchGeoRss } = await import('../desktop/waze-in-page.js');
      return wazeInPageFetchGeoRss({ url: WAZE_STUB_URL, actions: [] });
    },
  );

  assert.equal(result.status, 200);
  assert.equal(seenHeaders.length, 1);
  for (const headers of seenHeaders) {
    assert.ok(!('x-recaptcha-token' in headers), 'expected no x-recaptcha-token header');
  }
  assert.deepEqual(result.attempts, [{ action: null, status: 200 }]);
});

// ── Task 5: --debug raw type histogram ──────────────────────────────────────
test('debugLog receives a raw type histogram per tile', async () => {
  const lines = [];
  await scrapeWazePoliceCameraAlerts({
    bbox: [10, 20, 10.1, 20.1],
    debugLog: (m) => lines.push(m),
    transport: {
      fetchGeoRss: async () => ({
        alerts: [
          { uuid: 'p1', type: 'POLICE', location: { x: 20.05, y: 10.05 } },
          { uuid: 'h1', type: 'HAZARD', location: { x: 20.05, y: 10.05 } },
          { uuid: 'h2', type: 'HAZARD', location: { x: 20.06, y: 10.06 } },
          { uuid: 'j1', type: 'JAM', location: { x: 20.07, y: 10.07 } },
        ],
      }),
    },
  });
  const histogram = lines.find((line) => line.includes('raw=4'));
  assert.ok(histogram, `expected a histogram line, got: ${JSON.stringify(lines)}`);
  assert.match(histogram, /HAZARD=2/);
  assert.match(histogram, /POLICE=1/);
  assert.match(histogram, /JAM=1/);
});

// ── Task 6: loud error summaries ────────────────────────────────────────────
import { summarizeWazeErrors } from '../src/lib/traffic-alerts/index.ts';

test('summarizeWazeErrors groups by message and hints at the playwright install', () => {
  const lines = summarizeWazeErrors([
    { message: 'Waze browser HTTP 403', status: 403, transport: 'browser', tile: [1, 2, 1.5, 2.5] },
    { message: 'Waze browser HTTP 403', status: 403, transport: 'browser', tile: [1, 2.5, 1.5, 3] },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 tile\(s\)/);
  assert.match(lines[0], /Waze browser HTTP 403/);
  const install = summarizeWazeErrors([{ message: "Executable doesn't exist at C:\\x\\chrome.exe", tile: [0, 0, 1, 1] }]);
  assert.match(install[0], /npx playwright install chromium/);
});
