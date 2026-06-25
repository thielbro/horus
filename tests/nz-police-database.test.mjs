import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';

const root = process.cwd();
const csvPath = join(root, 'src/lib/police/data/nz_police_stations.csv');
const dataPath = join(root, 'src/lib/police/newzealand.ts');
const curatedPath = join(root, 'src/lib/police/curated.ts');
const routePath = join(root, 'src/app/api/police/route.ts');
const overpassPath = join(root, 'src/lib/overpass.ts');
const addressProviderPath = join(root, 'src/lib/intel/providers/address.ts');
const routeProviderPath = join(root, 'src/lib/intel/providers/route.ts');

function csvStationCount() {
  const lines = readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length - 1; // minus header
}

/** Parse `{ ... lat: X, lng: Y ... }` rows out of the generated dataset. */
function parseStations(src) {
  const out = [];
  const re = /lat:\s*(-?\d+(?:\.\d+)?),\s*lng:\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ lat: Number(m[1]), lng: Number(m[2]) });
  return out;
}

/** Parse the NZ_COVERAGE boxes ([s, w, n, e]). */
function parseCoverage(src) {
  const block = src.match(/NZ_COVERAGE:\s*BBox\[\]\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'NZ_COVERAGE should be declared');
  const boxes = [];
  const re = /\[\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  let m;
  while ((m = re.exec(block[1])) !== null) boxes.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  return boxes;
}

const pointInBox = (lat, lng, [s, w, n, e]) => lat >= s && lat <= n && lng >= w && lng <= e;
const boxesIntersect = ([as_, aw, an, ae], [bs, bw, bn, be]) => as_ <= bn && bs <= an && aw <= be && bw <= ae;

test('generated NZ dataset has every CSV station and the expected shape', () => {
  assert.equal(existsSync(dataPath), true, 'newzealand.ts should be generated');
  const src = readFileSync(dataPath, 'utf8');
  const stations = parseStations(src);
  assert.equal(stations.length, csvStationCount(), 'station count must match the source CSV');
  assert.match(src, /source: 'NZ Police'/);
  assert.match(src, /operator: 'New Zealand Police'/);
  // Macron display names are preserved; ASCII slug ids.
  assert.match(src, /name: "Māngere Police Station"/);
  assert.match(src, /id: "nz-police-mangere-police-station"/);
  // Quoted comma-name parsed as one field.
  assert.match(src, /name: "Harbour Bridge Centre, Auckland"/);
});

test('Chatham Islands station survives the antimeridian (negative longitude)', () => {
  const src = readFileSync(dataPath, 'utf8');
  assert.match(src, /name: "Chatham Islands Police Station", operator: 'New Zealand Police', source: 'NZ Police'/);
  const chatham = parseStations(src).find((s) => s.lng < 0);
  assert.ok(chatham, 'a station with negative longitude (Chathams) should exist');
  assert.ok(chatham.lat < -43 && chatham.lat > -44.5, 'Chatham latitude in range');
});

test('every curated station lies inside NZ_COVERAGE', () => {
  const src = readFileSync(dataPath, 'utf8');
  const coverage = parseCoverage(src);
  assert.equal(coverage.length, 2, 'mainland + Chathams boxes');
  for (const st of parseStations(src)) {
    assert.ok(coverage.some((b) => pointInBox(st.lat, st.lng, b)), `station ${st.lat},${st.lng} must be inside coverage`);
  }
});

test('coverage drives injection: Oceania intersects, Europe does not', () => {
  const coverage = parseCoverage(readFileSync(dataPath, 'utf8'));
  const oceania = [-48, 112, -10, 180];
  const europe = [35, -11, 72, 40];
  assert.ok(coverage.some((b) => boxesIntersect(b, oceania)), 'default Oceania box must trigger NZ injection');
  assert.ok(!coverage.some((b) => boxesIntersect(b, europe)), 'Europe box must not pull in NZ data');
});

test('police route serves curated data and drops OSM inside coverage', () => {
  const route = readFileSync(routePath, 'utf8');
  assert.match(route, /curatedPoliceWithin/);
  assert.match(route, /isWithinCuratedCoverage\(lat, lng\)\)\s*return null/);
  assert.match(route, /extraRecords:\s*\(boxes\)\s*=>\s*curatedPoliceWithin\(boxes\)/);
});

test('curated registry and overpass injection are wired', () => {
  const curated = readFileSync(curatedPath, 'utf8');
  assert.match(curated, /NZ_POLICE/);
  assert.match(curated, /export function curatedPoliceInBoxes/);
  const overpass = readFileSync(overpassPath, 'utf8');
  assert.match(overpass, /extraRecords/);
  // Curated rows must still ship if Overpass fails.
  assert.match(overpass, /\[bucket\]:\s*extra/);
});

test('intel providers use the curated DB and drop OSM police in coverage', () => {
  for (const p of [addressProviderPath, routeProviderPath]) {
    const src = readFileSync(p, 'utf8');
    assert.match(src, /curatedPoliceInBoxes/, `${p} should inject curated police`);
    assert.match(src, /isWithinCuratedCoverage/, `${p} should drop OSM police in coverage`);
    assert.match(src, /source: 'Curated \+ OSM'/, `${p} police fact should credit curated data`);
  }
});
