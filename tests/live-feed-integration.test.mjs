import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const file = (path) => readFileSync(join(root, path), 'utf8');

test('maritime live data is activation-driven instead of a normal lazy feed', () => {
  const page = file('src/app/page.tsx');
  const feeds = file('src/lib/registry/feeds.ts');

  assert.match(page, /maritime:\s*false/);
  assert.match(page, /maritime_ships:\s*false/);
  assert.match(page, /useLiveFeedActivity\(activeLayers,\s*mapView,\s*fetchEndpoint\)/);
  assert.doesNotMatch(feeds, /id:\s*'maritime'/);
});

test('live ships have a dedicated layer toggle separate from static maritime context', () => {
  const page = file('src/app/page.tsx');
  const hook = file('src/lib/registry/useLiveFeedActivity.ts');
  const registry = file('src/lib/registry/builtins.ts');
  const map = file('src/components/HorusMap.tsx');

  assert.match(page, /maritime_ships:\s*false/);
  assert.match(registry, /id:\s*'maritime'[\s\S]*label:\s*'Ports \/ Chokepoints'/);
  assert.match(registry, /id:\s*'maritime_ships'[\s\S]*label:\s*'Live Ships'/);
  assert.match(registry, /active\.maritime_ships\s*&&\s*data\.maritime_ships/);
  assert.doesNotMatch(registry, /id:\s*'maritime'[\s\S]*active\.maritime\s*&&\s*data\.maritime_ships/);

  assert.match(hook, /activeLayers\.maritime_ships/);
  assert.doesNotMatch(hook, /const isActive = !!activeLayers\.maritime/);
  assert.match(hook, /SNAPSHOT_POLL_MS\s*=\s*15_000/);
  assert.match(hook, /snapshotPoll\s*=\s*setInterval\(/);
  // The vessel list request carries the viewport so the sidecar returns ships in view.
  assert.match(hook, /snapshotUrl\(/);

  assert.match(map, /addRegistryLayer\(map,\s*'maritime_ships'\)/);
  assert.match(map, /renderRegistryLayer\(setGeo,\s*'maritime_ships'/);
  assert.match(map, /setVis\(\['ship-dots','ship-label'\],\s*activeLayers\.maritime_ships\)/);
});

test('Next maritime routes proxy to the live-feed sidecar without owning AIS sockets', () => {
  const maritimeRoute = file('src/app/api/maritime/route.ts');
  const activityRoute = file('src/app/api/live-feed/activity/route.ts');
  const proxy = file('src/lib/live-feed.ts');

  assert.match(maritimeRoute, /runtime\s*=\s*'nodejs'/);
  assert.match(maritimeRoute, /dynamic\s*=\s*'force-dynamic'/);
  assert.match(maritimeRoute, /proxyMaritimeSnapshot/);
  assert.doesNotMatch(maritimeRoute, /WebSocket|shipsCache|AIS_API_KEY/);

  assert.match(activityRoute, /POST\(request: Request\)/);
  assert.match(activityRoute, /proxyLiveFeedActivity/);
  assert.match(proxy, /LIVE_FEED_URL/);
  assert.match(proxy, /\/v1\/feeds\/maritime\/snapshot/);
  assert.match(proxy, /\/v1\/activity/);
});

test('LIVE_FEED_URL is exposed in settings and environment documentation', () => {
  assert.match(file('src/lib/settings/index.ts'), /LIVE_FEED_URL\?: string/);
  assert.match(file('src/components/SettingsPanel.tsx'), /LIVE_FEED_URL/);
  assert.match(file('.env.example'), /LIVE_FEED_URL/);
  assert.match(file('.env.template'), /LIVE_FEED_URL/);
  assert.match(file('docker-compose.yml'), /LIVE_FEED_URL/);
});
