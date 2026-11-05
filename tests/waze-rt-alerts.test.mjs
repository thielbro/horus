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

test('clientInfo line round-trips through the vendored proto (camelCase keys encode for real)', async () => {
  const { buildProtoLine, loadRtRoot } = await mod();
  const root = await loadRtRoot();
  const Batch = root.lookupType('Batch');
  // The landmine this guards: snake_case keys (client_version, last_position)
  // silently encode EMPTY sub-messages on protobufjs 7.6.6, and Waze answers
  // "500 Bad proto element". Note 7.6.6's create() also accepts camelCase, so
  // this pins camelCase-correctness, not fromObject-vs-create.
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
  // LoginError ladder (Task 5's stale-creds path keys off these):
  assert.equal(classifyRtBatchError({ element: [{ loginError: { errorType: 2 } }] }), 'transient');
  assert.equal(classifyRtBatchError({ element: [{ loginError: { errorType: 1 } }] }), 'rejected');
  assert.equal(classifyRtBatchError({ element: [{ loginError: { errorType: 0 } }] }), 'transient');
  assert.equal(classifyRtBatchError({ element: [{ loginResponse: { loginError: { errorType: 1 } } }] }), 'rejected');
  // A non-fatal error element must not mask a co-located loginError (spike fallthrough).
  assert.equal(classifyRtBatchError({ element: [{ error: { code: 200, description: 'ok' }, loginError: { errorType: 1 } }] }), 'rejected');
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

// ── createRtTransport integration: fake fetch answering by URL path, real
// vendored proto building the wire bodies (framing + parsing exercised for real).

function makeRtFakeFetch(Batch) {
  const calls = [];
  // The RT server answers with raw protobuf bytes — encode the fixture objects
  // straight to the wire (the plan draft's base64 string round-trip double-encoded).
  const wire = (obj) => Buffer.from(Batch.encode(Batch.fromObject(obj)).finish());
  const fakeFetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/static')) {
      return { status: 200, headers: new Headers(), arrayBuffer: async () => wire({ element: [{ registerSuccessful: { username: 'world_fake', password: 'pw_fake', userId: '1' } }] }) };
    }
    if (u.endsWith('/login')) {
      return { status: 200, headers: new Headers({ 'set-cookie': 'Waze-Session-Affinity=abc;' }), arrayBuffer: async () => wire({ element: [{ loginResponse: { loginSuccess: { serverSessionId: '123', secretKey: 'aAbB' } } }] }) };
    }
    // /command: one POLICE alert, every command answers with the same one — the
    // client merges by uuid so the sweep must still collapse to a single alert.
    return { status: 200, headers: new Headers(), arrayBuffer: async () => wire({ element: [{ addAlertAction: { realtimeAlert: {
      alertUuid: 'p1', id: '11',
      alertInfo: { position: { lonTimes1000000: (174.76e6 | 0), latTimes1000000: (-36.84e6 | 0) }, type: 2, azymuth: 0 },
      alertReportingInfo: { reportTime: Math.floor(Date.now() / 1000), alertAddress: { street: 'Queens St', city: 'Auckland' } },
    } } }] }) };
  };
  return { calls, fakeFetch };
}

test('rt transport returns GeoRSS-shaped alerts the existing pipeline normalizes', async () => {
  const { createRtTransport, loadRtRoot } = await mod();
  const { scrapeWazePoliceCameraAlerts } = await import('../src/lib/traffic-alerts/index.ts');
  const os = await import('node:os'); const fsp = await import('node:fs/promises'); const path = await import('node:path');
  const root = await loadRtRoot();
  const Batch = root.lookupType('Batch');
  const credsFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'horus-rt-')), 'creds.json');
  const { calls, fakeFetch } = makeRtFakeFetch(Batch);

  const result = await scrapeWazePoliceCameraAlerts({
    bbox: [-36.90, 174.70, -36.80, 174.85],           // one tile (span < 1 deg)
    transport: createRtTransport({ fetchImpl: fakeFetch, credsPath: credsFile }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.alerts.length, 1);
  const a = result.alerts[0];
  assert.equal(a.kind, 'police');
  assert.equal(a.provider, 'waze');
  assert.equal(a.id, 'p1');
  assert.equal(a.type, 'POLICE');
  assert.ok(Math.abs(a.lat - -36.84) < 1e-6 && Math.abs(a.lng - 174.76) < 1e-6);
  assert.ok(a.reportTime && Date.parse(a.reportTime) > 0);
  assert.equal(a.description, 'Queens St');
  // credentials were persisted so future scrapes skip /static (register is capped):
  assert.equal(JSON.parse(await fsp.readFile(credsFile, 'utf8')).community, 'world_fake');
  assert.equal(calls.filter((u) => u.endsWith('/static')).length, 1);
});

test('rt transport registers and logs in once across the tiles of one scrape', async () => {
  const { createRtTransport, loadRtRoot } = await mod();
  const { scrapeWazePoliceCameraAlerts } = await import('../src/lib/traffic-alerts/index.ts');
  const os = await import('node:os'); const fsp = await import('node:fs/promises'); const path = await import('node:path');
  const root = await loadRtRoot();
  const Batch = root.lookupType('Batch');
  const credsFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'horus-rt-')), 'creds.json');
  const { calls, fakeFetch } = makeRtFakeFetch(Batch);

  const result = await scrapeWazePoliceCameraAlerts({
    bbox: [33.80, -118.55, 34.20, -118.05],           // LA, region na
    maxTileSpanDegrees: 0.25,                         // 0.4 x 0.5 deg -> exactly 4 tiles
    transport: createRtTransport({ fetchImpl: fakeFetch, credsPath: credsFile }),
  });
  assert.deepEqual(result.errors, []);
  // One RT session per scrape: register is capped (~10/day), logins are shared even
  // though tiles run 2-at-a-time and four sweeps hit /command.
  assert.equal(calls.filter((u) => u.endsWith('/static')).length, 1);
  assert.equal(calls.filter((u) => u.endsWith('/login')).length, 1);
  assert.ok(calls.filter((u) => u.endsWith('/command')).length === 4 * 6);
});

test('auto transport prefers rt and falls back to the georss chain when rt fails', async () => {
  const { createRtFallbackChain } = await mod();
  const rtOk = { fetchGeoRss: async () => ({ alerts: [] }) };
  // 1) rt works -> fallback never called
  let fellBack = 0;
  const fb = { fetchGeoRss: async () => { fellBack++; return { alerts: [] }; } };
  await createRtFallbackChain(rtOk, fb).fetchGeoRss('u', { bbox: [0, 0, 1, 1], env: 'row' });
  assert.equal(fellBack, 0);
  // 2) rt fails with a transport error -> fallback answers
  const { WazeTransportError } = await import('../src/lib/traffic-alerts/errors.ts');
  const rtBad = { fetchGeoRss: async () => { throw new WazeTransportError('rt boom', 504, 'rt'); } };
  await createRtFallbackChain(rtBad, fb).fetchGeoRss('u', { bbox: [0, 0, 1, 1], env: 'row' });
  assert.equal(fellBack, 1);
});

