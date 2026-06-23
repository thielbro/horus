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

test('custom source validation rejects malformed specs and normalizes valid specs', async () => {
  const { validateCustomSourceSpec } = await tsModule('src/lib/plugins/validation.ts');

  const invalid = validateCustomSourceSpec({
    id: 'Bad Id',
    label: '',
    group: 'NOPE',
    color: 'cyan',
    url: 'ftp://example.test/feed.json',
    latProp: '',
    lngProp: '',
    markerType: 'triangle',
    radius: -1,
    intervalMs: 10,
  }, { groupIds: ['THREAT'], existingIds: ['taken'] });

  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /id/i);
  assert.match(invalid.errors.join('\n'), /label/i);
  assert.match(invalid.errors.join('\n'), /group/i);
  assert.match(invalid.errors.join('\n'), /url/i);
  assert.match(invalid.errors.join('\n'), /lat/i);
  assert.match(invalid.errors.join('\n'), /lng/i);
  assert.match(invalid.errors.join('\n'), /marker/i);
  assert.match(invalid.errors.join('\n'), /radius/i);
  assert.match(invalid.errors.join('\n'), /interval/i);

  const duplicate = validateCustomSourceSpec({
    id: 'taken',
    label: 'Taken',
    group: 'THREAT',
    color: '#00E5FF',
    url: '/api/example',
    latProp: 'lat',
    lngProp: 'lng',
    markerType: 'circle',
  }, { groupIds: ['THREAT'], existingIds: ['taken'] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join('\n'), /already exists/i);

  const valid = validateCustomSourceSpec({
    id: ' custom_demo ',
    label: ' Demo Feed ',
    group: 'THREAT',
    color: '#00E5FF',
    url: '/api/example',
    jsonPath: '',
    latProp: ' lat ',
    lngProp: ' lng ',
    labelProp: '',
    markerType: 'circle',
    radius: 6,
    intervalMs: undefined,
  }, { groupIds: ['THREAT'], existingIds: ['custom_demo'], currentId: 'custom_demo' });

  assert.equal(valid.ok, true);
  assert.equal(valid.value.id, 'custom_demo');
  assert.equal(valid.value.label, 'Demo Feed');
  assert.equal(valid.value.latProp, 'lat');
  assert.equal(valid.value.lngProp, 'lng');
  assert.equal('jsonPath' in valid.value, false);
  assert.equal('labelProp' in valid.value, false);
});

test('plugin validation enforces sdk v1 and wired contribution shapes', async () => {
  const {
    validatePluginDefinition,
    validatePluginLayerDefinition,
    validatePluginFeedDefinition,
    validatePluginGroupDefinition,
  } = await tsModule('src/lib/plugins/validation.ts');

  const badPlugin = validatePluginDefinition({ id: 'Bad Id', name: '', version: '', sdk: 2, activate: null });
  assert.equal(badPlugin.ok, false);
  assert.match(badPlugin.errors.join('\n'), /id/i);
  assert.match(badPlugin.errors.join('\n'), /name/i);
  assert.match(badPlugin.errors.join('\n'), /version/i);
  assert.match(badPlugin.errors.join('\n'), /sdk/i);
  assert.match(badPlugin.errors.join('\n'), /activate/i);

  const goodPlugin = validatePluginDefinition({ id: 'demo-plugin', name: 'Demo', version: '1.0.0', sdk: 1, activate() {} });
  assert.equal(goodPlugin.ok, true);

  const badLayer = validatePluginLayerDefinition({
    id: 'bad layer',
    label: '',
    group: '',
    color: '',
    styleLayers: [{ id: '', type: 'bogus' }],
    render: [{ mapSource: '', source: { bucket: '' } }],
    interaction: { kind: 'panel' },
  });
  assert.equal(badLayer.ok, false);
  assert.match(badLayer.errors.join('\n'), /styleLayers/i);
  assert.match(badLayer.errors.join('\n'), /render/i);
  assert.match(badLayer.errors.join('\n'), /interaction/i);

  assert.equal(validatePluginFeedDefinition({ id: 'feed', fetch: { kind: 'endpoint', url: '/api/example' } }).ok, true);
  assert.equal(validatePluginGroupDefinition({ id: 'GROUP', label: 'G', fullLabel: 'Group', color: '#fff' }).ok, true);
});

test('extension bundle contract and settings UI import-export surfaces are wired', () => {
  const bundles = file('src/lib/plugins/bundles.ts');
  const pluginIndex = file('src/lib/plugins/index.ts');
  const settings = file('src/components/ExtensionsSettings.tsx');
  const loader = file('src/lib/plugins/loader.ts');
  const customSources = file('src/lib/plugins/customSources.ts');
  const context = file('src/lib/plugins/context.ts');

  assert.match(bundles, /EXTENSION_BUNDLE_VERSION\s*=\s*1/);
  assert.match(bundles, /version:\s*EXTENSION_BUNDLE_VERSION/);
  assert.match(bundles, /validateExtensionBundle/);
  assert.match(bundles, /installPlugin\(/);
  assert.match(bundles, /upsertCustomSource\(/);
  assert.match(pluginIndex, /export \{[\s\S]*exportExtensionBundle/);
  assert.match(pluginIndex, /importExtensionBundle/);

  assert.match(settings, /EXPORT BUNDLE/);
  assert.match(settings, /IMPORT BUNDLE/);
  assert.match(settings, /type="file"[^>]*accept=".json"/);
  assert.match(settings, /itemErrors/);
  assert.match(settings, /validateCustomSourceSpec/);

  assert.match(loader, /validatePluginDefinition/);
  assert.match(loader, /teardown\(rec\.id\)/);
  assert.match(loader, /enabled:\s*opts\?\.enabled/);
  assert.match(customSources, /CustomSourceRecord/);
  assert.match(customSources, /validateCustomSourceSpec/);
  assert.match(context, /validatePluginLayerDefinition/);
  assert.match(context, /validatePluginFeedDefinition/);
  assert.match(context, /validatePluginGroupDefinition/);
});
