// OSIRIS Desktop — Electron main process.
//
// Three run modes, resolved from env:
//   OSIRIS_URL=<url>   → load that URL (used by `desktop:dev` and embed smoke tests)
//   OSIRIS_DEV=1       → load http://localhost:3000 (a running `next dev`)
//   (packaged)         → fork the embedded Next standalone server, then load it
//   OSIRIS_SMOKE=1     → after first load, log OSIRIS_SMOKE_OK and quit (headless check)
//
// The embedded-server path mirrors the Dockerfile: run `.next/standalone/server.js`
// with PORT + HOSTNAME. Electron's main process is a Node runtime, so we fork that
// same server.js (via ELECTRON_RUN_AS_NODE) instead of shipping a separate node.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { fork } = require('child_process');
const { buildEngineEnv } = require('./runtime-config');

let win = null;
let serverChild = null;
let logFd = null;
let embeddedServerUrl = null;
let isQuitting = false;
let serverRestartAttempts = 0;
let serverStableResetTimer = null;
let rendererReloadAttempts = 0;
let rendererReloadTimer = null;
let lastRendererCrashAt = 0;

const SMOKE = !!process.env.OSIRIS_SMOKE;
const MAX_SERVER_RESTARTS = 3;
const SERVER_RESTART_BASE_MS = 1000;
const SERVER_RESTART_MAX_MS = 10000;
const SERVER_STABLE_RESET_MS = 5 * 60 * 1000;
const MAX_RENDERER_RELOADS = 5;
const RENDERER_RELOAD_BASE_MS = 500;
const RENDERER_RELOAD_MAX_MS = 10000;
const RENDERER_RELOAD_RESET_MS = 60 * 1000;

// Smoke outcome marker — a packaged Windows GUI exe doesn't attach stdout, so the
// verifier reads this file (path via OSIRIS_SMOKE_OUT) and/or the process exit code.
function writeSmoke(tag) {
  const out = process.env.OSIRIS_SMOKE_OUT;
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
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(full, null, 2));
    return true;
  } catch (e) {
    console.error('[osiris] settings write failed:', e.message);
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

function stopEmbeddedServer() {
  if (serverStableResetTimer) {
    clearTimeout(serverStableResetTimer);
    serverStableResetTimer = null;
  }
  if (serverChild) {
    try {
      serverChild.kill();
    } catch {
      /* ignore */
    }
    serverChild = null;
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
    console.error('[osiris] embedded server restart limit reached');
    return;
  }
  const delay = Math.min(SERVER_RESTART_BASE_MS * 2 ** serverRestartAttempts, SERVER_RESTART_MAX_MS);
  serverRestartAttempts++;
  setTimeout(async () => {
    try {
      const url = await startEmbeddedServer();
      if (win && !win.isDestroyed()) await win.loadURL(url);
    } catch (err) {
      console.error('[osiris] embedded server restart failed:', err);
      scheduleEmbeddedServerRestart();
    }
  }, delay).unref?.();
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
    logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n[${new Date().toISOString()}] starting ${serverJs} on :${port}\n`);
    stdio = ['ignore', logFd, logFd, 'ipc'];
  } catch {
    /* fall back to inherit */
  }

  // User-configured API keys (Settings panel) override process.env for the engine.
  const apiKeys = readSettingsFile().apiKeys || {};
  const engineEnv = buildEngineEnv(process.env, apiKeys);

  serverChild = fork(serverJs, [], {
    cwd: path.dirname(serverJs),
    env: {
      ...engineEnv,
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
    console.error('[osiris] embedded server error:', err);
    if (!releaseChild()) return;
    scheduleEmbeddedServerRestart();
  });
  serverChild.on('exit', (code) => {
    console.error('[osiris] embedded server exited:', code);
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
    console.error('[osiris] renderer reload limit reached after:', reason);
    win.loadFile(path.join(__dirname, 'splash.html')).catch((err) => {
      console.error('[osiris] failed to load fallback splash:', err);
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
  if (process.env.OSIRIS_URL) return process.env.OSIRIS_URL;
  if (process.env.OSIRIS_DEV) return 'http://localhost:3000';
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
    console.error('[osiris] renderer process gone:', details.reason);
    scheduleRendererReload(details.reason);
  });
  win.webContents.on('crashed', () => {
    console.error('[osiris] renderer crashed');
    scheduleRendererReload('crashed');
  });

  if (SMOKE) {
    win.webContents.on('did-finish-load', () => {
      console.log('OSIRIS_SMOKE_OK');
      writeSmoke('OK');
      setTimeout(() => app.quit(), 200);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('OSIRIS_SMOKE_FAIL', code, desc, url);
      writeSmoke('FAIL ' + code + ' ' + desc);
      quitWithCode(1);
    });
    const smokeTimeout = setTimeout(() => {
      console.error('OSIRIS_SMOKE_TIMEOUT');
      writeSmoke('TIMEOUT');
      quitWithCode(2);
    }, 50000);
    smokeTimeout.unref?.();
  }

  let target = null;
  try {
    target = await resolveTarget();
  } catch (err) {
    console.error('[osiris]', err.message);
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
  ipcMain.handle('osiris:version', () => app.getVersion());
  ipcMain.handle('osiris:getPath', (_e, name) => {
    try {
      return app.getPath(name);
    } catch {
      return null;
    }
  });
  ipcMain.handle('settings:getAll', () => readSettingsFile());
  ipcMain.handle('settings:set', (_e, full) => writeSettingsFile(full));
  ipcMain.handle('osiris:relaunch', () => {
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
        console.error('[osiris] failed to recreate window:', err);
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
          console.error('[osiris] failed to create window on activate:', err);
        });
      }
    });
  }).catch((err) => {
    console.error('[osiris] startup failed:', err);
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
    console.error('[osiris] unhandled rejection:', err);
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
  process.on('uncaughtException', (err) => {
    console.error('[osiris] uncaught exception:', err);
    isQuitting = true;
    stopEmbeddedServer();
    app.quit();
  });
}
