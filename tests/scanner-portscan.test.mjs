import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import test from 'node:test';

const root = process.cwd();
const require = createRequire(import.meta.url);
const file = (p) => readFileSync(join(root, p), 'utf8');

// portscan.js is net-only (no express), so it imports cleanly here.
const { buildTopPorts, buildAllPorts, portScan } = require(join(root, 'scanner', 'portscan.js'));

test('port-set builders cover the three tiers', () => {
  const top = buildTopPorts();
  // Well-known range 1-1024 plus curated common service ports.
  assert.ok(top.length > 1024 && top.length < 1200, `unexpected top count ${top.length}`);
  for (const p of [22, 80, 443, 3306, 3389, 8080, 8443, 27017]) {
    assert.ok(top.includes(p), `top ports missing ${p}`);
  }
  // Sorted ascending, unique.
  assert.deepEqual(top, [...top].sort((a, b) => a - b));
  assert.equal(new Set(top).size, top.length);

  const all = buildAllPorts();
  assert.equal(all.length, 65535);
  assert.equal(all[0], 1);
  assert.equal(all.at(-1), 65535);
});

test('portScan detects an open port and ignores a closed one', async () => {
  // Bind a throwaway TCP server on an ephemeral port.
  const server = net.createServer((s) => s.destroy());
  const openPort = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  // A port we deliberately do NOT listen on (open then immediately close to free it).
  const closedPort = await new Promise((resolve) => {
    const tmp = net.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const p = tmp.address().port;
      tmp.close(() => resolve(p));
    });
  });

  try {
    const res = await portScan('127.0.0.1', [openPort, closedPort], { concurrency: 2, timeout: 1000 });
    const openPorts = res.open.map((o) => o.port);
    assert.ok(openPorts.includes(openPort), `expected ${openPort} open`);
    assert.ok(!openPorts.includes(closedPort), `did not expect ${closedPort} open`);
    assert.equal(res.scanned, 2);
    assert.equal(res.truncated, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('portScan honors the overall deadline and reports truncation', async () => {
  // TEST-NET-1 (RFC5737) is non-routable, so probes hit the timeout — the deadline must
  // stop the sweep early and flag truncated, scanning fewer ports than requested.
  const ports = Array.from({ length: 200 }, (_, i) => 1 + i);
  const res = await portScan('192.0.2.1', ports, { concurrency: 3, timeout: 300, deadlineMs: 50 });
  assert.equal(res.truncated, true);
  assert.ok(res.scanned < ports.length, `scanned ${res.scanned} should be < ${ports.length}`);
  assert.equal(res.open.length, 0);
});

test('scanner backend exposes the new /scan/ports and /scan/deep endpoints', () => {
  const server = file('scanner/server.js');
  assert.match(server, /app\.get\('\/scan\/ports'/);
  assert.match(server, /app\.get\('\/scan\/deep'/);
  assert.match(server, /buildAllPorts\(\)/);
  assert.match(server, /deadlineMs: 240000/);
  // listen is guarded so the module is require()-able by this test without binding.
  assert.match(server, /require\.main === module/);
});

test('scanner proxy gates ports/deep behind the local desktop flag', () => {
  const route = file('src/app/api/scanner/route.ts');
  assert.match(route, /SCANNER_ALLOW_DEEP === '1'/);
  assert.match(route, /ports:\s*\{ endpoint: '\/scan\/ports'.*local: true/);
  assert.match(route, /deep:\s*\{ endpoint: '\/scan\/deep'.*local: true/);
  assert.match(route, /scanConfig\.local && !ALLOW_DEEP/);

  // The desktop app sets the flag only for its bundled local scanner.
  const main = file('desktop/main.js');
  assert.match(main, /SCANNER_ALLOW_DEEP: '1'/);
});
