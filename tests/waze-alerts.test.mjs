import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

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
