import assert from 'node:assert/strict';
import test from 'node:test';
import { settleCameraFetchers } from './fanout.ts';

test('settleCameraFetchers preserves completed sources when another source times out', async () => {
  const results = await settleCameraFetchers([
    async () => [{ id: 'nz-1' }],
    () => new Promise(() => {}),
    async () => [{ id: 'qld-1' }],
  ], 20);

  assert.equal(results.length, 3);
  assert.equal(results[0].status, 'fulfilled');
  assert.deepEqual(results[0].value, [{ id: 'nz-1' }]);
  assert.equal(results[1].status, 'rejected');
  assert.match(String(results[1].reason?.message || results[1].reason), /timed out/);
  assert.equal(results[2].status, 'fulfilled');
  assert.deepEqual(results[2].value, [{ id: 'qld-1' }]);
});

test('settleCameraFetchers converts source throws into rejected settled results', async () => {
  const results = await settleCameraFetchers([
    async () => { throw new Error('upstream failed'); },
  ], 100);

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'rejected');
  assert.match(String(results[0].reason?.message || results[0].reason), /upstream failed/);
});
