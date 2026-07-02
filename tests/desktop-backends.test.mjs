import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Electron main launches the bundled scanner, intel, and live-feed backends with the engine', () => {
  const main = file('desktop/main.js');

  // Backends are started during the packaged embedded-server boot and their resolved URLs
  // are fed into the Next engine env (so /api/scanner + intel proxy reach the local copies).
  assert.match(main, /startManagedBackends\(apiKeys\)/);
  assert.match(main, /buildEngineEnv\(process\.env, apiKeys, backendOverrides\)/);

  // Each backend is forked as plain node (ELECTRON_RUN_AS_NODE), like the Next server.
  assert.match(main, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(main, /\[state\.portEnv\]: String\(state\.port\)/);

  // Scanner gets an HORUS_KEY; when the user hasn't set SCANNER_KEY we auto-provision one
  // so the /api/scanner proxy (which 503s without a key) works zero-config.
  assert.match(main, /HORUS_KEY: key/);
  assert.match(main, /crypto\.randomUUID\(\)/);
  assert.match(main, /SCANNER_URL: `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.match(main, /INTEL_URL: `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.match(main, /LIVE_FEED_URL: `http:\/\/127\.0\.0\.1:\$\{port\}`/);
  assert.match(main, /AIS_API_KEY: apiKeys\.AIS_API_KEY/);

  // A user-configured remote URL opts that backend out of being launched locally.
  assert.match(main, /if \(!isNonBlank\(apiKeys\.SCANNER_URL\)\)/);
  assert.match(main, /if \(!isNonBlank\(apiKeys\.INTEL_URL\)\)/);
  assert.match(main, /if \(!isNonBlank\(apiKeys\.LIVE_FEED_URL\)\)/);
});

test('Electron main waits for backend health and tears them down on quit', () => {
  const main = file('desktop/main.js');

  // Readiness is gated on each backend's /health before the URL is trusted.
  assert.match(main, /healthPath: '\/health'/);
  assert.match(main, /waitForServer\(`http:\/\/127\.0\.0\.1:\$\{state\.port\}\$\{state\.healthPath\}`/);

  // Backends are killed alongside the server on quit/relaunch (stopEmbeddedServer runs on
  // before-quit, SIGTERM/SIGINT, relaunch, and fatal handlers). SIGTERM first, then a SIGKILL
  // fallback after a timeout so a hung backend can't linger as a zombie.
  assert.match(main, /function stopManagedBackends\(\)/);
  assert.match(main, /stopManagedBackends\(\);/);
  assert.match(main, /child\.kill\('SIGTERM'\)/);
  assert.match(main, /child\.kill\('SIGKILL'\)/);

  // Crash recovery: bounded restart on the same stored port keeps the injected URL valid.
  assert.match(main, /function scheduleBackendRestart\(state\)/);
  assert.match(main, /state\.attempts >= MAX_BACKEND_RESTARTS/);
  assert.match(main, /child\.on\('exit'[\s\S]*?scheduleBackendRestart\(state\)/);
});

test('prepare-standalone stages both backends with production deps', () => {
  const prep = file('desktop/prepare-standalone.js');

  assert.match(prep, /stageBackend\('scanner', \['server\.js', 'portscan\.js', 'package\.json', 'package-lock\.json'\]\)/);
  assert.match(prep, /stageBackend\('intel', \['server\.js', 'sources\.js', 'package\.json', 'package-lock\.json'\]\)/);
  assert.match(prep, /stageBackend\('live-feed', \['server\.js', 'package\.json', 'package-lock\.json'\]\)/);
  // Production-only install, verified by express landing in node_modules.
  assert.match(prep, /--omit=dev/);
  assert.match(prep, /node_modules', 'express'/);
  // Resilient install: isolated user config + stripped npm_config_allow_scripts as a last
  // resort, so a hostile global ~/.npmrc can't break the packaged build.
  assert.match(prep, /NPM_CONFIG_USERCONFIG: isolated/);
  assert.match(prep, /npm_config_allow\[_-\]\?scripts/i);
});

test('after-pack copies server, scanner, intel, and live-feed into resources with their node_modules', () => {
  const afterPack = file('desktop/after-pack.js');

  assert.match(afterPack, /name: 'server', requireModule: 'next'/);
  assert.match(afterPack, /name: 'scanner', requireModule: 'express'/);
  assert.match(afterPack, /name: 'intel', requireModule: 'express'/);
  assert.match(afterPack, /name: 'live-feed', requireModule: 'express'/);
  assert.match(afterPack, /resources', tree\.name/);
  assert.match(afterPack, /node_modules', tree\.requireModule/);
  assert.match(afterPack, /throw new Error\(`\[after-pack\] node_modules\/\$\{tree\.requireModule\} missing/);
});
