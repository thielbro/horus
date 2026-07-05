const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { createService } = require('./server');

class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now() {
    return this.nowMs;
  }

  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { id, type: 'timeout', at: this.nowMs + Math.max(0, delay), fn });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  setInterval(fn, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { id, type: 'interval', at: this.nowMs + Math.max(1, delay), delay: Math.max(1, delay), fn });
    return id;
  }

  clearInterval(id) {
    this.tasks.delete(id);
  }

  async tick(ms) {
    const target = this.nowMs + ms;
    while (true) {
      let next = null;
      for (const task of this.tasks.values()) {
        if (task.at <= target && (!next || task.at < next.at || task.id < next.id)) next = task;
      }
      if (!next) break;
      this.nowMs = next.at;
      if (next.type === 'timeout') this.tasks.delete(next.id);
      next.fn();
      if (next.type === 'interval' && this.tasks.has(next.id)) {
        next.at = this.nowMs + next.delay;
      }
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
  }
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  removeAllListeners(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  message(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) handler(payload);
  }
}

async function withService(t, options = {}) {
  FakeWebSocket.instances = [];
  const dir = await mkdtemp(join(tmpdir(), 'horus-live-feed-'));
  const timers = options.timers || new FakeTimers();
  const env = { AIS_API_KEY: 'test-key', ...(options.env || {}) };
  const service = createService({
    env,
    now: () => timers.now(),
    timers,
    WebSocket: FakeWebSocket,
    reconnectMs: 5_000,
    errorReconnectMs: 60_000,
    leaseTtlMs: 150_000,
  });
  const server = await new Promise((resolve) => {
    const s = service.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    service.close();
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, init = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        connection: 'close',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    const body = await res.json();
    return { res, body };
  };
  return { ...service, baseUrl, json, timers, env };
}

function position(mmsi, lat, lng, name = `SHIP ${mmsi}`) {
  return {
    MessageType: 'PositionReport',
    MetaData: { MMSI: mmsi, ShipName: name },
    Message: { PositionReport: { Latitude: lat, Longitude: lng, Sog: 12.3, TrueHeading: 90, Cog: 91 } },
  };
}

function extendedClassBPosition(mmsi, lat, lng, name = `CLASS B ${mmsi}`) {
  return {
    MessageType: 'ExtendedClassBPositionReport',
    MetaData: { MMSI: mmsi, ShipName: name },
    Message: { ExtendedClassBPositionReport: { UserID: mmsi, Latitude: lat, Longitude: lng, Sog: 4.5, TrueHeading: 180, Cog: 181, Name: name, Type: 70 } },
  };
}

function metadataStaticPosition(mmsi, lat, lng, name = `STATIC ${mmsi}`) {
  return {
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lng },
    Message: { ShipStaticData: { Name: name, Destination: 'PORT', Type: 80 } },
  };
}

test('missing AIS key never opens the AIS stream and returns static maritime context', async (t) => {
  const svc = await withService(t, { env: { AIS_API_KEY: '' } });

  const active = await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 1, west: 2, north: 3, east: 4 } }),
  });
  assert.equal(active.res.status, 200);
  assert.equal(active.body.active.maritime, true);
  assert.equal(FakeWebSocket.instances.length, 0);

  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.res.status, 200);
  assert.equal(snapshot.body.status, 'missing_key');
  assert.equal(snapshot.body.ships.length, 0);
  assert.ok(snapshot.body.ports.length > 10);
  assert.ok(snapshot.body.chokepoints.length > 5);
});

