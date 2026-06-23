// Assembles the Next standalone output into a single tree the Electron build can ship.
//
// Mirrors the Dockerfile's runner stage: .next/standalone is the base, then public/
// and .next/static are copied in alongside server.js. Output goes to desktop/.staging/server,
// which after-pack.js copies into resources/server (see electron-builder.yml).
//
// It also stages the two bundled OSINT backends (scanner = RECON, intel = ontology engine)
// into desktop/.staging/{scanner,intel} with their production node_modules installed, so the
// packaged app can fork them locally. after-pack.js copies those into resources/{scanner,intel}.
//
// Run AFTER `next build`:  node desktop/prepare-standalone.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');
const staticDir = path.join(root, '.next', 'static');
const publicDir = path.join(root, 'public');
const out = path.join(__dirname, '.staging', 'server');

function fail(msg) {
  console.error('[prepare-standalone] ' + msg);
  process.exit(1);
}

// Install a staged backend's production deps. Tries the lockfile install first (respecting
// the user's npm config, e.g. a private registry), then a lockfile-tolerant install, and as
// a last resort an isolated user config — which sidesteps a global ~/.npmrc that injects an
// install-breaking flag (observed: `allow-scripts=…`, rejected for project-scoped installs).
function installProdDeps(dest, name) {
  const run = (args, env) => execSync(`npm ${args}`, { cwd: dest, stdio: 'inherit', env });
  try {
    run('ci --omit=dev --no-audit --no-fund', process.env);
    return;
  } catch {
    console.warn(`[prepare-standalone] ${name}: npm ci failed; retrying with npm install`);
  }
  try {
    run('install --omit=dev --no-audit --no-fund', process.env);
    return;
  } catch {
    console.warn(`[prepare-standalone] ${name}: install failed under current npm config; retrying with an isolated user config`);
  }
  const isolated = path.join(dest, '.staging-npmrc');
  fs.writeFileSync(isolated, '');
  // `npm run` also exports the offending setting as an env var (npm_config_allow_scripts),
  // which an isolated user config alone won't shake — strip it for this attempt.
  const cleanEnv = { ...process.env, NPM_CONFIG_USERCONFIG: isolated };
  for (const key of Object.keys(cleanEnv)) {
    if (/^npm_config_allow[_-]?scripts$/i.test(key)) delete cleanEnv[key];
  }
  try {
    run('install --omit=dev --no-audit --no-fund', cleanEnv);
  } finally {
    try { fs.rmSync(isolated, { force: true }); } catch { /* ignore */ }
  }
}

// Stage one backend: copy its runtime files into desktop/.staging/<name> and install only
// production deps there (express — pure JS, so the tree is cross-platform portable).
function stageBackend(name, files) {
  const srcDir = path.join(root, name);
  const dest = path.join(__dirname, '.staging', name);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const from = path.join(srcDir, f);
    if (!fs.existsSync(from)) fail(`${name}/${f} missing — cannot stage backend`);
    fs.copyFileSync(from, path.join(dest, f));
  }

  console.log(`[prepare-standalone] installing ${name} production deps…`);
  installProdDeps(dest, name);

  if (!fs.existsSync(path.join(dest, 'node_modules', 'express'))) {
    fail(`${name} staging is missing node_modules/express after install`);
  }
  console.log('[prepare-standalone] assembled →', path.relative(root, dest));
}

if (!fs.existsSync(standalone)) fail('.next/standalone missing — run `next build` first (output: "standalone" is set in next.config.ts)');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1) base: the standalone server + its minimal node_modules
fs.cpSync(standalone, out, { recursive: true });

// 2) static assets the standalone server does NOT bundle
if (fs.existsSync(staticDir)) {
  fs.cpSync(staticDir, path.join(out, '.next', 'static'), { recursive: true });
}
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(out, 'public'), { recursive: true });
}

if (!fs.existsSync(path.join(out, 'server.js'))) fail('assembled tree has no server.js — unexpected standalone layout');

console.log('[prepare-standalone] assembled →', path.relative(root, out));

// Bundled OSINT backends. intel additionally needs sources.js (required by server.js).
stageBackend('scanner', ['server.js', 'portscan.js', 'package.json', 'package-lock.json']);
stageBackend('intel', ['server.js', 'sources.js', 'package.json', 'package-lock.json']);
