import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const file = (path) => readFileSync(join(root, path), 'utf8');

test('gdelt feed polls on an interval instead of loading once', () => {
  const feeds = file('src/lib/registry/feeds.ts');
  assert.match(feeds, /id:\s*'gdelt'[^\n]*intervalMs:\s*900_000/);
});

test('gdelt route polls the raw events export with typed CAMEO categories', () => {
  const route = file('src/app/api/gdelt/route.ts');

  // The GEO 2.0 API is dead — the route must use the 15-minute raw export instead.
  assert.match(route, /lastupdate\.txt/);
  assert.match(route, /export\.CSV\.zip/);
  assert.match(route, /inflateRawSync/);
  assert.doesNotMatch(route, /geo\/geo\?query=/);
  // CAMEO root codes map to typed incidents beyond bare conflict.
  assert.match(route, /'unrest'/);
  assert.match(route, /'political'/);
  assert.match(route, /'diplomacy'/);
  // Events stay a superset of the old shape (conflict-zones effect depends on it).
  assert.match(route, /seenAt/);
});

test('global incidents layer styles by type and exposes article metadata', () => {
  const builtins = file('src/lib/registry/builtins.ts');

  assert.match(builtins, /'match',\s*\['get','type'\]/);
  assert.match(builtins, /id:\s*'gdelt-glow'/);
  // Popup needs url/type/count — the old layer dropped everything but name.
  assert.match(builtins, /properties:\s*\{\s*name:\s*e\.name,\s*url:\s*e\.url,\s*type:\s*e\.type,\s*count:\s*e\.count/);
});

test('map popup links to the article and defaults the layer on as ambient intel', () => {
  const map = file('src/components/HorusMap.tsx');
  const page = file('src/app/page.tsx');

  assert.match(map, /GDELT_TYPE_COLORS/);
  assert.match(map, /OPEN ARTICLE/);
  assert.match(map, /setVis\(\['gdelt-dots',\s*'gdelt-glow'\],\s*activeLayers\.global_incidents\)/);
  assert.match(page, /global_incidents:\s*true/);
});
