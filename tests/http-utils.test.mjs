import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampFiniteInt,
  cloneJson,
  parseCsvRows,
  parseKpIndex,
  stableHash,
} from '../src/lib/http-utils.ts';

test('parseCsvRows handles quoted commas and escaped quotes', () => {
  const rows = parseCsvRows('name,city,note\n"Acme, Ltd","Los Angeles, CA","a ""quoted"" value"\n');

  assert.deepEqual(rows, [
    ['name', 'city', 'note'],
    ['Acme, Ltd', 'Los Angeles, CA', 'a "quoted" value'],
  ]);
});

test('parseKpIndex supports numeric and NOAA G-scale values', () => {
  assert.equal(parseKpIndex('6.33'), 6.33);
  assert.equal(parseKpIndex('G1'), 4);
  assert.equal(parseKpIndex('G4'), 7);
  assert.equal(parseKpIndex('G5'), 8);
  assert.equal(parseKpIndex('not-a-number'), 0);
});

test('clampFiniteInt defaults malformed values before clamping', () => {
  assert.equal(clampFiniteInt('abc', 25, 1, 100), 25);
  assert.equal(clampFiniteInt('200', 25, 1, 100), 100);
  assert.equal(clampFiniteInt('-3', 25, 1, 100), 1);
});

test('stableHash is deterministic for equivalent structured input', () => {
  const first = stableHash({ name: 'Event', lat: 1.234, lng: 5.678 });
  const second = stableHash({ name: 'Event', lat: 1.234, lng: 5.678 });
  const different = stableHash({ name: 'Event', lat: 1.235, lng: 5.678 });

  assert.equal(first, second);
  assert.notEqual(first, different);
});

test('cloneJson returns a detached copy', () => {
  const original = { nested: { value: 1 } };
  const cloned = cloneJson(original);

  cloned.nested.value = 2;
  assert.equal(original.nested.value, 1);
});
