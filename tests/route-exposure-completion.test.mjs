import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('route exposure map registers route overlay layer before pushing features', () => {
  const map = file('src/components/HorusMap.tsx');
  const routeLayerIndex = map.indexOf("addRegistryLayer(map, 'route'");
  const routeEffectIndex = map.indexOf("const o = routeOverlay;");

  assert.notEqual(routeLayerIndex, -1, 'HorusMap should register the route registry layer');
  assert.ok(routeLayerIndex < routeEffectIndex, 'route sources/layers must exist before route setGeoBatch runs');
});

test('route dossier loads fit the full route bounds and preserve route item metadata', () => {
  const page = file('src/app/page.tsx');

  assert.match(page, /fitRouteBounds/);
  assert.match(page, /source:\s*String\(f\.properties\?\.source/);
  assert.match(page, /alongM:\s*Number\.isFinite\(alongM\)/);
  assert.match(page, /feedUrl:\s*typeof f\.properties\?\.feedUrl === 'string'/);
  assert.match(page, /externalUrl:\s*typeof f\.properties\?\.externalUrl === 'string'/);
});

test('route provider gathers fixed CCTV and best-effort Waze alerts into item-level evidence', () => {
  const route = file('src/lib/intel/providers/route.ts');

  assert.match(route, /fetchCctvCamerasForPoint/);
  assert.match(route, /scrapeWazePoliceCameraAlerts/);
  assert.match(route, /WAZE_ROUTE_MAX_BBOX_AREA_DEG/);
  assert.match(route, /Detected On Route/);
  assert.match(route, /on_route_items/);
  assert.match(route, /source:\s*it\.source/);
  assert.match(route, /feedUrl:\s*it\.feedUrl/);
  assert.match(route, /externalUrl:\s*it\.externalUrl/);
});

test('CCTV route API consumes the reusable camera source helper', () => {
  const cctvRoute = file('src/app/api/cctv/route.ts');
  const helper = file('src/lib/cctv/sources.ts');

  assert.match(cctvRoute, /fetchCctvCamerasForRequest/);
  assert.match(helper, /export async function fetchCctvCamerasForRequest/);
  assert.match(helper, /export async function fetchCctvCamerasForPoint/);
  assert.match(helper, /export function getRegionsForBounds/);
  assert.match(helper, /mergeCamerasFairly/);
});
