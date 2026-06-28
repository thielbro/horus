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
  assert.doesNotMatch(page, /key=\{horusTheme\}/);
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
  assert.match(page, /Number\.isFinite\(mapView\.longitude\)/);
  assert.match(page, /p\.set\('lon', lon\.toFixed\(4\)\)/);
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
  assert.doesNotMatch(polybolos, /horus-event-fire-\$\{i\}/);

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

test('stealth fetch removes external abort listeners', () => {
  const stealth = file('src/lib/stealthFetch.ts');
  // The non-functional "residential IP" generator (its value was never used in any header)
  // was removed; only UA/Accept-Language randomization + abort cleanup remain.
  assert.match(stealth, /removeEventListener\('abort'/);
  assert.doesNotMatch(stealth, /generateResidentialIP/);
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
  const sources = file('src/lib/cctv/sources.ts');
  const resilient = file('src/app/api/cctv/resilient.ts');
  const asfinag = file('src/app/api/cctv/asfinag.ts');
  const australia = file('src/app/api/cctv/australia.ts');
  const switzerland = file('src/app/api/cctv/switzerland.ts');
  const queensland = file('src/app/api/cctv/queensland.ts');

  assert.match(sources, /MAX_CAMERAS\s*=\s*5000/);
  // The fan-out bound lives in a named per-batch timeout constant passed to settleCameraFetchers()
  // (tuned to 12s so the widest region=all query stays under the route's maxDuration=60).
  assert.match(sources, /settleCameraFetchers(?:<[^>]+>)?\(/);
  assert.match(sources, /REGION_BATCH_TIMEOUT_MS\s*=\s*12_?000/);
  assert.match(route, /export const maxDuration\s*=\s*60/);
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
  assert.match(file('src/components/HorusMap.tsx'), /ResizeObserver/);
  assert.match(file('src/components/EntityGraphPanel.tsx'), /ResizeObserver/);
  assert.match(file('src/components/AiAnalyst.tsx'), /MAX_MESSAGES/);
});

test('entity graph implementation receives structured aircraft and vessel clicks', () => {
  const map = file('src/components/HorusMap.tsx');
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
  const cctv = file('src/lib/cctv/sources.ts');
  assert.match(cctv, /DEFAULT_CCTV_REGIONS/);
  assert.match(cctv, /MAX_REGION_ALL_CONCURRENCY/);
  assert.match(cctv, /runRegionFetchers/);
  assert.match(cctv, /resolveCctvRegions/);
  assert.match(cctv, /return DEFAULT_CCTV_REGIONS/);

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

test('package declares the Next 16 Node runtime floor', () => {
  const pkg = JSON.parse(file('package.json'));
  assert.equal(pkg.engines?.node, '>=20.9.0');
});

test('shared stability helpers are wired into correctness-sensitive routes', () => {
  assert.match(file('src/lib/http-utils.ts'), /export async function releaseResponseBody/);
  assert.match(file('src/lib/http-utils.ts'), /export function parseCsvRows/);
  assert.match(file('src/lib/http-utils.ts'), /export function clampFiniteInt/);
  assert.match(file('src/lib/http-utils.ts'), /export function parseKpIndex/);
  assert.match(file('src/lib/http-utils.ts'), /export function stableHash/);

  for (const path of [
    'src/app/api/earthquakes/route.ts',
    'src/app/api/frontlines/route.ts',
    'src/app/api/gdelt/route.ts',
    'src/lib/cctv/sources.ts',
    'src/app/api/cctv/asfinag.ts',
    'src/app/api/cctv/stream-status/route.ts',
    'src/app/api/air-quality/route.ts',
    'src/app/api/weather/route.ts',
    'src/app/api/region-dossier/route.ts',
    'src/app/api/flights/route.ts',
    'src/app/api/radar/route.ts',
    'src/app/api/satellites/route.ts',
    'src/app/api/proxy-tiles/route.ts',
  ]) {
    assert.match(file(path), /releaseResponseBody/, path);
  }

  assert.match(file('src/app/api/fires/route.ts'), /parseCsvRows/);
  assert.match(file('src/app/api/gdelt/route.ts'), /stableHash/);
  assert.doesNotMatch(file('src/app/api/gdelt/route.ts'), /crypto\.randomUUID/);
  assert.match(file('src/app/api/space-weather/route.ts'), /parseKpIndex/);
  assert.match(file('src/app/api/osint/sanctions/route.ts'), /clampFiniteInt/);
});

test('CCTV fanout aborts timed-out source work and deduplicates cameras', () => {
  const fanout = file('src/app/api/cctv/fanout.ts');
  assert.match(fanout, /CameraFetcher<T = unknown> = \(signal\?: AbortSignal\)/);
  assert.match(fanout, /controller\.abort/);
  assert.match(fanout, /fetcher\(controller\.signal\)/);

  const sources = file('src/lib/cctv/sources.ts');
  assert.match(sources, /fetchCaltransDistrict/);
  assert.match(sources, /fetchCanadaSource/);
  assert.match(sources, /Promise\.allSettled/);
  assert.match(sources, /\bseen(?:CameraIds)?\b\s*=\s*new Set<string>\(\)/);
});

test('desktop and SDK streams have bounded reconnect and crash behavior', () => {
  const main = file('desktop/main.js');
  assert.match(main, /SERVER_STABLE_RESET_MS/);
  assert.match(main, /serverRestartAttempts = 0/);
  assert.match(main, /MAX_RENDERER_RELOADS/);
  assert.match(main, /scheduleRendererReload/);

  const polybolos = file('src/lib/sdk/PolybolosClient.ts');
  assert.match(polybolos, /sseReconnectAttempts/);
  assert.match(polybolos, /SSE_RECONNECT_MAX_MS/);
  assert.match(polybolos, /scheduleSseReconnect/);
  assert.match(polybolos, /lastSseHeartbeatAt/);
  assert.doesNotMatch(polybolos, /Math\.random\(\)/);

  const stream = file('src/app/api/sdk/stream/route.ts');
  assert.match(stream, /sdkActiveStreamConnections/);
  assert.match(stream, /MAX_SDK_STREAM_CONNECTIONS/);
  assert.match(stream, /MAX_SDK_STREAM_LIFETIME_MS/);
});

test('frontend user-driven fetches abort stale requests', () => {
  const page = file('src/app/page.tsx');
  assert.match(page, /statsAbort/);
  assert.match(page, /regionDossierAbort/);
  assert.match(page, /spaceWeatherAbort/);
  assert.match(page, /cablesAbort/);

  const graph = file('src/components/EntityGraphPanel.tsx');
  assert.match(graph, /expandAbortRef/);
  assert.match(graph, /signal\.aborted/);

  const osint = file('src/components/OsintPanel.tsx');
  assert.match(osint, /lookupAbortRef/);
  assert.match(osint, /cveAbortRef/);

  assert.match(file('src/components/GlobalStatusBar.tsx'), /AbortController/);
  assert.match(file('src/components/SearchBar.tsx'), /AbortController/);
});

test('bounded-input and lifecycle fixes remain wired', () => {
  assert.match(file('src/app/api/osint/threats/route.ts'), /TOR_EXIT_LIST_TTL_MS/);
  assert.match(file('src/app/api/osint/threats/route.ts'), /torExitListCache/);
  assert.match(file('src/app/api/osint/github/route.ts'), /Promise\.allSettled/);
  assert.match(file('src/app/api/scanner/route.ts'), /vuln:\s*\{\s*endpoint:\s*'\/scan\/vuln',\s*timeout:\s*10000/);
  assert.match(file('src/app/api/sdk/ingest/route.ts'), /Number\.isFinite\(contentLength\)/);
  assert.match(file('src/app/api/sentinel/route.ts'), /clampFinite/);
  assert.match(file('src/lib/settings/index.ts'), /cloneJson/);
  assert.match(file('src/lib/settings/index.ts'), /patch === null/);
  assert.match(file('src/lib/sdk/LatticeAdapter.ts'), /validateTrackPosition/);
  assert.match(file('intel/server.js'), /sanctionsRefreshInterval/);
  assert.match(file('src/app/api/maritime/route.ts'), /cleanupAisStream/);
});

test('map popups and computed meshes guard malformed or oversized data', () => {
  const map = file('src/components/HorusMap.tsx');
  const registry = file('src/lib/registry/builtins.ts');
  assert.match(map, /safeJsonArray/);
  assert.match(registry, /MAX_MESH_NODES/);
  assert.match(map, /Map init failed/);
});

test('delta review map and registry cleanup recommendations stay fixed', () => {
  const map = file('src/components/HorusMap.tsx');
  const layerPanel = file('src/components/LayerPanel.tsx');
  const registry = file('src/lib/registry/builtins.ts');
  const mapEngine = file('src/lib/registry/mapEngine.ts');

  assert.doesNotMatch(layerPanel, /ALL_LAYERS/);
  assert.match(map, /onEntityClickRef/);
  assert.match(map, /popupRef\.current\?\.remove\(\);[\s\S]*map\.remove\(\)/);
  assert.doesNotMatch(map, /\[mapReady, registryVersion, theme, onEntityClick\]/);
  assert.match(mapEngine, /updateRegistryLayerTheme/);
  assert.match(registry, /Number\.isFinite/);
  assert.match(registry, /GeoJSON expects \[lng, lat\]/);
});

test('registry cleanup keeps source ownership and SDK mapSource contract aligned', () => {
  const map = file('src/components/HorusMap.tsx');
  const mapEngine = file('src/lib/registry/mapEngine.ts');
  const types = file('src/lib/registry/types.ts');
  const context = file('src/lib/plugins/context.ts');
  const sourceList = map.match(/const sources = \[([\s\S]*?)\];/)?.[1] ?? '';

  for (const rawSource of ['war-alerts-targets', 'war-alerts-lines', 'balloons', 'radiation']) {
    assert.ok(sourceList.includes(`'${rawSource}'`), `${rawSource} remains an imperative source`);
  }
  for (const registrySource of [
    'flights', 'military', 'jets', 'private-fl', 'satellites', 'earthquakes', 'gdelt',
    'gps-jamming', 'day-night', 'cctv', 'surveillance', 'fires', 'weather', 'infrastructure',
    'maritime', 'maritime-choke', 'maritime-ships', 'live-news', 'sigint-news', 'conflict-zones',
    'ip-sweep-devices', 'ip-sweep-pulse', 'ip-sweep-connections', 'scan-targets',
    'sdk-entities', 'sdk-links', 'malware-nodes', 'network-mesh',
  ]) {
    assert.ok(!sourceList.includes(`'${registrySource}'`), `${registrySource} is registry-owned`);
  }

  assert.match(types, /mapSource\?: string/);
  assert.match(mapEngine, /getRenderBindingSource/);
  assert.match(context, /mapSource: ns\(sl\.mapSource/);
  assert.doesNotMatch(context, /source: ns\(sl\.mapSource/);
});

test('extension delta review frontend lifecycle fixes stay wired', () => {
  const page = file('src/app/page.tsx');
  const map = file('src/components/HorusMap.tsx');
  const settingsPanel = file('src/components/SettingsPanel.tsx');
  const layerPanel = file('src/components/LayerPanel.tsx');

  assert.match(page, /document\.body\.classList\.toggle\('theme-ghost'/);
  assert.match(page, /return \(\) => \{[\s\S]*if \(urlTimer\.current\) clearTimeout\(urlTimer\.current\)/);
  assert.match(page, /if \(!r\.ok\) throw new Error\('IP geolocation failed'\)/);
  assert.match(page, /if \(!res\.ok\) throw new Error\('Stats request failed'\)/);
  assert.match(page, /let cancelled = false[\s\S]*bootstrapExtensions\(\)[\s\S]*cancelled/);
  assert.match(page, /active\.forEach\(k => \{[\s\S]*if \(k in next\) \(next as any\)\[k\] = true/);
  assert.match(page, /function getYouTubeWatchUrl\(url: string\): string \{[\s\S]*new URL\(url\)/);
  assert.match(page, /sandbox="allow-scripts allow-same-origin allow-presentation"/);
  assert.match(page, /const handleSweepVisualize = useCallback/);
  assert.match(page, /setMapProjection\('globe'\)[\s\S]*setSweepData/);

  assert.doesNotMatch(map, /getContext\('2d'\)!/);
  assert.match(map, /if \(!ctx\) return/);
  assert.match(map, /return \(\) => \{[\s\S]*dynState\.current[\s\S]*teardownEntry/);
  assert.match(map, /data\.sdk_entities/);
  assert.match(map, /data\.conflict_zones/);
  assert.match(map, /data\.gdelt/);

  assert.match(layerPanel, /useMemo/);
  assert.match(layerPanel, /void registryVersion;[\s\S]*return getLayerGroups\(theme\);[\s\S]*\[theme, registryVersion\]/);
  assert.match(settingsPanel, /export default memo\(SettingsPanel\)/);
});

test('extension delta review registry engine avoids timer churn and stale intervals', () => {
  const engine = file('src/lib/registry/engine.ts');
  const mapEngine = file('src/lib/registry/mapEngine.ts');
  const customSource = file('src/lib/registry/customSource.ts');
  const store = file('src/lib/registry/store.ts');
  const feeds = file('src/lib/registry/feeds.ts');
  const events = file('src/lib/registry/events.ts');
  const builtins = file('src/lib/registry/builtins.ts');

  assert.match(engine, /coreIntervalsRef/);
  assert.match(engine, /coreStartupTimersRef/);
  assert.match(engine, /getFeedSignature/);
  assert.match(engine, /\.catch\(\(err\) =>/);
  assert.match(engine, /fetched\.current\?\.delete\(id\)/);
  assert.match(engine, /entry\.signature !== signature/);

  assert.match(mapEngine, /safeRegistryLayerSources/);
  assert.match(mapEngine, /try\s*\{[\s\S]*registryLayerSources\(layer\)/);
  assert.match(mapEngine, /try\s*\{[\s\S]*getRenderBindingSource\(binding\)/);

  assert.match(customSource, /console\.warn\('\[HORUS\] Custom source jsonPath did not resolve to an array'/);
  assert.match(store, /MAX_REGISTRY_LAYERS/);
  assert.match(store, /MAX_REGISTRY_GROUPS/);
  assert.match(feeds, /MAX_REGISTRY_FEEDS/);
  assert.match(events, /console\.error\('\[HORUS\] Registry listener failed'/);
  assert.match(builtins, /SOLAR_TERMINATOR_TTL_MS/);
  assert.match(builtins, /s\.name \|\| s\.mmsi\?\.toString\(\) \|\| 'Unknown'/);
});

test('second-pass stability review crash guards and bounded async paths stay fixed', () => {
  const httpUtils = file('src/lib/http-utils.ts');
  assert.match(httpUtils, /export function safeAbortTimeout/);
  assert.match(httpUtils, /export function safeAbortAny/);
  assert.match(httpUtils, /seen = new WeakSet<object>/);
  assert.match(httpUtils, /Circular/);

  const bundles = file('src/lib/plugins/bundles.ts');
  assert.match(bundles, /try\s*\{[\s\S]*JSON\.parse\(payload\)/);
  assert.match(bundles, /Invalid JSON/);

  const surveillance = file('src/components/SurveillancePanel.tsx');
  assert.match(surveillance, /testAbortControllersRef/);
  assert.match(surveillance, /MAX_TEST_RESULTS/);
  assert.match(surveillance, /signal:\s*controller\.signal/);
  assert.match(surveillance, /handleRemoveSource/);
  assert.match(surveillance, /setTests\(\{\}\)/);
  assert.doesNotMatch(surveillance, /onClick=\{\(\) => removeCustomSource\(s\.id\)\}/);

  const overpass = file('src/lib/overpass.ts');
  assert.match(overpass, /releaseResponseBody/);
  assert.match(overpass, /safeAbortTimeout\(30000\)/);
  assert.match(overpass, /await releaseResponseBody\(res\)/);

  const proxy = file('src/proxy.ts');
  assert.match(proxy, /releaseResponseBody/);
  assert.match(proxy, /safeAbortTimeout\(3000\)/);
  assert.match(proxy, /then\(releaseResponseBody/);

  const main = file('desktop/main.js');
  assert.match(main, /state\.restartTimer/);
  assert.match(main, /serverRestartTimer/);
  assert.match(main, /MAX_SETTINGS_BYTES/);
  assert.match(main, /renameSync\(tmpPath, settingsPath\(\)\)/);

  const scanner = file('scanner/server.js');
  assert.match(scanner, /safeAbortTimeout/);
  assert.match(scanner, /readTextLimit/);
  assert.doesNotMatch(scanner, /await res\.text\(\)\)\.slice/);

  const page = file('src/app/page.tsx');
  assert.match(page, /FETCH_ENDPOINT_TIMEOUT_MS/);
  assert.match(page, /AbortController/);
  assert.match(page, /clearTimeout\(timeout\)/);

  const aiPanel = file('src/components/AiAnalyst.tsx');
  assert.match(aiPanel, /AI_REQUEST_TIMEOUT_MS/);
  assert.match(aiPanel, /aiRequestAbortRef/);
  assert.match(aiPanel, /signal:\s*controller\.signal/);

  const share = file('src/components/SharePanel.tsx');
  assert.match(share, /finiteOr/);
  assert.doesNotMatch(share, /mapView\.zoom\.toFixed\(2\)/);

  const aiEngine = file('src/lib/ai-engine.ts');
  assert.match(aiEngine, /maxEarthquakeMagnitude/);
  assert.doesNotMatch(aiEngine, /Math\.max\(\.\.\.context\.earthquakes\.map/);

  const scm = file('src/components/ScmPanel.tsx');
  assert.match(scm, /safeThreatList/);
  assert.match(scm, /try\s*\{[\s\S]*JSON\.parse/);

  const workspaces = file('src/components/WorkspacesSettings.tsx');
  assert.match(workspaces, /captureSnapshot/);
  assert.match(workspaces, /try\s*\{[\s\S]*getCurrentSnapshot\(\)/);

  const camera = file('src/components/CameraViewer.tsx');
  assert.match(camera, /destroyHls/);
  assert.match(camera, /if \(data\.fatal\) \{[\s\S]*destroyHls/);

  const map = file('src/components/HorusMap.tsx');
  assert.match(map, /let map: maplibregl\.Map/);
  assert.match(map, /try\s*\{[\s\S]*new maplibregl\.Map/);

  const settings = file('src/components/SettingsPanel.tsx');
  assert.match(settings, /usePrevious/);

  const osint = file('src/components/OsintPanel.tsx');
  const osintInnerIndex = osint.indexOf('function OsintPanelInner');
  for (const name of ['ResultRow', 'StatusBadge', 'SanctionsBadge', 'SectionHeader', 'PortRow']) {
    assert.ok(osint.indexOf(`function ${name}`) > -1 && osint.indexOf(`function ${name}`) < osintInnerIndex, `${name} is hoisted`);
  }
});
