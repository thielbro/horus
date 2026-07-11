import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const file = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('entity tracking persists watches and alerts on first detection only', () => {
  const tracker = file('src/components/EntityTracker.tsx');
  assert.match(tracker, /horus\.entity-watchlist\.v1/);
  assert.match(tracker, /previouslySeen\.current\.has\(watch\.id\)/);
  assert.match(tracker, /new Notification\(`/);
  assert.match(tracker, /TrackingToasts/);
});

test('aircraft and vessel matching supports operational identifiers', () => {
  const matching = file('src/lib/entity-tracking.ts');
  assert.match(matching, /'icao24', 'registration', 'callsign'/);
  assert.match(matching, /'mmsi', 'imo', 'callsign', 'name'/);
  assert.match(matching, /normalizeTrackingIdentifier/);
});

test('tracked entities keep their corresponding live layers active', () => {
  const page = file('src/app/page.tsx');
  assert.match(page, /wantsAircraft[\s\S]*flights: wantsAircraft \? true/);
  assert.match(page, /wantsVessel[\s\S]*maritime_ships: wantsVessel \? true/);
  assert.match(page, /<LiveAlerts[^>]*tracker=\{entityTracker\}/);
});
