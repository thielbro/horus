import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('../src/lib/traffic-alerts/waze-rt.ts');

test('mapDisplayed command replicates the client wire quirk', async () => {
  const { mapDisplayedCommand } = await mod();
  // Corner list is (west,north) (east,north) (east,south) (west,south), then centre,
  // then the constant 67186, then the corner list AGAIN — verbatim from the official
  // client (WazeRtCodec.java:108). Any "tidier" box kills the query.
  assert.equal(
    mapDisplayedCommand(174.746461, -36.862066, 174.780139, -36.834934),
    'MapDisplayed,174.746461,-36.834934,174.780139,-36.834934,174.780139,-36.862066,174.746461,-36.862066,174.763300,-36.848500,67186,174.746461,-36.834934,174.780139,-36.834934,174.780139,-36.862066,174.746461,-36.862066',
  );
});

test('shrinkBox scales about the centre', async () => {
  const { shrinkBox } = await mod();
  assert.deepEqual(shrinkBox([0, 0, 10, 10], 0.5), [2.5, 2.5, 7.5, 7.5]);
});

test('rtRegion routes tiles to the right RT host', async () => {
  const { rtRegionForBbox } = await mod();
  assert.equal(rtRegionForBbox([33.8, -118.55, 34.2, -118.05]), 'na'); // LA
  assert.equal(rtRegionForBbox([31.9, 34.7, 32.2, 35.0]), 'il');       // Tel Aviv
  assert.equal(rtRegionForBbox([-36.9, 174.7, -36.8, 174.85]), 'row'); // Auckland
});
