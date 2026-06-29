import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

const FIXED_LAYER_ROUTES = [
  ['flock', 'src/app/api/flock/route.ts'],
  ['police', 'src/app/api/police/route.ts'],
  ['mass_surveil', 'src/app/api/mass-surveillance/route.ts'],
  ['surveillance', 'src/app/api/surveillance/route.ts'],
];

test('four fixed counter-surveillance routes proxy to SURVEILLANCE_FEED_URL instead of Overpass', () => {
  for (const [layer, path] of FIXED_LAYER_ROUTES) {
    const source = file(path);
    assert.match(source, /proxySurveillanceLayer/, `${layer} should use sidecar proxy helper`);
    assert.match(source, new RegExp(`layer:\\s*'${layer}'`), `${layer} route should request its sidecar layer`);
    assert.doesNotMatch(source, /runOverpassLayer/, `${layer} route must not call direct Overpass`);
    assert.doesNotMatch(source, /clausesFor:/, `${layer} route should not contain inline Overpass query clauses`);
  }
});

test('police route keeps the local curated NZ fallback path', () => {
  const source = file('src/app/api/police/route.ts');
  assert.match(source, /curatedPoliceAll/);
  assert.match(source, /searchParams\.get\('curated'\)/);
  assert.match(source, /police_curated|curated/i);
});

test('Waze scraping route and UI path are not wired to the surveillance feed sidecar', () => {
  const route = file('src/app/api/waze-alerts/route.ts');
  const page = file('src/app/page.tsx');
  const panel = file('src/components/SurveillancePanel.tsx');

  assert.match(route, /scrapeWazePoliceCameraAlerts/);
  assert.doesNotMatch(route, /SURVEILLANCE_FEED_URL|proxySurveillanceLayer/);
  assert.match(page, /\/api\/waze-alerts\?bbox=/);
  assert.match(panel, /onScanWaze/);
});

test('viewport layer hook preserves current fixed-layer markers when fetches fail', () => {
  const hook = file('src/lib/registry/useViewportLayers.ts');
  assert.doesNotMatch(hook, /clearBucket\?\(/);
  assert.doesNotMatch(hook, /Clear stale markers immediately/);
  assert.match(hook, /leave the existing bucket as-is/);
});

test('settings and compose expose the lightweight surveillance sidecar without touching other panels', () => {
  const settings = file('src/lib/settings/index.ts');
  const settingsPanel = file('src/components/SettingsPanel.tsx');
  const compose = file('docker-compose.yml');

  assert.match(settings, /SURVEILLANCE_FEED_URL\?: string/);
  assert.match(settingsPanel, /Surveillance Feed URL/);
  assert.match(settingsPanel, /SERVICE_URL_FIELDS/);
  assert.match(settingsPanel, /<SectionTitle icon=\{Server\}>SERVICE URLS<\/SectionTitle>/);
  assert.match(compose, /surveillance-feed:/);
  assert.match(compose, /context:\s+\.\/surveillance-feed/);
  assert.match(compose, /dockerfile:\s+Dockerfile/);
  assert.doesNotMatch(compose, /dockerfile:\s+surveillance-feed\/Dockerfile/);
  assert.match(compose, /SURVEILLANCE_FEED_URL=\$\{SURVEILLANCE_FEED_URL:-http:\/\/surveillance-feed:7800\}/);
});
