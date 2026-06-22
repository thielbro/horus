const DESKTOP_ENGINE_DEFAULTS = Object.freeze({
  INTEL_URL: 'http://127.0.0.1:4000',
  SCANNER_URL: 'http://127.0.0.1:7700',
});

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function cleanSettingsEnv(settings = {}) {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => isNonBlankString(value)),
  );
}

function buildEngineEnv(processEnv = process.env, settings = {}) {
  const env = { ...processEnv };

  for (const [key, value] of Object.entries(DESKTOP_ENGINE_DEFAULTS)) {
    if (!isNonBlankString(env[key])) env[key] = value;
  }

  return {
    ...env,
    ...cleanSettingsEnv(settings),
  };
}

module.exports = {
  buildEngineEnv,
  cleanSettingsEnv,
  DESKTOP_ENGINE_DEFAULTS,
};
