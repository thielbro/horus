const assert = require('node:assert/strict');
const test = require('node:test');

const { buildEngineEnv } = require('./runtime-config');

test('buildEngineEnv defaults desktop service endpoints to localhost', () => {
  const env = buildEngineEnv({}, {});

  assert.equal(env.INTEL_URL, 'http://127.0.0.1:4000');
  assert.equal(env.SCANNER_URL, 'http://127.0.0.1:7700');
});

test('buildEngineEnv lets saved settings override process env and defaults', () => {
  const env = buildEngineEnv(
    {
      INTEL_URL: 'http://env-intel:4000',
      SCANNER_URL: 'http://env-scanner:7700',
      SCANNER_KEY: 'env-key',
    },
    {
      INTEL_URL: 'http://settings-intel:4000',
      SCANNER_KEY: 'settings-key',
    },
  );

  assert.equal(env.INTEL_URL, 'http://settings-intel:4000');
  assert.equal(env.SCANNER_URL, 'http://env-scanner:7700');
  assert.equal(env.SCANNER_KEY, 'settings-key');
});

test('buildEngineEnv ignores blank saved settings', () => {
  const env = buildEngineEnv(
    { SCANNER_KEY: 'env-key' },
    { SCANNER_KEY: '   ', SCANNER_URL: '' },
  );

  assert.equal(env.SCANNER_KEY, 'env-key');
  assert.equal(env.SCANNER_URL, 'http://127.0.0.1:7700');
});

test('buildEngineEnv applies launch overrides above defaults', () => {
  // Bundled backends resolve to dynamic ports + an auto-provisioned scanner key.
  const env = buildEngineEnv(
    {},
    {},
    { SCANNER_URL: 'http://127.0.0.1:51234', SCANNER_KEY: 'auto-secret', INTEL_URL: 'http://127.0.0.1:51235' },
  );

  assert.equal(env.SCANNER_URL, 'http://127.0.0.1:51234');
  assert.equal(env.SCANNER_KEY, 'auto-secret');
  assert.equal(env.INTEL_URL, 'http://127.0.0.1:51235');
});

test('buildEngineEnv lets launch overrides win over saved settings', () => {
  // Launch/session overrides are the highest-priority layer.
  const env = buildEngineEnv(
    {},
    { SCANNER_URL: 'https://remote.scanner', SCANNER_KEY: 'user-key' },
    { SCANNER_URL: 'http://127.0.0.1:51234', SCANNER_KEY: 'auto-secret', INTEL_URL: 'http://127.0.0.1:51235' },
  );

  assert.equal(env.SCANNER_URL, 'http://127.0.0.1:51234');
  assert.equal(env.SCANNER_KEY, 'auto-secret');
  assert.equal(env.INTEL_URL, 'http://127.0.0.1:51235');
});

test('buildEngineEnv ignores blank launch overrides', () => {
  const env = buildEngineEnv({}, {}, { SCANNER_URL: '', INTEL_URL: '   ' });

  assert.equal(env.SCANNER_URL, 'http://127.0.0.1:7700');
  assert.equal(env.INTEL_URL, 'http://127.0.0.1:4000');
});
