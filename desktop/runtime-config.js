const DESKTOP_ENGINE_DEFAULTS = Object.freeze({
  INTEL_URL: 'http://127.0.0.1:4000',
  SCANNER_URL: 'http://127.0.0.1:7700',
  // On-the-go intel framework defaults (user-run external services; overridable in Settings).
  LLM_URL: 'http://127.0.0.1:11434/v1',
  FIRECRAWL_URL: 'http://127.0.0.1:3002',
});

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function cleanSettingsEnv(settings = {}) {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => isNonBlankString(value)),
  );
}

// Precedence (lowest → highest): processEnv, DESKTOP_ENGINE_DEFAULTS, overrides, settings.
// `overrides` carries values resolved at launch — e.g. the bundled scanner/intel URLs and
// the auto-provisioned scanner key — so they replace the static localhost defaults. Saved
// user settings still win over everything, so an explicitly configured remote backend is
// never clobbered by a bundled one.
function buildEngineEnv(processEnv = process.env, settings = {}, overrides = {}) {
  const env = { ...processEnv };

  for (const [key, value] of Object.entries(DESKTOP_ENGINE_DEFAULTS)) {
    if (!isNonBlankString(env[key])) env[key] = value;
  }

  return {
    ...env,
    ...cleanSettingsEnv(overrides),
    ...cleanSettingsEnv(settings),
  };
}

module.exports = {
  buildEngineEnv,
  cleanSettingsEnv,
  DESKTOP_ENGINE_DEFAULTS,
};