test('active maritime leases stream AIS continuously and expire cleanly without heartbeats', async (t) => {
  const svc = await withService(t);

  const active = await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 1, west: 2, north: 3, east: 4 } }),
  });
  assert.equal(active.res.status, 200);
  assert.equal(FakeWebSocket.instances.length, 1);

  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  assert.equal(firstSocket.sent[0].APIKey, 'test-key');
  assert.deepEqual(firstSocket.sent[0].BoundingBoxes[0], [[1, 2], [3, 4]]);
  assert.ok(firstSocket.sent[0].BoundingBoxes.length > 1);
  assert.deepEqual(firstSocket.sent[0].FilterMessageTypes, [
    'PositionReport',
    'StandardClassBPositionReport',
    'ExtendedClassBPositionReport',
    'ShipStaticData',
    'StaticDataReport',
  ]);

  firstSocket.message(position(123456789, 1.5, 2.5, 'LEASED VESSEL'));
  let snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.status, 'streaming');
  assert.equal(snapshot.body.streaming, true);
  assert.equal(snapshot.body.ships.length, 1);
  assert.equal(snapshot.body.ships[0].name, 'LEASED VESSEL');

  // Socket stays open well past the old 45s sample window while the lease is live.
  await svc.timers.tick(45_000);
  assert.equal(firstSocket.closed, false);

  // No heartbeat renewals: lease expires at 150s and the stream shuts down.
  await svc.timers.tick(105_001);
  assert.equal(svc.getState().active.maritime, false);
  assert.equal(firstSocket.closed, true);

  await svc.timers.tick(450_000);
  assert.equal(FakeWebSocket.instances.length, 1);

  snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.ships.length, 1);
  assert.equal(snapshot.body.streaming, false);
});

test('heartbeats renew the lease and viewport changes resubscribe on the open socket', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 1, west: 2, north: 3, east: 4 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.equal(socket.sent.length, 1);

  // Heartbeat with the same viewport renews the lease without resubscribing.
  await svc.timers.tick(60_000);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 1, west: 2, north: 3, east: 4 } }),
  });
  assert.equal(socket.sent.length, 1);

  // Panning to a new viewport re-targets the live subscription in place.
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 40, west: -10, north: 55, east: 15 } }),
  });
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1].BoundingBoxes[0], [[40, -10], [55, 15]]);
  assert.equal(socket.closed, false);

  // Lease stays alive past the original 150s thanks to the renewals.
  await svc.timers.tick(120_000);
  assert.equal(svc.getState().active.maritime, true);
  assert.equal(socket.closed, false);
});

test('unexpected socket close reconnects while the lease is active', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 1, west: 2, north: 3, east: 4 } }),
  });
  const first = FakeWebSocket.instances[0];
  first.open();
  first.message(position(123456789, 1.5, 2.5, 'SURVIVOR'));

  first.close();
  assert.equal(FakeWebSocket.instances.length, 1);
  await svc.timers.tick(5_000);
  assert.equal(FakeWebSocket.instances.length, 2);

  const second = FakeWebSocket.instances[1];
  second.open();
  assert.equal(second.sent.length, 1);

  // Cached vessels survive the reconnect.
  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.ships.length, 1);
  assert.equal(snapshot.body.status, 'streaming');
});

test('maritime sampling accepts Class B and metadata-only vessel positions', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 33, west: -119, north: 34, east: -118 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();

  socket.message(extendedClassBPosition(411111111, 33.72, -118.24, 'CLASS B VESSEL'));
  socket.message(metadataStaticPosition(422222222, 33.73, -118.25, 'METADATA VESSEL'));

  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.ships.length, 2);
  assert.deepEqual(snapshot.body.ships.map((s) => s.name).sort(), ['CLASS B VESSEL', 'METADATA VESSEL']);
  assert.equal(snapshot.body.ships.find((s) => s.name === 'METADATA VESSEL').type, 'tanker');
});

