import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const releaseDir = join(root, 'desktop', 'release');

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function readText(path) {
  return readFileSync(join(root, path), 'utf8');
}

function parseLatestYml(text) {
  const scalar = (key) => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const url = text.match(/^  - url:\s*(.+)$/m)?.[1]?.trim();
  const size = text.match(/^    size:\s*(\d+)$/m)?.[1]?.trim();
  return {
    version: scalar('version'),
    url,
    path: scalar('path'),
    sha512: scalar('sha512'),
    size: Number(size),
  };
}

function parseSetupVersion(fileName) {
  return fileName.match(/^HORUS[ -]Setup[ -](\d+\.\d+\.\d+)\.exe$/)?.[1] ?? null;
}

function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const delta = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

test('desktop Windows release artifacts and updater metadata use the package version', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);

  const builderConfig = readText('electron-builder.yml');
  assert.match(builderConfig, /artifactName:\s*\$\{productName\}-Setup-\$\{version\}\.\$\{ext\}/);

  if (!existsSync(releaseDir)) return;

  const installerVersions = readdirSync(releaseDir)
    .map((name) => parseSetupVersion(name))
    .filter(Boolean)
    .sort(compareVersions);

  if (installerVersions.length > 0) {
    assert.equal(installerVersions.at(-1), pkg.version);
  }

  const latestPath = join(releaseDir, 'latest.yml');
  if (!existsSync(latestPath)) return;

  const latest = parseLatestYml(readFileSync(latestPath, 'utf8'));
  const expectedInstaller = `HORUS-Setup-${pkg.version}.exe`;
  const installerPath = join(releaseDir, expectedInstaller);

  assert.equal(latest.version, pkg.version);
  assert.equal(latest.url, expectedInstaller);
  assert.equal(latest.path, expectedInstaller);
  assert.ok(existsSync(installerPath), `missing release installer ${expectedInstaller}`);
  assert.equal(statSync(installerPath).size, latest.size);
  assert.equal(sha512(installerPath), latest.sha512);
  assert.ok(existsSync(`${installerPath}.blockmap`), `missing blockmap for ${expectedInstaller}`);
});
