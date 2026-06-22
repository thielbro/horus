import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('global CSS does not transition every element', () => {
  const css = file('src/app/globals.css');
  assert.doesNotMatch(css, /\*\s*\{[^}]*transition:/);
});

test('main map is not remounted on theme switch', () => {
  const page = file('src/app/page.tsx');
  assert.doesNotMatch(page, /key=\{osirisTheme\}/);
});

test('stats route reads GDELT events instead of a stale field name', () => {
  const route = file('src/app/api/stats/route.ts');
  assert.doesNotMatch(route, /data\.gdelt\?\./);
  assert.match(route, /data\.events\?\./);
});

test('reviewed route handlers bound hung upstreams and malformed JSON', () => {
  const stats = file('src/app/api/stats/route.ts');
  assert.match(stats, /async function readJsonOrNull/);
  assert.match(stats, /await res\.body\?\.cancel\(\)/);
  assert.match(stats, /readJsonOrNull\(flightsRes\.value\)/);

  const scanner = file('src/app/api/scanner/route.ts');
  assert.match(scanner, /VALIDATE_HOST_TIMEOUT_MS/);
  assert.match(scanner, /withDeadline\(validateHost\(target\)/);

  const aiEngine = file('src/lib/ai-engine.ts');
  assert.match(aiEngine, /signal\?: AbortSignal/);
  assert.match(aiEngine, /Promise\.race\(\[promise, abortPromise, timeout\]\)/);

  const analyzeRoute = file('src/app/api/ai/analyze/route.ts');
  assert.match(analyzeRoute, /createRequestSignal\(request\.signal\)/);
  assert.match(analyzeRoute, /analyzeIntelligence\(client, body\.context, body\.query\.trim\(\), signal\)/);

  const briefingRoute = file('src/app/api/ai/briefing/route.ts');
  assert.match(briefingRoute, /createRequestSignal\(request\.signal\)/);
  assert.match(briefingRoute, /generateBriefing\(client, body\.context, signal\)/);
});

test('reviewed network helpers release pooled connections and reconnect with backoff', () => {
  const ssrf = file('src/lib/ssrf-guard.ts');
  assert.match(ssrf, /SAFE_FETCH_TIMEOUT_MS/);
  assert.match(ssrf, /withTimeoutSignal/);
  assert.match(ssrf, /await res\.body\?\.cancel\(\)/);

  const maritime = file('src/app/api/maritime/route.ts');
  assert.match(maritime, /aisReconnectAttempts/);
  assert.match(maritime, /AIS_RECONNECT_MAX_MS/);
  assert.match(maritime, /scheduleAisReconnect/);
  assert.match(maritime, /globalForAis\.aisSocket = null/);
  assert.match(maritime, /while\s*\(\s*shipsCache\.size\s*>\s*MAX_SHIPS_CACHE/);
});

test('reviewed frontend caches and viewers stay bounded while preserving map view', () => {
  const page = file('src/app/page.tsx');
  assert.match(page, /DATA_ARRAY_LIMITS/);
  assert.match(page, /capDataPayload/);
  assert.match(page, /longitude:\s*0/);
  assert.match(page, /p\.set\('lon', \(mapView\.longitude/);
  assert.match(page, /\{activeCamera && \(\s*<CameraViewer/);
  assert.doesNotMatch(page, /const startTime = useRef\(Date\.now\(\)\)/);

  const graph = file('src/components/EntityGraphPanel.tsx');
  assert.match(graph, /MAX_GRAPH_NODES/);
  assert.match(graph, /MAX_GRAPH_LINKS/);
  assert.match(graph, /if \(n\.x == null \|\| n\.y == null\) return/);

  const osint = file('src/components/OsintPanel.tsx');
  assert.match(osint, /MAX_CVE_CACHE_ENTRIES/);
  assert.match(osint, /setCveCache\(prev =>/);
  assert.match(osint, /\[query, activeTab, scanType, loading, sweepCidr, onScanGeolocate\]/);
});

test('reviewed SDK and desktop lifecycle resources are cleaned up', () => {
  const polybolos = file('src/lib/sdk/PolybolosClient.ts');
  assert.match(polybolos, /this\.sseConnection\?\.close\(\)/);
  assert.doesNotMatch(polybolos, /osiris-event-fire-\$\{i\}/);

  const main = file('desktop/main.js');
  assert.match(main, /if \(serverChild\) return/);
  assert.match(main, /serverRestartAttempts/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /fs\.closeSync\(logFd\)/);
  assert.match(main, /serverChild\.on\('error'/);
  assert.doesNotMatch(main, /app\.exit\(/);
});

test('scanner network sockets have bounded lifetime and buffers', () => {
  const server = file('scanner/server.js');
  assert.match(server, /MAX_WHOIS_BYTES\s*=\s*64\s*\*\s*1024/);
  assert.match(server, /if\s*\(\s*bytes\s*>\s*MAX_WHOIS_BYTES\s*\)/);
  assert.match(server, /sock\.once\('error',[\s\S]*?sock\.destroy\(\)/);
});

test('desktop server polling destroys stalled startup probes', () => {
  const main = file('desktop/main.js');
  assert.match(main, /req\.setTimeout\(\s*3000/);
  assert.match(main, /req\.destroy\(\)/);
  assert.match(main, /maxAttempts/);
});

test('scanner docker image installs from lockfile', () => {
  const dockerfile = file('scanner/Dockerfile');
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /npm install --omit=dev/);
});

test('elasticsearch compose image uses a published stable tag', () => {
  const compose = file('docker-compose.yml');
  assert.doesNotMatch(compose, /elasticsearch:9\.4\.2/);
  assert.match(compose, /elasticsearch:8\.17\.0/);
});

test('batchFetch uses a queue instead of shared incrementing index workers', () => {
  const utils = file('src/lib/osint-utils.ts');
  assert.doesNotMatch(utils, /let idx = 0/);
  assert.doesNotMatch(utils, /idx\+\+/);
  assert.match(utils, /queue\.pop\(\)/);
});

test('stealth fetch removes external abort listeners and clamps generated IPs', () => {
  const stealth = file('src/lib/stealthFetch.ts');
  assert.match(stealth, /Math\.min\(255/);
  assert.match(stealth, /removeEventListener\('abort'/);
});

test('AI and sweep rate limit maps have hard caps', () => {
  for (const path of [
    'src/app/api/ai/analyze/route.ts',
    'src/app/api/ai/briefing/route.ts',
    'src/app/api/osint/sweep/route.ts',
  ]) {
    const source = file(path);
    assert.match(source, /MAX_RATE_LIMIT_ENTRIES/);
  }
});

test('CCTV fallbacks are bounded and key feed fields are stable', () => {
  const route = file('src/app/api/cctv/route.ts');
  const resilient = file('src/app/api/cctv/resilient.ts');
  const asfinag = file('src/app/api/cctv/asfinag.ts');
  const australia = file('src/app/api/cctv/australia.ts');
  const switzerland = file('src/app/api/cctv/switzerland.ts');
  const queensland = file('src/app/api/cctv/queensland.ts');

  assert.match(route, /MAX_CAMERAS\s*=\s*5000/);
  // The 25s fan-out bound moved from an inline AbortSignal into settleCameraFetchers().
  assert.match(route, /settleCameraFetchers(?:<[^>]+>)?\(/);
  assert.match(route, /\b25000\b/);
  assert.match(resilient, /LAST_GOOD_TTL_MS/);
  assert.match(asfinag, /withFallback\('at-asfinag'/);
  assert.match(australia, /Number\.isFinite\(c\.lat\)/);
  assert.match(switzerland, /feed_url:\s*'https:\/\/wc-heli/);
  assert.doesNotMatch(switzerland, /stream_url:\s*'https:\/\/wc-heli/);
  assert.doesNotMatch(queensland, /cameras\.length/);
});

test('large request and response parsing paths are guarded', () => {
  for (const path of [
    'src/app/api/news/route.ts',
    'src/app/api/malware/route.ts',
    'src/app/api/sdk/ingest/route.ts',
    'src/app/api/proxy-tiles/route.ts',
  ]) {
    const source = file(path);
    assert.match(source, /content-length/i, path);
  }
});

test('OSINT lookup routes cache external API results', () => {
  for (const path of [
    'src/app/api/osint/cve/route.ts',
    'src/app/api/osint/bgp/route.ts',
    'src/app/api/osint/dns/route.ts',
  ]) {
    const source = file(path);
    assert.match(source, /CACHE_TTL_MS/, path);
    assert.match(source, /MAX_CACHE_ENTRIES/, path);
  }
});

test('country-risk avoids hot formatter allocation and quake magnitude summing', () => {
  const source = file('src/app/api/country-risk/route.ts');
  assert.match(source, /formatterCache/);
  assert.match(source, /maxMagnitude/);
  assert.doesNotMatch(source, /quakeRisks\[code\]\s*=\s*\(quakeRisks\[code\]\s*\|\|\s*0\)\s*\+\s*mag/);
});

test('Bulgaria source parser reuses regexes and has deterministic fallback ids', () => {
  const source = file('src/lib/bulgaria-sources.ts');
  assert.match(source, /MARKER_ATTR_REGEX/);
  assert.doesNotMatch(source, /new RegExp\(/);
  assert.doesNotMatch(source, /Math\.random\(\)/);
});

test('service containers and node services expose health and shutdown paths', () => {
  const compose = file('docker-compose.yml');
  assert.match(compose, /healthcheck:/);
  assert.match(file('scanner/server.js'), /server\.close/);
  assert.match(file('intel/server.js'), /server\.close/);
  assert.match(file('desktop/main.js'), /stopEmbeddedServer/);
});

test('toolchain targets Node 22 era runtime features', () => {
  assert.match(file('tsconfig.json'), /"target":\s*"ES2022"/);
  assert.match(file('package.json'), /"@types\/node":\s*"\^22"/);
});

test('low-risk frontend and CCTV cleanup items stay fixed', () => {
  assert.doesNotMatch(file('src/app/api/cctv/types.ts'), /normalizeFeedUrl/);
  assert.doesNotMatch(file('src/app/api/cctv/bulgaria.ts'), /BULGARIA_FWCBG_CAMERAS/);
  assert.match(file('src/app/api/cctv/turkey.ts'), /export default fetchTurkeyCameras/);
  assert.doesNotMatch(file('src/app/api/cctv/greece.ts'), /feed_url:\s*`https:\/\/ipcamlive\.com/);
  assert.doesNotMatch(file('src/components/IntelFeed.tsx'), /key=\{i\}/);
  assert.match(file('src/components/LiveAlerts.tsx'), /useMemo/);
  assert.match(file('src/components/ScmPanel.tsx'), /useMemo/);
});

test('frontend unmount and resize-sensitive components clean up resources', () => {
  assert.match(file('src/components/SearchBar.tsx'), /clearTimeout\(timerRef\.current\)/);
  assert.match(file('src/components/OsirisMap.tsx'), /ResizeObserver/);
  assert.match(file('src/components/EntityGraphPanel.tsx'), /ResizeObserver/);
  assert.match(file('src/components/AiAnalyst.tsx'), /MAX_MESSAGES/);
});

test('entity graph implementation receives structured aircraft and vessel clicks', () => {
  const map = file('src/components/OsirisMap.tsx');
  const page = file('src/app/page.tsx');

  assert.match(map, /type:\s*'aircraft'[\s\S]*id:\s*aircraftId/);
  assert.match(map, /type:\s*'vessel'[\s\S]*id:\s*String\(vesselId\)/);
  assert.match(map, /mmsi:\s*s\.mmsi/);
  assert.match(map, /imo:\s*s\.imo/);
  assert.match(page, /entity\?\.type === 'aircraft'[\s\S]*setShowEntityGraph\(true\)/);
  assert.match(page, /entity\?\.type === 'vessel'[\s\S]*setShowEntityGraph\(true\)/);
});

test('registry map engine isolates bad plugin render and style specs', () => {
  const source = file('src/lib/registry/mapEngine.ts');

  assert.match(source, /try\s*\{[\s\S]*map\.addSource/);
  assert.match(source, /try\s*\{[\s\S]*map\.addLayer/);
  assert.match(source, /try\s*\{[\s\S]*binding\.toFeatures/);
  assert.match(source, /console\.(?:warn|error)\([^)]*layerId/);
});

test('surveillance bbox input is bounded before Overpass fanout', () => {
  const source = file('src/app/api/surveillance/route.ts');

  assert.match(source, /MAX_BBOX_AREA_DEGREES/);
  assert.match(source, /parseBboxParam/);
  assert.match(source, /status:\s*400/);
  assert.match(source, /bbox area too large/i);
});

test('intel sanctions loader fails loudly on missing CSV schema columns', () => {
  const source = file('intel/server.js');

  assert.match(source, /REQUIRED_SANCTIONS_COLUMNS/);
  assert.match(source, /validateSanctionsHeaders/);
  assert.match(source, /missing required OpenSanctions CSV column/i);
});

test('aircraft resolver returns a self-contained root node', () => {
  const source = file('intel/server.js');

  assert.match(source, /nodes\.push\(\{\s*id:\s*rootId,\s*label:\s*callsign,\s*type:\s*'aircraft'/);
});

test('second-pass route fanout and parsing guards stay bounded', () => {
  const cctv = file('src/app/api/cctv/route.ts');
  assert.match(cctv, /DEFAULT_CCTV_REGIONS/);
  assert.match(cctv, /MAX_REGION_ALL_CONCURRENCY/);
  assert.match(cctv, /runRegionFetchers/);
  assert.match(cctv, /regionsToFetch = DEFAULT_CCTV_REGIONS/);

  const news = file('src/app/api/news/route.ts');
  assert.match(news, /MAX_PARSE_MS/);
  assert.match(news, /Date\.now\(\) - startedAt > MAX_PARSE_MS/);
  assert.match(news, /safePublishedTime/);
  assert.match(news, /newsItems\.sort\(\(a, b\) => safePublishedTime\(b\.published\) - safePublishedTime\(a\.published\)\)/);

  const spaceWeather = file('src/app/api/space-weather/route.ts');
  assert.match(spaceWeather, /fetchJsonIfOk/);
  assert.match(spaceWeather, /if \(!res\.ok\)/);
  assert.match(spaceWeather, /latest\.kp_index \?\? latest\.Kp \?\? 0/);
});

test('second-pass free API routes rate limit and flaky Yahoo calls retry', () => {
  for (const path of [
    'src/app/api/region-dossier/route.ts',
    'src/app/api/surveillance/route.ts',
  ]) {
    const source = file(path);
    assert.match(source, /isRateLimited/);
    assert.match(source, /getClientIp/);
    assert.match(source, /status:\s*429/);
  }

  const markets = file('src/app/api/markets/route.ts');
  assert.match(markets, /YAHOO_RETRY_DELAYS_MS/);
  assert.match(markets, /fetchYahooJson/);
  assert.match(markets, /await res\.body\?\.cancel\(\)/);
});

test('second-pass SDK and utility cleanup items stay fixed', () => {
  const lattice = file('src/lib/sdk/LatticeAdapter.ts');
  assert.match(lattice, /this\.scheduleReconnect\(\)/);

  const utils = file('src/lib/osint-utils.ts');
  assert.match(utils, /try\s*\{[\s\S]*results\[task\.index\] = await fn\(task\.url\)/);
  assert.match(utils, /catch\s*\{[\s\S]*results\[task\.index\] = null/);

  const polybolos = file('src/lib/sdk/PolybolosClient.ts');
  assert.match(polybolos, /this\.sseConnection\?\.readyState === 1/);
  assert.doesNotMatch(polybolos, /connected:\s*true/);

  const restore = file('scripts/restore_telegeography_cables.js');
  assert.match(restore, /req\.setTimeout\(30000/);
  assert.match(restore, /try\s*\{[\s\S]*JSON\.parse\(data\)/);
});

test('feed engine aborts in-flight requests and avoids interval churn', () => {
  const engine = file('src/lib/registry/engine.ts');
  assert.match(engine, /AbortController/);
  assert.match(engine, /controllersRef/);
  assert.match(engine, /lazyIntervalsRef/);
  assert.match(engine, /signal:\s*controller\.signal/);
  assert.match(engine, /controller\.abort\(\)/);
});
