import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('delta review: route and live-position overlays batch GeoJSON updates', () => {
  const map = file('src/components/OsirisMap.tsx');
  const userEffect = between(map, '// Live user position', '// Route-exposure overlay');
  const routeEffect = between(map, '// Route-exposure overlay', '// Fly-to.');

  assert.match(map, /const setGeoBatch = useCallback/);

  assert.match(userEffect, /setGeoBatch\(\{\s*'user-position': \[\],\s*'user-accuracy': \[\]/);
  assert.match(userEffect, /setGeoBatch\(\{\s*'user-position': \[/);
  assert.doesNotMatch(userEffect, /setGeo\('user-position'/);
  assert.doesNotMatch(userEffect, /setGeo\('user-accuracy'/);

  assert.match(routeEffect, /setGeoBatch\(\{\s*'route-line': \[\],\s*'route-corridor': \[\],\s*'route-surveil': \[\]/);
  assert.match(routeEffect, /setGeoBatch\(\{\s*'route-line': \[/);
  assert.doesNotMatch(routeEffect, /setGeo\('route-line'/);
  assert.doesNotMatch(routeEffect, /setGeo\('route-corridor'/);
  assert.doesNotMatch(routeEffect, /setGeo\('route-surveil'/);
});

test('delta review: live reverse geocoding has a strict Nominatim throttle and cleanup', () => {
  const tracker = file('src/components/LocationTracker.tsx');
  const reverseBlock = between(tracker, 'const reverseGeocode', 'const stop');

  assert.match(tracker, /const NOMINATIM_MIN_INTERVAL_MS = 1_100;/);
  assert.match(reverseBlock, /now - last\.at < NOMINATIM_MIN_INTERVAL_MS/);
  assert.match(reverseBlock, /finally\s*\{[\s\S]*if \(geocodeAbort\.current === controller\) geocodeAbort\.current = null;[\s\S]*\}/);
});

test('delta review: ALPR route and address classification is case-insensitive', () => {
  for (const path of [
    'src/lib/intel/providers/route.ts',
    'src/lib/intel/providers/address.ts',
  ]) {
    const source = file(path);
    const classifySupport = between(source, 'interface OverpassNode', 'const KIND_LABEL');
    assert.match(classifySupport, /function isAlprTag\(value\?: string\): boolean/);
    assert.match(classifySupport, /value\.toLowerCase\(\) === 'alpr'/);
    assert.match(classifySupport, /isAlprTag\(tags\['surveillance:type'\]\) \|\| isAlprTag\(tags\['camera:type'\]\)/);
  }
});

test('delta review: curated police bbox helpers are antimeridian-aware', () => {
  const curated = file('src/lib/police/curated.ts');

  assert.match(curated, /function lngInBox\(lng: number, w: number, e: number\): boolean/);
  assert.match(curated, /w <= e \? lng >= w && lng <= e : lng >= w \|\| lng <= e/);
  assert.match(curated, /function splitAntimeridianBox\(box: BBox\): BBox\[\]/);
  assert.match(curated, /splitAntimeridianBox\(a\)[\s\S]*splitAntimeridianBox\(b\)[\s\S]*aw <= be && bw <= ae/);
});

test('delta review: route buffer documents antimeridian rendering limits', () => {
  const geo = file('src/lib/geo.ts');
  const bufferDoc = between(
    geo,
    '* Closed ring of [lng,lat] approximating a `halfWidthM` buffer',
    'export function bufferPolygon',
  );

  assert.match(bufferDoc, /antimeridian/i);
  assert.match(bufferDoc, /continuous local route/i);
});

test('delta review: CCTV cache policy follows query type, not result count', () => {
  const cctv = file('src/app/api/cctv/route.ts');

  assert.match(cctv, /const hasCoordinateQuery = searchParams\.has\('lat'\) \|\| searchParams\.has\('lng'\);/);
  assert.match(cctv, /else if \(hasCoordinateQuery\) \{/);
  assert.match(cctv, /const cacheControl = hasCoordinateQuery\s*\?\s*'no-store, max-age=0'\s*:\s*'public, s-maxage=300, stale-while-revalidate=600';/);
  assert.doesNotMatch(cctv, /allCameras\.length\s*<\s*50/);
});
