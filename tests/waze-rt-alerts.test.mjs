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

test('clientInfo line round-trips through the vendored proto (camelCase guard)', async () => {
  const { buildProtoLine, loadRtRoot } = await mod();
  const root = await loadRtRoot();
  const Batch = root.lookupType('Batch');
  // protobufjs message properties are camelCase — snake_case keys silently encode
  // EMPTY messages and Waze answers "500 Bad proto element". This test guards that.
  const line = buildProtoLine({ clientInfo: { protocol: 234, clientVersion: '5.17.1.0' } });
  assert.ok(line.startsWith('ProtoBase64,'));
  const bytes = Buffer.from(line.slice('ProtoBase64,'.length), 'base64');
  const back = Batch.decode(bytes);
  assert.equal(back.element[0].clientInfo.protocol, 234);
});

test('parseRtAlerts re-signs unsigned longitudes and names enums', async () => {
  const { parseRtAlerts, loadRtRoot } = await mod();
  const root = await loadRtRoot();
  const Batch = root.lookupType('Batch');
  // -118.24 deg micro-degrees as the server sends them: two's-complement unsigned.
  const raw = { element: [{ addAlertAction: { realtimeAlert: {
    alertUuid: 'u1', id: '7',
    alertInfo: { position: { lonTimes1000000: (-118.24e6 >>> 0), latTimes1000000: 34.05e6 }, type: 2, subType: 201, azymuth: 90 },
    alertReportingInfo: { reportTime: 1_762_000_000, thumbsUpCount: 3, alertAddress: { street: 'W 14th St', city: 'Los Angeles' } },
  } } }] };
  const batch = Batch.fromObject(raw);
  const alerts = parseRtAlerts(batch);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].lon, -118.24);
  assert.equal(alerts[0].type, 'POLICE'); // AlertType value 2
  assert.equal(alerts[0].subtype, 'POLICE_VISIBLE'); // waze.proto: AlertSubType 201 = POLICE_VISIBLE (plan guessed wrong)
  assert.equal(alerts[0].uuid, 'u1');
  assert.equal(alerts[0].pubMillis, 1_762_000_000_000);
  assert.equal(alerts[0].street, 'W 14th St');
});

test('classifyRtBatchError maps server errors to session/transient/rejected', async () => {
  const { classifyRtBatchError } = await mod();
  assert.equal(classifyRtBatchError({ element: [{ error: { code: 504, description: 'Retry' } }] }), 'transient');
  assert.equal(classifyRtBatchError({ element: [{ error: { code: 500, description: 'Please relogin' } }] }), 'session');
  assert.equal(classifyRtBatchError({ element: [{ error: { code: 400, description: 'Bad proto element' } }] }), 'rejected');
  assert.equal(classifyRtBatchError({ element: [{ addAlertAction: {} }] }), null);
});

test('rt credentials cache round-trips and tolerates corruption', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { loadRtCredentials, saveRtCredentials } = await mod();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'horus-rt-'));
  const file = path.join(dir, 'nested', 'creds.json');
  assert.equal(await loadRtCredentials(file), null);                     // missing file
  await saveRtCredentials(file, { installationId: 'i1', community: 'world_abc', secret: 'xyz' });
  assert.deepEqual(await loadRtCredentials(file), { installationId: 'i1', community: 'world_abc', secret: 'xyz' });
  await fsp.writeFile(file, 'not json');
  assert.equal(await loadRtCredentials(file), null);                     // corrupt -> re-register
  const mode = (await fsp.stat(file)).mode & 0o777;
  // Windows (libuv) reports 0o666 regardless of chmod 0o600 — guard the assert.
  if (process.platform !== 'win32') assert.equal(mode & 0o077, 0);         // owner-only
});

