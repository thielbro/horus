import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

const root = process.cwd();
const sourcePath = join(root, 'src/app/api/cctv/surveillance-map-foundation.ts');
const routePath = join(root, 'src/app/api/cctv/route.ts');

const liveVideoIds = [
  'UHlDzWrBEPI',
  'TdGXlEOxuOw',
  'otu_D2_TiLM',
  'JcHYcrO4PRE',
  'Ql7graq0I9M',
  'KuzVYn1Ucbg',
  'EHaOI3U5M_s',
  'eAm6iAB1pQQ',
  '6Xxb5uikewE',
  'SfuCqR7RLHA',
  't_bAWRtkvlQ',
  'mkX71WMAmNI',
];

function sourceText() {
  assert.equal(existsSync(sourcePath), true, 'SurveillanceMap Foundation CCTV source module should exist');
  return readFileSync(sourcePath, 'utf8');
}

function blockFor(source, id) {
  const marker = `id: '${id}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing camera ${id}`);
  const next = source.indexOf('\n  {', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function coordsFor(source, id) {
  const block = blockFor(source, id);
  const coords = block.match(/lat:\s*(-?\d+(?:\.\d+)?),\s*lng:\s*(-?\d+(?:\.\d+)?)/);
  assert.ok(coords, `${id} should include lat/lng`);
  return { lat: Number(coords[1]), lng: Number(coords[2]) };
}

function assertInside(point, bounds, label) {
  assert.ok(point.lat >= bounds.minLat && point.lat <= bounds.maxLat, `${label} latitude ${point.lat} outside expected bounds`);
  assert.ok(point.lng >= bounds.minLng && point.lng <= bounds.maxLng, `${label} longitude ${point.lng} outside expected bounds`);
}

test('SurveillanceMap Foundation source contains only current live stream embeds', () => {
  const source = sourceText();

  for (const videoId of liveVideoIds) {
    assert.match(source, new RegExp(`https://www\\.youtube\\.com/embed/${videoId}\\?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0`));
  }

  assert.doesNotMatch(source, /NB0dqwwUnDw|3uiw01I06DI|-9yHi0U9glk|e5B-W6CNmcI/, 'archive/event streams should not be added as live cameras');
  assert.match(source, /source:\s*'SurveillanceMap Foundation'/);
  assert.match(source, /stream_type:\s*'iframe'/);
});

test('SurveillanceMap Foundation camera markers are pinned to the named place or credited host', () => {
  const source = sourceText();

  assertInside(coordsFor(source, 'smf-fr-paris-eiffel-dauphine'), { minLat: 48.86, maxLat: 48.88, minLng: 2.26, maxLng: 2.29 }, 'Paris Dauphine Eiffel view');
  assertInside(coordsFor(source, 'smf-us-ca-lax'), { minLat: 33.93, maxLat: 33.95, minLng: -118.43, maxLng: -118.39 }, 'LAX');
  assertInside(coordsFor(source, 'smf-fo-vagur-sw'), { minLat: 61.46, maxLat: 61.49, minLng: -6.83, maxLng: -6.79 }, 'Vagur southwest');
  assertInside(coordsFor(source, 'smf-ch-zermatt-matterhorn'), { minLat: 46.01, maxLat: 46.03, minLng: 7.73, maxLng: 7.77 }, 'Zermatt');
  assertInside(coordsFor(source, 'smf-nz-auckland-sky-tower'), { minLat: -36.86, maxLat: -36.84, minLng: 174.75, maxLng: 174.78 }, 'Auckland Sky Tower');
  assertInside(coordsFor(source, 'smf-us-ny-empire-state-lower-manhattan'), { minLat: 40.74, maxLat: 40.76, minLng: -73.99, maxLng: -73.97 }, 'Empire State Building');
  assertInside(coordsFor(source, 'smf-is-djupivogur-harbour'), { minLat: 64.64, maxLat: 64.67, minLng: -14.30, maxLng: -14.26 }, 'Djupivogur Harbour');
  assertInside(coordsFor(source, 'smf-au-sydney-cafe-sydney'), { minLat: -33.87, maxLat: -33.85, minLng: 151.20, maxLng: 151.22 }, 'Cafe Sydney');
  assertInside(coordsFor(source, 'smf-gb-plymouth-smeatons-tower'), { minLat: 50.35, maxLat: 50.38, minLng: -4.15, maxLng: -4.13 }, "Smeaton's Tower");
  assertInside(coordsFor(source, 'smf-it-anacapri-caesar-augustus'), { minLat: 40.55, maxLat: 40.57, minLng: 14.21, maxLng: 14.24 }, 'Hotel Caesar Augustus');
  assertInside(coordsFor(source, 'smf-us-ny-times-square'), { minLat: 40.75, maxLat: 40.77, minLng: -73.99, maxLng: -73.97 }, 'Times Square');
});

test('CCTV route includes SurveillanceMap Foundation streams in matching viewport regions', () => {
  const route = readFileSync(routePath, 'utf8');

  assert.match(route, /fetchSurveillanceMapFoundationCameras/);
  assert.match(route, /fetchSurveillanceMapFoundationCameras\('us-west'\)/);
  assert.match(route, /fetchSurveillanceMapFoundationCameras\('us-east'\)/);
  assert.match(route, /fetchSurveillanceMapFoundationCameras\('uk'\)/);
  assert.match(route, /fetchSurveillanceMapFoundationCameras\('europe'\)/);
  assert.match(route, /const inIceland =/);
  assert.match(route, /const inSwitzerland =/);
  assert.match(route, /if \(inIceland\) regions\.push\('europe'\)/);
  assert.match(route, /if \(inSwitzerland\) regions\.push\('switzerland'\)/);
});
