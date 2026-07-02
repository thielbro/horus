// HORUS Desktop — Electron main process.
//
// Three run modes, resolved from env:
//   HORUS_URL=<url>   → load that URL (used by `desktop:dev` and embed smoke tests)
//   HORUS_DEV=1       → load http://localhost:3000 (a running `next dev`)
//   (packaged)         → fork the embedded Next standalone server, then load it
//   HORUS_SMOKE=1     → after first load, log HORUS_SMOKE_OK and quit (headless check)
//
// The embedded-server path mirrors the Dockerfile: run `.next/standalone/server.js`
// with PORT + HOSTNAME. Electron's main process is a Node runtime, so we fork that
// same server.js (via ELECTRON_RUN_AS_NODE) instead of shipping a separate node.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const { buildEngineEnv } = require('./runtime-config');

let win = null;
let serverChild = null;
let logFd = null;
let embeddedServerUrl = null;
let isQuitting = false;
let serverRestartAttempts = 0;
let serverStableResetTimer = null;
let serverRestartTimer = null;
let rendererReloadAttempts = 0;
let rendererReloadTimer = null;
let lastRendererCrashAt = 0;

const SMOKE = !!process.env.HORUS_SMOKE;
const MAX_SERVER_RESTARTS = 3;
const SERVER_RESTART_BASE_MS = 1000;
const SERVER_RESTART_MAX_MS = 10000;
const SERVER_STABLE_RESET_MS = 5 * 60 * 1000;
const MAX_BACKEND_RESTARTS = 3;
const BACKEND_RESTART_BASE_MS = 1000;
const BACKEND_RESTART_MAX_MS = 10000;
const MAX_SETTINGS_BYTES = 256 * 1024;

// Bundled OSINT backends (scanner = RECON, intel = ontology engine, live-feed = live
// activation broker). Each is a tiny
// self-contained Express app forked the same way as the Next server (Electron's node via
// ELECTRON_RUN_AS_NODE), shipped under resources/<dir> by desktop/after-pack.js.
let managedBackends = [];
let backendUrlOverrides = null;
const MAX_RENDERER_RELOADS = 5;
const RENDERER_RELOAD_BASE_MS = 500;
const RENDERER_RELOAD_MAX_MS = 10000;
const RENDERER_RELOAD_RESET_MS = 60 * 1000;

// Smoke outcome marker — a packaged Windows GUI exe doesn't attach stdout, so the
// verifier reads this file (path via HORUS_SMOKE_OUT) and/or the process exit code.
function writeSmoke(tag) {
  const out = process.env.HORUS_SMOKE_OUT;
  if (out) {
    try {
      fs.writeFileSync(out, tag);
    } catch {
      /* ignore */
    }
  }
}

function quitWithCode(code) {
  process.exitCode = code;
  isQuitting = true;
  stopEmbeddedServer();
  app.quit();
}

