const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');

const {
  ALLOWED_LAYERS,
  createService,
  isTileStale,
  loadEnvFile,
  normalizeLayerRecord,
  parseBbox,
  tileKeyFor,
} = require('./server');

const testDir = dirname(__filename);

async function withService(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'horus-surveillance-feed-'));

  const service = createService({
    dbPath: join(dir, 'feed.sqlite'),
    adminToken: 'test-token',
    autoProcessJobs: false,
    seedNzPolice: false,
    ...options,
  });
  const server = await new Promise((resolve) => {
    const s = service.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    service.close();
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
  return { ...service, baseUrl, json };
}

test('bbox parsing and layer allow-list stay narrow for the v1 feed', () => {
  assert.deepEqual(parseBbox('-36.95,174.65,-36.75,174.95'), [-36.95, 174.65, -36.75, 174.95]);
  assert.throws(() => parseBbox('bad'), /south,west,north,east/);
  assert.throws(() => parseBbox('-36.75,174.65,-36.95,174.95'), /south must be less than north/);
  assert.throws(() => parseBbox('-36.95,181,-36.75,174.95'), /longitude/);
  assert.deepEqual([...ALLOWED_LAYERS].sort(), ['flock', 'mass_surveil', 'police', 'surveillance']);
});

test('server env template documents runtime knobs and local env loading is non-destructive', async (t) => {
  const template = readFileSync(join(testDir, '.env.example'), 'utf8');
  for (const key of [
    'SURVEILLANCE_FEED_BIND',
    'SURVEILLANCE_FEED_PORT',
    'SURVEILLANCE_FEED_DB',
    'SURVEILLANCE_FEED_ADMIN_TOKEN',
    'SURVEILLANCE_FEED_REFRESH_MS',
    'SURVEILLANCE_FEED_TILE_DEGREES',
    'SURVEILLANCE_FEED_WORKERS',
    'SURVEILLANCE_FEED_RETRY_BASE_MS',
    'SURVEILLANCE_FEED_MAX_JOB_ATTEMPTS',
    'SURVEILLANCE_FEED_MAX_BBOX_AREA',
    'SURVEILLANCE_FEED_MAX_ROWS',
    'SURVEILLANCE_FEED_OVERPASS_TIMEOUT_MS',
    'SURVEILLANCE_FEED_OVERPASS_URLS',
  ]) {
    assert.match(template, new RegExp(`^${key}=`, 'm'), `${key} should be documented in sidecar env template`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'horus-surveillance-env-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const envPath = join(dir, '.env');
  await writeFile(envPath, [
    '# local sidecar config',
    'SURVEILLANCE_FEED_PORT=9999',
    'SURVEILLANCE_FEED_ADMIN_TOKEN="secret with spaces"',
    'SURVEILLANCE_FEED_DB=./data/custom.sqlite',
  ].join('\n'), 'utf8');

  const target = { SURVEILLANCE_FEED_PORT: '7800' };
  const loaded = loadEnvFile(envPath, target);
  assert.equal(target.SURVEILLANCE_FEED_PORT, '7800');
  assert.equal(target.SURVEILLANCE_FEED_ADMIN_TOKEN, 'secret with spaces');
  assert.equal(target.SURVEILLANCE_FEED_DB, './data/custom.sqlite');
  assert.deepEqual(loaded, {
    SURVEILLANCE_FEED_ADMIN_TOKEN: 'secret with spaces',
    SURVEILLANCE_FEED_DB: './data/custom.sqlite',
  });
});

test('linux installer prompts for bind, port, and token then writes service env', () => {
  const installer = readFileSync(join(testDir, 'install.sh'), 'utf8');

  assert.match(installer, /^#!\/usr\/bin\/env bash/);
  assert.match(installer, /set -euo pipefail/);
  assert.match(installer, /prompt_default "Bind address"/);
  assert.match(installer, /prompt_default "Port"/);
  assert.match(installer, /prompt_secret "Admin bearer token"/);
  assert.match(installer, /SURVEILLANCE_FEED_BIND=\$\{BIND_ADDR\}/);
  assert.match(installer, /SURVEILLANCE_FEED_PORT=\$\{PORT\}/);
  assert.match(installer, /SURVEILLANCE_FEED_ADMIN_TOKEN=\$\{ADMIN_TOKEN\}/);
  assert.match(installer, /SURVEILLANCE_FEED_TILE_DEGREES=0\.25/);
  assert.match(installer, /SURVEILLANCE_FEED_WORKERS=2/);
  assert.match(installer, /SURVEILLANCE_FEED_RETRY_BASE_MS=300000/);
  assert.match(installer, /SURVEILLANCE_FEED_MAX_JOB_ATTEMPTS=3/);
  assert.match(installer, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(installer, /systemctl daemon-reload/);
  assert.match(installer, /horus-surveillance-feed\.service/);
});

test('sidecar folder is deployable without the rest of the repo', () => {
  const server = readFileSync(join(testDir, 'server.js'), 'utf8');
  const dockerfile = readFileSync(join(testDir, 'Dockerfile'), 'utf8');

  assert.ok(
    existsSync(join(testDir, 'data', 'nz_police_stations.csv')),
    'NZ police seed data must be bundled inside surveillance-feed/',
  );
  assert.doesNotMatch(server, /path\.join\(__dirname,\s*['"]\.\.['"]/);
  assert.doesNotMatch(server, /src[\\/]+lib[\\/]+police[\\/]+data/);
  assert.doesNotMatch(dockerfile, /COPY\s+src\//);
  assert.doesNotMatch(dockerfile, /COPY\s+surveillance-feed\//);
  assert.match(dockerfile, /COPY package\.json package-lock\.json\* \.\//);
  assert.match(dockerfile, /COPY data\/nz_police_stations\.csv \.\/data\/nz_police_stations\.csv/);
});

test('normalization handles case-insensitive ALPR/Flock records', () => {
  const record = normalizeLayerRecord({
    layer: 'flock',
    source: 'osm',
    source_id: 'node/123',
    external_id: '123',
    lat: 40.7128,
    lng: -74.006,
    tags: {
      'surveillance:type': 'alpr',
      operator: 'Flock Safety',
    },
  });

  assert.equal(record.layer, 'flock');
  assert.equal(record.kind, 'alpr');
  assert.equal(record.name, 'ALPR Camera');
  assert.equal(record.operator, 'Flock Safety');
  assert.equal(record.id, 'osm:flock:node/123');
});

test('admin imports are bearer-protected, register unknown source metadata, and upsert records', async (t) => {
  const svc = await withService(t);

  const unauthorized = await svc.json('/v1/admin/import', {
    method: 'POST',
    body: JSON.stringify({ records: [] }),
  });
  assert.equal(unauthorized.res.status, 401);

  const payload = {
    source: {
      id: 'hermes-agent',
      label: 'Hermes LLM Import',
      kind: 'agent',
      attribution: 'operator supplied',
      refresh_ms: 12345,
      metadata: { importer: 'future-safe' },
    },
    records: [
      {
        layer: 'police',
        source_id: 'nz-test',
        name: 'Old Name',
        lat: -36.8485,
        lng: 174.7633,
        country: 'New Zealand',
        tags: { amenity: 'police' },
      },
      {
        layer: 'police',
        source_id: 'nz-test',
        name: 'Updated Name',
        lat: -36.8485,
        lng: 174.7633,
        country: 'New Zealand',
        tags: { amenity: 'police' },
      },
    ],
  };

  const imported = await svc.json('/v1/admin/import', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: JSON.stringify(payload),
  });
  assert.equal(imported.res.status, 200);
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.upserted, 1);

  const layer = await svc.json('/v1/layers?bbox=-37,174,-36,175&layers=police');
  assert.equal(layer.res.status, 200);
  assert.equal(layer.body.police.length, 1);
  assert.equal(layer.body.police[0].name, 'Updated Name');
  assert.equal(layer.body.police[0].source, 'Hermes LLM Import');

  const health = await svc.json('/health');
  assert.equal(health.body.sources['hermes-agent'].label, 'Hermes LLM Import');
  assert.equal(health.body.counts.police, 1);
});

test('public layer reads return immediately and queue refresh jobs for missing or stale tiles', async (t) => {
  const svc = await withService(t);

  const missingBbox = await svc.json('/v1/layers?layers=flock');
  assert.equal(missingBbox.res.status, 400);
  assert.match(missingBbox.body.error, /bbox/);

  const first = await svc.json('/v1/layers?bbox=10,20,10.5,20.5&layers=mass_surveil,flock');
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.body.mass_surveil, []);
  assert.deepEqual(first.body.flock, []);
  assert.equal(first.body.refresh.queued, 2);

  const jobs = await svc.json('/v1/admin/jobs', {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(jobs.res.status, 200);
  assert.equal(jobs.body.jobs.length, 2);
  assert.deepEqual(jobs.body.jobs.map((job) => job.layer).sort(), ['flock', 'mass_surveil']);
});

test('overlapping viewport reads reuse a coarse refresh tile instead of flooding jobs', async (t) => {
  const svc = await withService(t);

  const first = await svc.json('/v1/layers?bbox=10.01,20.01,10.10,20.10&layers=flock');
  assert.equal(first.res.status, 200);
  assert.equal(first.body.refresh.queued, 1);

  const second = await svc.json('/v1/layers?bbox=10.02,20.02,10.11,20.11&layers=flock');
  assert.equal(second.res.status, 200);
  assert.equal(second.body.refresh.queued, 0);

  const jobs = await svc.json('/v1/admin/jobs', {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(jobs.body.jobs.length, 1);
  assert.equal(jobs.body.jobs[0].tile_key, '10.0000,20.0000,10.2500,20.2500');
  assert.deepEqual(jobs.body.jobs[0].bbox, [10, 20, 10.25, 20.25]);
});

test('failed refresh jobs back off before retrying and eventually fail closed', async (t) => {
  let nowMs = 1_000;
  let calls = 0;
  const svc = await withService(t, {
    autoProcessJobs: true,
    maxJobAttempts: 2,
    retryBaseMs: 30_000,
    now: () => nowMs,
    fetch: async () => {
      calls += 1;
      throw new Error('overpass unavailable');
    },
  });

  svc.queueRefreshJob({ layer: 'flock', bbox: [10.01, 20.01, 10.10, 20.10] });
  await svc.processQueuedJobs();

  let row = svc.db.prepare('SELECT status, attempts, next_attempt_at, error FROM jobs LIMIT 1').get();
  const callsAfterFirstAttempt = calls;
  assert.ok(callsAfterFirstAttempt > 0);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, 31_000);
  assert.match(row.error, /overpass unavailable/);

  await svc.processQueuedJobs();
  assert.equal(calls, callsAfterFirstAttempt, 'delayed queued job should not retry before next_attempt_at');

  nowMs = 31_001;
  await svc.processQueuedJobs();

  row = svc.db.prepare('SELECT status, attempts, next_attempt_at, error FROM jobs LIMIT 1').get();
  assert.equal(calls, callsAfterFirstAttempt * 2);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.equal(row.next_attempt_at, null);
});

test('refresh worker concurrency is bounded while draining queued jobs', async (t) => {
  let nowMs = 10_000;
  let inFlight = 0;
  let maxInFlight = 0;
  const svc = await withService(t, {
    autoProcessJobs: true,
    workerConcurrency: 2,
    now: () => nowMs,
    fetch: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { ok: true, json: async () => ({ elements: [] }) };
    },
  });

  for (const offset of [0, 1, 2, 3, 4]) {
    svc.queueRefreshJob({ layer: 'surveillance', bbox: [10 + offset, 20, 10.1 + offset, 20.1] });
  }

  await svc.processQueuedJobs();

  assert.equal(maxInFlight, 2);
  const queue = svc.db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all();
  assert.deepEqual(queue.map((row) => ({ ...row })), [{ status: 'complete', count: 5 }]);
});

test('tile freshness helper uses source cadence and stable bbox keys', () => {
  const bbox = [-36.95, 174.65, -36.75, 174.95];
  assert.equal(tileKeyFor(bbox), '-36.9500,174.6500,-36.7500,174.9500');
  assert.equal(isTileStale(null, 1000, 2000), true);
  assert.equal(isTileStale(1500, 1000, 2000), false);
  assert.equal(isTileStale(0, 1000, 2000), true);
});
