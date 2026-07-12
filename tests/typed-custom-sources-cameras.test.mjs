import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const file = path => readFileSync(join(root, path), 'utf8');
const tsModule = path => import(pathToFileURL(join(root, path)).href);

test('United States CCTV bucket participates in map rendering and visibility', () => {
  const map = file('src/components/HorusMap.tsx');
  assert.match(map, /data\.cameras_united_states/);
  assert.match(map, /activeLayers\.cctv_united_states/);
  assert.match(map, /activeLayers\.cctv_europe \|\| activeLayers\.cctv_north_america \|\| activeLayers\.cctv_united_states/);
});

test('US ATMS coverage includes the five additional verified state endpoints', () => {
  const adapter = file('src/app/api/cctv/us-atms.ts');
  for (const host of ['www.az511.gov', '511.idaho.gov', 'www.nvroads.com', 'www.511la.org', '511.alaska.gov']) assert.match(adapter, new RegExp(host.replaceAll('.', '\\.')));
  const sources = file('src/lib/cctv/sources.ts');
  for (const region of ['us-az', 'us-id', 'us-nv', 'us-la', 'us-ak']) assert.match(sources, new RegExp(`'${region}'`));
});

test('legacy custom source records migrate without changing identity or activation', async () => {
  const { validateCustomSourceSpec } = await tsModule('src/lib/plugins/validation.ts');
  const result = validateCustomSourceSpec({ id: 'custom_old', label: 'Old', group: 'THREAT', color: '#00E5FF', url: '/api/old', latProp: 'latitude', lngProp: 'longitude', defaultActive: true }, { groupIds: ['THREAT'] });
  assert.equal(result.ok, true);
  const migrated = result.value;
  assert.equal(migrated.version, 2);
  assert.equal(migrated.sourceType, 'json-points');
  assert.equal(migrated.id, 'custom_old');
  assert.equal(migrated.defaultActive, true);
  assert.equal(migrated.latProp, 'latitude');
});

test('typed validation accepts all five source families and rejects invalid camera coordinates', async () => {
  const { validateCustomSourceSpec } = await tsModule('src/lib/plugins/validation.ts');
  const base = { version: 2, id: 'custom_valid', label: 'Valid', group: 'THREAT', color: '#00E5FF', url: 'https://example.com/source' };
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'live-camera', lat: 1, lng: 2, streamFormat: 'hls' }, { groupIds: ['THREAT'] }).ok, true);
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'snapshot-camera', lat: 1, lng: 2 }, { groupIds: ['THREAT'] }).ok, true);
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'json-points', latProp: 'lat', lngProp: 'lng' }, { groupIds: ['THREAT'] }).ok, true);
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'geojson' }, { groupIds: ['THREAT'] }).ok, true);
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'tile-layer', tileKind: 'raster' }, { groupIds: ['THREAT'] }).ok, true);
  assert.equal(validateCustomSourceSpec({ ...base, sourceType: 'live-camera', lat: 999, lng: 2 }, { groupIds: ['THREAT'] }).ok, false);
});

test('camera viewer separates adaptive snapshots, MJPEG, and continuous video labels', () => {
  const viewer = file('src/components/CameraViewer.tsx');
  assert.match(viewer, /AdaptiveSnapshot/);
  assert.match(viewer, /MJPEG LIVE/);
  assert.match(viewer, /LIVE SNAPSHOTS/);
  assert.match(viewer, /LIVE VIDEO/);
  assert.match(viewer, /failuresRef/);
});