// ── Settings (userData/settings.json) ──
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettingsFile(full) {
  let tmpPath = null;
  try {
    if (!full || typeof full !== 'object' || Array.isArray(full)) {
      throw new Error('settings payload must be an object');
    }
    const payload = JSON.stringify(full, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_SETTINGS_BYTES) {
      throw new Error(`settings payload exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const dir = path.dirname(settingsPath());
    fs.mkdirSync(dir, { recursive: true });
    tmpPath = path.join(dir, `.settings-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, payload);
    fs.renameSync(tmpPath, settingsPath());
    return true;
  } catch (e) {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    console.error('[horus] settings write failed:', e.message);
    return false;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  const maxAttempts = Math.ceil(timeoutMs / 300);
  let attempts = 0;
  return new Promise((resolve, reject) => {
    const tick = () => {
      attempts++;
      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });
      req.setTimeout(3000, () => {
        req.destroy();
      });
      req.on('error', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs || attempts >= maxAttempts) reject(new Error('embedded server did not start in time'));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

function isNonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Resolve a bundled backend's directory: packaged → resources/<dir>; dev → project/<dir>.
function backendDir(dirName) {
  return app.isPackaged
    ? path.join(process.resourcesPath, dirName)
    : path.join(__dirname, '..', dirName);
}

function armBackendStableReset(state) {
  if (state.stableTimer) clearTimeout(state.stableTimer);
  state.stableTimer = setTimeout(() => {
    state.attempts = 0;
    state.stableTimer = null;
  }, SERVER_STABLE_RESET_MS);
  state.stableTimer.unref?.();
}

function scheduleBackendRestart(state) {
  if (isQuitting) return;
  if (state.attempts >= MAX_BACKEND_RESTARTS) {
    console.error(`[horus] backend ${state.id} restart limit reached`);
    return;
  }
  const delay = Math.min(BACKEND_RESTART_BASE_MS * 2 ** state.attempts, BACKEND_RESTART_MAX_MS);
  state.attempts++;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    forkBackend(state).catch((err) => {
      console.error(`[horus] backend ${state.id} restart failed:`, err.message);
      scheduleBackendRestart(state);
    });
  }, delay);
  state.restartTimer.unref?.();
}

// Open a log file in append mode, first rotating it to <name>.1 if it exceeds maxBytes.
// Keeps one previous generation so logs can't grow unbounded and eventually fill the disk.
function openRotatingLog(logPath, maxBytes = 10 * 1024 * 1024) {
  try {
    const st = fs.statSync(logPath);
    if (st.size > maxBytes) {
      const rotated = `${logPath}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch { /* ignore */ }
      fs.renameSync(logPath, rotated);
    }
  } catch { /* no existing file → nothing to rotate */ }
  return fs.openSync(logPath, 'a');
}

// Fork (or re-fork) one backend on its already-assigned port so the URL handed to the Next
// server stays valid across crashes. Resolves once its /health responds.
async function forkBackend(state) {
  if (state.child) return;
  const entry = path.join(backendDir(state.dirName), state.entry);
  if (!fs.existsSync(entry)) throw new Error(`backend entry not found: ${entry}`);

  let stdio = ['ignore', 'inherit', 'inherit', 'ipc'];
  try {
    const logPath = path.join(app.getPath('userData'), `${state.id}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    state.logFd = openRotatingLog(logPath);
    fs.writeSync(state.logFd, `\n[${new Date().toISOString()}] starting ${state.id} on :${state.port}\n`);
    stdio = ['ignore', state.logFd, state.logFd, 'ipc'];
  } catch {
    /* fall back to inherit */
  }

  const child = fork(entry, [], {
    cwd: backendDir(state.dirName),
    env: {
      ...process.env,
      ...state.extraEnv,
      NODE_ENV: 'production',
      [state.portEnv]: String(state.port),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio,
  });
  state.child = child;

  let handled = false;
  const releaseChild = () => {
    if (handled) return false;
    handled = true;
    state.child = null;
    if (state.logFd !== null) {
      try { fs.closeSync(state.logFd); } catch { /* ignore */ }
      state.logFd = null;
    }
    return true;
  };
  child.on('error', (err) => {
    console.error(`[horus] backend ${state.id} error:`, err);
    if (releaseChild()) scheduleBackendRestart(state);
  });
  child.on('exit', (code) => {
    console.error(`[horus] backend ${state.id} exited:`, code);
    if (releaseChild() && !isQuitting) scheduleBackendRestart(state);
  });

  await waitForServer(`http://127.0.0.1:${state.port}${state.healthPath}`, 30000);
  armBackendStableReset(state);
}

// Start the bundled backends the app should manage and return the engine-env overrides
// (their resolved URLs + the scanner shared key). Idempotent: a second call (e.g. on a
// Next-server restart) returns the cached overrides without re-forking. A user-configured
// SCANNER_URL / INTEL_URL / LIVE_FEED_URL opts that backend out; we don't launch a bundled copy.
async function startManagedBackends(apiKeys) {
  if (backendUrlOverrides) return backendUrlOverrides;
  const overrides = {};
  const specs = [];

  if (!isNonBlank(apiKeys.SCANNER_URL)) {
    // The /api/scanner proxy 503s without a key, so provision a shared secret for both
    // sides when the user hasn't set one — RECON then works zero-config.
    const key = isNonBlank(apiKeys.SCANNER_KEY) ? apiKeys.SCANNER_KEY.trim() : crypto.randomUUID();
    specs.push({
      id: 'scanner', dirName: 'scanner', entry: 'server.js', healthPath: '/health',
      portEnv: 'PORT', extraEnv: { HORUS_KEY: key },
      // SCANNER_ALLOW_DEEP un-gates the heavier ports/deep scans for the bundled local
      // scanner only (the public web build never sets it).
      urls: (port) => ({ SCANNER_URL: `http://127.0.0.1:${port}`, SCANNER_KEY: key, SCANNER_ALLOW_DEEP: '1' }),
    });
  }
  if (!isNonBlank(apiKeys.INTEL_URL)) {
    specs.push({
      id: 'intel', dirName: 'intel', entry: 'server.js', healthPath: '/health',
      portEnv: 'INTEL_PORT', extraEnv: {},
      urls: (port) => ({ INTEL_URL: `http://127.0.0.1:${port}` }),
    });
  }
  if (!isNonBlank(apiKeys.LIVE_FEED_URL)) {
    specs.push({
      id: 'live-feed', dirName: 'live-feed', entry: 'server.js', healthPath: '/health',
      portEnv: 'PORT', extraEnv: { AIS_API_KEY: apiKeys.AIS_API_KEY || process.env.AIS_API_KEY || '' },
      urls: (port) => ({ LIVE_FEED_URL: `http://127.0.0.1:${port}` }),
    });
  }

  for (const spec of specs) {
    try {
      const port = await getFreePort();
      const state = { ...spec, port, child: null, logFd: null, attempts: 0, stableTimer: null, restartTimer: null };
      await forkBackend(state);
      managedBackends.push(state);
      Object.assign(overrides, spec.urls(port));
      console.log(`[horus] backend ${spec.id} ready on :${port}`);
    } catch (err) {
      // Non-fatal: the Next app still loads; only this backend's feature is unavailable.
      console.error(`[horus] backend ${spec.id} failed to start:`, err.message);
    }
  }

  backendUrlOverrides = overrides;
  return overrides;
}

function stopManagedBackends() {
  for (const state of managedBackends) {
    if (state.stableTimer) {
      clearTimeout(state.stableTimer);
      state.stableTimer = null;
    }
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.child) {
      const child = state.child;
      state.child = null;
      // SIGTERM for a graceful exit, then SIGKILL if it's still alive after 5s so a hung
      // backend can't linger as a zombie. unref so the timer never keeps the app alive.
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      killTimer.unref?.();
      child.once?.('exit', () => clearTimeout(killTimer));
    }
    if (state.logFd !== null) {
      try { fs.closeSync(state.logFd); } catch { /* ignore */ }
      state.logFd = null;
    }
  }
  managedBackends = [];
  backendUrlOverrides = null;
}

function stopEmbeddedServer() {
  if (serverStableResetTimer) {
    clearTimeout(serverStableResetTimer);
    serverStableResetTimer = null;
  }
  if (serverRestartTimer) {
    clearTimeout(serverRestartTimer);
    serverRestartTimer = null;
  }
  if (serverChild) {
    const child = serverChild;
    serverChild = null;
    // SIGTERM then SIGKILL-after-5s so a hung Next server child can't become a zombie.
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    killTimer.unref?.();
    child.once?.('exit', () => clearTimeout(killTimer));
  }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    logFd = null;
  }
  embeddedServerUrl = null;
  // Tear down the bundled backends alongside the server (quit / relaunch only — this is
  // not called on the Next-server auto-restart path, so backends survive that).
  stopManagedBackends();
  stopWazeProxy();
}

// ── Waze browser proxy (packaged builds only) ──
// Playwright is a devDependency and is unavailable in production. Instead we keep a
// hidden BrowserWindow loaded with the Waze live map so it has real session cookies and
// a valid reCAPTCHA context, then serve a tiny HTTP API on localhost that the Next.js
// child process calls to execute GeoRSS fetches from within that page.
let wazeProxyServer = null;
let wazeWindow = null;
let wazePageReady = false;
let wazePageLoadedAt = 0;
let wazeEnsureInFlight = null;
const WAZE_LIVE_MAP_URL = 'https://www.waze.com/live-map';
const WAZE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36';
// The live-map page's reCAPTCHA/session context goes stale after a handful of GeoRSS
// fetches — Waze starts answering 403. Reload proactively once the page ages past this,
// and on demand whenever a fetch comes back unauthorized (see the request handler).
const WAZE_PAGE_MAX_AGE_MS = 4 * 60_000;
// Hard ceiling on any single page navigation / in-page fetch so a hung reCAPTCHA or a
// never-resolving fetch can't permanently wedge the proxy (the original failure mode:
// only a full app restart cleared it).
const WAZE_EXEC_TIMEOUT_MS = 35_000;
// Statuses that mean "the page's session/reCAPTCHA is stale" — reload and retry.
const WAZE_STALE_STATUSES = new Set([401, 403, 429]);

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function wazePageIsStale() {
  return !wazePageReady || (Date.now() - wazePageLoadedAt) > WAZE_PAGE_MAX_AGE_MS;
}

async function loadWazePage() {
  if (!wazeWindow || wazeWindow.isDestroyed()) {
    wazeWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    wazeWindow.webContents.setUserAgent(WAZE_UA);
    wazeWindow.on('closed', () => { wazeWindow = null; wazePageReady = false; });
  }
  wazePageReady = false;
  await withTimeout(wazeWindow.loadURL(WAZE_LIVE_MAP_URL), WAZE_EXEC_TIMEOUT_MS, 'Waze loadURL');
  // Wait up to 30s for reCAPTCHA enterprise to initialise; proceed anyway if it doesn't.
  await wazeWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      const deadline = Date.now() + 30000;
      (function check() {
        if (globalThis.grecaptcha && globalThis.grecaptcha.enterprise) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(check, 500);
      })();
    })
  `);
  wazePageReady = true;
  wazePageLoadedAt = Date.now();
}

// Ensure a fresh-enough loaded page exists. Concurrent callers (the scraper fetches tiles
// 2-at-a-time) share one in-flight (re)load so the window isn't navigated out from under a
// sibling request mid-fetch.
async function ensureWazePage() {
  if (wazeWindow && !wazeWindow.isDestroyed() && !wazePageIsStale()) return;
  if (wazeEnsureInFlight) return wazeEnsureInFlight;
  wazeEnsureInFlight = loadWazePage()
    .catch((err) => { console.error('[horus] Waze page load failed:', err.message); throw err; })
    .finally(() => { wazeEnsureInFlight = null; });
  return wazeEnsureInFlight;
}

// Execute the GeoRSS fetch from inside the live-map page (real cookies + a fresh reCAPTCHA
// token per call). The URL is serialised, not eval'd, so request data is never executed.
async function wazeFetchInPage(url) {
  const safeUrl = JSON.stringify(url);
  return withTimeout(
    wazeWindow.webContents.executeJavaScript(`
      (async () => {
        const gon = JSON.parse(document.querySelector('#gon')?.textContent || '{}');
        const recaptcha = globalThis.grecaptcha;
        let token = null;
        if (gon.recaptchaActionSiteKey && recaptcha && recaptcha.enterprise) {
          token = await new Promise((resolve, reject) => {
            recaptcha.enterprise.ready(() => {
              recaptcha.enterprise.execute(gon.recaptchaActionSiteKey, { action: 'livemap' }).then(resolve, reject);
            });
          });
        }
        const headers = { 'Accept': 'application/json, text/plain, */*' };
        if (token) headers['x-recaptcha-token'] = token;
        const r = await fetch(${safeUrl}, { headers, credentials: 'include' });
        return { ok: r.ok, status: r.status, text: await r.text() };
      })()
    `),
    WAZE_EXEC_TIMEOUT_MS,
    'Waze fetch',
  );
}

async function startWazeProxy() {
  if (wazeProxyServer) return wazeProxyServer.port;
  const port = await getFreePort();

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/fetch') {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (typeof url !== 'string' || !url.startsWith('https://www.waze.com/')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid url' })); return;
        }

        // Up to two attempts: a stale page (403/429) or a thrown/timed-out fetch on the
        // first try invalidates the page and forces a fresh reload before the retry. This
        // is the core fix — previously a 403 was passed straight back and the stale page
        // was reused on every later request, so the layer stayed broken until app restart.
        let result;
        for (let attempt = 0; attempt < 2; attempt++) {
          await ensureWazePage();
          try {
            result = await wazeFetchInPage(url);
          } catch (err) {
            wazePageReady = false; // page is suspect — reload before retrying / next request
            if (attempt === 0) continue;
            throw err;
          }
          if (!result.ok && WAZE_STALE_STATUSES.has(result.status)) {
            wazePageReady = false; // session went stale — reload so this and the next request recover
            if (attempt === 0) continue;
          }
          break;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        wazePageReady = false; // force re-navigation on next request
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  wazeProxyServer = { server, port };
  console.log(`[horus] Waze proxy ready on :${port}`);
  return port;
}

function stopWazeProxy() {
  if (wazeProxyServer) {
    try { wazeProxyServer.server.close(); } catch { /* ignore */ }
    wazeProxyServer = null;
  }
  if (wazeWindow && !wazeWindow.isDestroyed()) {
    try { wazeWindow.destroy(); } catch { /* ignore */ }
    wazeWindow = null;
  }
  wazePageReady = false;
  wazePageLoadedAt = 0;
  wazeEnsureInFlight = null;
}

function armServerStableReset() {
  if (serverStableResetTimer) clearTimeout(serverStableResetTimer);
  serverStableResetTimer = setTimeout(() => {
    serverRestartAttempts = 0;
    serverStableResetTimer = null;
  }, SERVER_STABLE_RESET_MS);
  serverStableResetTimer.unref?.();
}

function scheduleEmbeddedServerRestart() {
  if (isQuitting || !app.isPackaged) return;
  if (serverRestartAttempts >= MAX_SERVER_RESTARTS) {
    console.error('[horus] embedded server restart limit reached');
    return;
  }
  const delay = Math.min(SERVER_RESTART_BASE_MS * 2 ** serverRestartAttempts, SERVER_RESTART_MAX_MS);
  serverRestartAttempts++;
  if (serverRestartTimer) clearTimeout(serverRestartTimer);
  serverRestartTimer = setTimeout(async () => {
    serverRestartTimer = null;
    try {
      const url = await startEmbeddedServer();
      if (win && !win.isDestroyed()) await win.loadURL(url);
    } catch (err) {
      console.error('[horus] embedded server restart failed:', err);
      scheduleEmbeddedServerRestart();
    }
  }, delay);
  serverRestartTimer.unref?.();
}

// Fork the Next standalone server (packaged: resources/server; dev: project .next/standalone).
async function startEmbeddedServer() {
  if (serverChild) return embeddedServerUrl;
  const serverJs = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'server.js')
    : path.join(__dirname, '..', '.next', 'standalone', 'server.js');

  if (!fs.existsSync(serverJs)) {
    throw new Error(`standalone server not found at ${serverJs} — run "next build" (+ desktop:prepare) first`);
  }

  const port = await getFreePort();

  // Pipe the forked server's stdout/stderr to a log file — a packaged GUI exe has no
  // attached console, so 'inherit' would discard startup errors. Lives in userData.
  let stdio = ['ignore', 'inherit', 'inherit', 'ipc'];
  try {
    if (logFd !== null) fs.closeSync(logFd);
    const logPath = path.join(app.getPath('userData'), 'server.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = openRotatingLog(logPath);
    fs.writeSync(logFd, `\n[${new Date().toISOString()}] starting ${serverJs} on :${port}\n`);
    stdio = ['ignore', logFd, logFd, 'ipc'];
  } catch {
    /* fall back to inherit */
  }

  // User-configured API keys (Settings panel) override process.env for the engine.
  const apiKeys = readSettingsFile().apiKeys || {};
  // Launch the bundled scanner/intel backends (idempotent) and point the engine at them.
  const backendOverrides = await startManagedBackends(apiKeys);
  const engineEnv = buildEngineEnv(process.env, apiKeys, backendOverrides);

  // Start the Waze browser proxy so the packaged build can bypass Waze's server-side
  // block. In dev, Playwright handles this; in production Playwright is unavailable so
  // the proxy routes fetches through a real hidden BrowserWindow instead.
  let wazeProxyEnv = {};
  try {
    const wazePort = await startWazeProxy();
    wazeProxyEnv = { WAZE_ELECTRON_PROXY: `http://127.0.0.1:${wazePort}` };
  } catch (err) {
    console.error('[horus] Waze proxy failed to start (Waze alerts will be unavailable):', err.message);
  }

  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    env: {
      ...engineEnv,
      ...wazeProxyEnv,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ELECTRON_RUN_AS_NODE: '1', // run Electron's node as plain node
    },
    stdio,
  });
  let childHandled = false;
  const releaseChild = () => {
    if (childHandled) return false;
    childHandled = true;
    serverChild = null;
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      logFd = null;
    }
    return true;
  };
  serverChild.on('error', (err) => {
    console.error('[horus] embedded server error:', err);
    if (!releaseChild()) return;
    scheduleEmbeddedServerRestart();
  });
  serverChild.on('exit', (code) => {
    console.error('[horus] embedded server exited:', code);
    if (!releaseChild()) return;
    if (!isQuitting) scheduleEmbeddedServerRestart();
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url, 40000);
  embeddedServerUrl = url;
  armServerStableReset();
  return url;
}

