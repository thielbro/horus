// Assembles the Next standalone output into a single tree the Electron build can ship.
//
// Mirrors the Dockerfile's runner stage: .next/standalone is the base, then public/
// and .next/static are copied in alongside server.js. Output goes to desktop/.staging/server,
// which electron-builder pulls in via extraResources (see electron-builder.yml).
//
// Run AFTER `next build`:  node desktop/prepare-standalone.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');
const staticDir = path.join(root, '.next', 'static');
const publicDir = path.join(root, 'public');
const out = path.join(__dirname, '.staging', 'server');

function fail(msg) {
  console.error('[prepare-standalone] ' + msg);
  process.exit(1);
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