test('AIS upstream error messages are surfaced in snapshot status', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 33, west: -119, north: 34, east: -118 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message({ error: 'Api Key Is Not Valid' });

  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.status, 'error');
  assert.equal(snapshot.body.error, 'Api Key Is Not Valid');
  assert.equal(socket.closed, true);

  // Upstream rejections back off on the long timer instead of hammering AISStream.
  await svc.timers.tick(5_000);
  assert.equal(FakeWebSocket.instances.length, 1);
  await svc.timers.tick(55_000);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('maritime snapshots filter to a requested viewport and evict stale vessel positions', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: -10, west: 100, north: 10, east: 120 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();

  socket.message(position(200000001, -5, 110, 'IN VIEW'));
  socket.message(position(200000002, 51.9, 4.2, 'ROTTERDAM'));

  let snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.total_ships, 2);
  assert.equal(snapshot.body.ships.length, 2);

  snapshot = await svc.json('/v1/feeds/maritime/snapshot?south=-10&west=100&north=10&east=120');
  assert.equal(snapshot.body.total_ships, 2);
  assert.equal(snapshot.body.returned_ships, 1);
  assert.equal(snapshot.body.ships[0].name, 'IN VIEW');

  await svc.timers.tick(15 * 60_000 + 1);
  snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.total_ships, 0);
  assert.equal(snapshot.body.ships.length, 0);
});

test('AIS sentinel values and null-island positions never reach the snapshot', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 40, west: -10, north: 60, east: 10 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();

  // Sentinels: Sog 102.3 (speed n/a), TrueHeading 511 (heading n/a), Cog 360 (course n/a).
  socket.message({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 500000001, ShipName: 'SENTINEL' },
    Message: { PositionReport: { Latitude: 51.8, Longitude: 4.5, Sog: 102.3, TrueHeading: 511, Cog: 360 } },
  });
  // Null-island transponder default must be dropped entirely.
  socket.message(position(500000002, 0, 0, 'NULL ISLAND'));

  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.ships.length, 1);
  const ship = snapshot.body.ships[0];
  assert.equal(ship.name, 'SENTINEL');
  assert.equal(ship.speed, null);
  assert.equal(ship.heading, null);
});

test('static data enriches vessels with callsign, IMO, ETA, draught and dimensions', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: 40, west: -10, north: 60, east: 10 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();

  socket.message(position(600000001, 51.8, 4.5, 'ENRICHED'));
  socket.message({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: 600000001, ShipName: 'ENRICHED' },
    Message: {
      ShipStaticData: {
        Name: 'ENRICHED',
        CallSign: 'ABCD1',
        ImoNumber: 9321483,
        Destination: 'ES ALG',
        MaximumStaticDraught: 16.1,
        Eta: { Month: 7, Day: 7, Hour: 13, Minute: 0 },
        Dimension: { A: 200, B: 99, C: 20, D: 25 },
        Type: 71,
      },
    },
  });

  const snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  const ship = snapshot.body.ships.find((s) => s.mmsi === 600000001);
  assert.equal(ship.callsign, 'ABCD1');
  assert.equal(ship.imo, 9321483);
  assert.equal(ship.destination, 'ES ALG');
  assert.equal(ship.draught, 16.1);
  assert.equal(ship.eta, '07-07 13:00 UTC');
  assert.equal(ship.length, 299);
  assert.equal(ship.width, 45);
  assert.equal(ship.type, 'cargo');
});

test('missing AIS key suppresses any cached vessel positions in snapshots', async (t) => {
  const svc = await withService(t);
  await svc.json('/v1/activity', {
    method: 'POST',
    body: JSON.stringify({ feed: 'maritime', active: true, viewport: { south: -10, west: 100, north: 10, east: 120 } }),
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message(position(301234567, -3.5, 111.5, 'TEMP VESSEL'));

  let snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.ships.length, 1);

  svc.env.AIS_API_KEY = '';
  snapshot = await svc.json('/v1/feeds/maritime/snapshot');
  assert.equal(snapshot.body.status, 'missing_key');
  assert.equal(snapshot.body.total_ships, 0);
  assert.equal(snapshot.body.ships.length, 0);
});

test('live-feed sidecar source has no durable vessel-location storage path', () => {
  const serverPath = join(__dirname, 'server.js');
  assert.equal(existsSync(serverPath), true);
  const source = readFileSync(serverPath, 'utf8');
  assert.doesNotMatch(source, /DatabaseSync|sqlite|writeFile|appendFile|createWriteStream/);
});