function scheduleRendererReload(reason) {
  if (!win || win.isDestroyed() || isQuitting) return;
  const now = Date.now();
  if (now - lastRendererCrashAt > RENDERER_RELOAD_RESET_MS) rendererReloadAttempts = 0;
  lastRendererCrashAt = now;

  if (rendererReloadAttempts >= MAX_RENDERER_RELOADS) {
    console.error('[horus] renderer reload limit reached after:', reason);
    win.loadFile(path.join(__dirname, 'splash.html')).catch((err) => {
      console.error('[horus] failed to load fallback splash:', err);
    });
    return;
  }

  const delay = Math.min(RENDERER_RELOAD_BASE_MS * 2 ** rendererReloadAttempts, RENDERER_RELOAD_MAX_MS);
  rendererReloadAttempts++;
  if (rendererReloadTimer) clearTimeout(rendererReloadTimer);
  rendererReloadTimer = setTimeout(() => {
    rendererReloadTimer = null;
    if (win && !win.isDestroyed()) win.reload();
  }, delay);
  rendererReloadTimer.unref?.();
}

async function resolveTarget() {
  if (process.env.HORUS_URL) return process.env.HORUS_URL;
  if (process.env.HORUS_DEV) return 'http://localhost:3000';
  if (app.isPackaged) return startEmbeddedServer();
  return null; // unpackaged with no URL → splash (shell smoke)
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#06060a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.once('closed', () => {
    if (rendererReloadTimer) {
      clearTimeout(rendererReloadTimer);
      rendererReloadTimer = null;
    }
    win = null;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[horus] renderer process gone:', details.reason);
    scheduleRendererReload(details.reason);
  });
  win.webContents.on('crashed', () => {
    console.error('[horus] renderer crashed');
    scheduleRendererReload('crashed');
  });

  if (SMOKE) {
    // Declared before the handlers so a successful/failed load can clear it — otherwise the
    // 50s timeout could fire after an OK and overwrite the smoke file with TIMEOUT (false CI fail).
    let smokeTimeout = null;
    win.webContents.on('did-finish-load', () => {
      if (smokeTimeout) { clearTimeout(smokeTimeout); smokeTimeout = null; }
      console.log('HORUS_SMOKE_OK');
      writeSmoke('OK');
      setTimeout(() => app.quit(), 200);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (smokeTimeout) { clearTimeout(smokeTimeout); smokeTimeout = null; }
      console.error('HORUS_SMOKE_FAIL', code, desc, url);
      writeSmoke('FAIL ' + code + ' ' + desc);
      quitWithCode(1);
    });
    smokeTimeout = setTimeout(() => {
      console.error('HORUS_SMOKE_TIMEOUT');
      writeSmoke('TIMEOUT');
      quitWithCode(2);
    }, 50000);
    smokeTimeout.unref?.();
  }

  let target = null;
  try {
    target = await resolveTarget();
  } catch (err) {
    console.error('[horus]', err.message);
    // In smoke mode a failed embedded server must FAIL, not silently fall back to
    // the splash (which would load fine and report a false OK).
    if (SMOKE) {
      writeSmoke('SERVER_FAIL ' + err.message);
      quitWithCode(1);
      return;
    }
  }

  if (target) await win.loadURL(target);
  else await win.loadFile(path.join(__dirname, 'splash.html'));
}

function registerIpc() {
  ipcMain.handle('horus:version', () => app.getVersion());
  ipcMain.handle('horus:getPath', (_e, name) => {
    try {
      return app.getPath(name);
    } catch {
      return null;
    }
  });
  ipcMain.handle('settings:getAll', () => readSettingsFile());
  ipcMain.handle('settings:set', (_e, full) => writeSettingsFile(full));
  ipcMain.handle('horus:relaunch', () => {
    isQuitting = true;
    stopEmbeddedServer();
    app.relaunch();
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      createWindow().catch((err) => {
        console.error('[horus] failed to recreate window:', err);
      });
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('[horus] failed to create window on activate:', err);
        });
      }
    });
  }).catch((err) => {
    console.error('[horus] startup failed:', err);
    quitWithCode(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopEmbeddedServer();
  });

  process.on('SIGTERM', () => {
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
  process.on('SIGINT', () => {
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
  process.on('unhandledRejection', (err) => {
    console.error('[horus] unhandled rejection:', err);
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
  process.on('uncaughtException', (err) => {
    console.error('[horus] uncaught exception:', err);
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
}
