import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

async function tsModule(path) {
  return import(pathToFileURL(join(root, path)).href);
}

test('workspace snapshots normalize to the expected version: 1 shape', async () => {
  const { normalizeWorkspaceSnapshot, DEFAULT_WORKSPACE_VIEW, DEFAULT_WORKSPACE_UI } =
    await tsModule('src/lib/workspaces.ts');

  // Fully empty input → defaults, never throws.
  const empty = normalizeWorkspaceSnapshot(undefined);
  assert.equal(empty.version, 1);
  assert.deepEqual(empty.activeLayers, {});
  assert.deepEqual(empty.view, DEFAULT_WORKSPACE_VIEW);
  assert.deepEqual(empty.ui, DEFAULT_WORKSPACE_UI);
  assert.equal(empty.projection, 'globe');
  assert.equal(empty.mapStyle, 'dark');
  assert.equal(empty.theme, 'core');

  // Garbage values are coerced/dropped; valid ones survive.
  const messy = normalizeWorkspaceSnapshot({
    version: 99,
    activeLayers: { earthquakes: true, fires: false, junk: 'nope', n: 3 },
    view: { latitude: 'x', longitude: -50, zoom: Number.NaN },
    projection: 'spinny',
    mapStyle: 'satellite',
    theme: 'ghost',
    ui: { showLayers: false, showIntel: true, bogus: 1 },
  });
  assert.equal(messy.version, 1);
  // Non-boolean activeLayers entries are dropped.
  assert.deepEqual(messy.activeLayers, { earthquakes: true, fires: false });
  // Bad numbers fall back to defaults; good numbers survive.
  assert.equal(messy.view.latitude, DEFAULT_WORKSPACE_VIEW.latitude);
  assert.equal(messy.view.longitude, -50);
  assert.equal(messy.view.zoom, DEFAULT_WORKSPACE_VIEW.zoom);
  // Invalid enum falls back; valid enums survive.
  assert.equal(messy.projection, 'globe');
  assert.equal(messy.mapStyle, 'satellite');
  assert.equal(messy.theme, 'ghost');
  // UI booleans merge over defaults; unknown ui keys are not copied.
  assert.equal(messy.ui.showLayers, false);
  assert.equal(messy.ui.showIntel, true);
  assert.equal(messy.ui.showScmPanel, DEFAULT_WORKSPACE_UI.showScmPanel);
  assert.equal('bogus' in messy.ui, false);

  // Round-trip: normalizing a normalized snapshot is stable.
  assert.deepEqual(normalizeWorkspaceSnapshot(messy), messy);
});

test('restore keeps known layer ids and drops unavailable active ones', async () => {
  const { restoreActiveLayers } = await tsModule('src/lib/workspaces.ts');

  const active = {
    earthquakes: true, // known builtin, ON
    maritime: false, // known builtin, OFF
    custom_demo: true, // known custom/plugin, ON
    ghost_plugin_layer: true, // unknown, ON → dropped + reported
    stale_off_layer: false, // unknown, OFF → silently ignored
  };
  const known = ['earthquakes', 'maritime', 'custom_demo', 'sdk_sea'];

  const fromArray = restoreActiveLayers(active, known);
  assert.deepEqual(fromArray.applied, { earthquakes: true, maritime: false, custom_demo: true });
  assert.deepEqual(fromArray.dropped, ['ghost_plugin_layer']);

  // Accepts a Set of known ids equivalently.
  const fromSet = restoreActiveLayers(active, new Set(known));
  assert.deepEqual(fromSet.applied, fromArray.applied);
  assert.deepEqual(fromSet.dropped, fromArray.dropped);

  // No known ids → everything ON is dropped, nothing applied.
  const none = restoreActiveLayers(active, []);
  assert.deepEqual(none.applied, {});
  assert.deepEqual(none.dropped, ['earthquakes', 'custom_demo', 'ghost_plugin_layer']);
});

test('workspace restore filters against the live registry after bootstrap', () => {
  const page = file('src/app/page.tsx');

  // applyWorkspace normalizes, then filters the snapshot's layer ids against the
  // *live* registry (getLayers()), which is only populated once bootstrapExtensions()
  // has run — so restore can never enable a layer that bootstrap hasn't registered.
  assert.match(page, /const applyWorkspace = useCallback\(/);
  assert.match(page, /normalizeWorkspaceSnapshot\(raw\)/);
  assert.match(page, /getLayers\(\)\.map\(\(l\) => l\.id\)/);
  // Known ids union builtin toggle keys (incl. virtual cables/sdk_air/sdk_naval) with
  // live registry ids, so valid builtin toggles aren't dropped as "missing extensions".
  assert.match(page, /new Set\(\[\.\.\.Object\.keys\(DEFAULT_ACTIVE_LAYERS\), \.\.\.getLayers\(\)\.map\(\(l\) => l\.id\)\]\)/);
  assert.match(page, /restoreActiveLayers\(snap\.activeLayers, knownIds\)/);
  // bootstrapExtensions runs on settings hydration, before any manual load can occur.
  assert.match(page, /bootstrapExtensions\(\)/);
});

test('workspace camera restore is gated on map readiness and honors the saved zoom', () => {
  const page = file('src/app/page.tsx');
  const map = file('src/components/HorusMap.tsx');

  // page hands the exact saved zoom to the fly-to mechanism.
  assert.match(page, /setFlyToLocation\(\{ lat: snap\.view\.latitude, lng: snap\.view\.longitude, zoom: snap\.view\.zoom, ts: Date\.now\(\) \}\)/);
  // HorusMap only flies once mapReady is true, and uses the provided zoom when present.
  assert.match(map, /if \(!mapReady \|\| !mapRef\.current \|\| !flyToLocation\) return;/);
  assert.match(map, /zoom: flyToLocation\.zoom \?\? 8/);
});
