const DESKTOP_ENGINE_DEFAULTS = Object.freeze({
  INTEL_URL: 'http://127.0.0.1:4000',
  SCANNER_URL: 'http://127.0.0.1:7700',
  LIVE_FEED_URL: 'http://127.0.0.1:7900',
  // On-the-go intel framework defaults (user-run external services; overridable in Settings).
  LLM_URL: 'http://127.0.0.1:11434/v1',
  FIRECRAWL_URL: 'http://127.0.0.1:3002',
  // Routing has no bundled backend; default to the public OSRM demo (self-host for prod).
  ROUTING_URL: 'https://router.project-osrm.org',
});

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Blank strings are intentionally ignored so an empty settings field falls back to the
// next lower layer instead of clearing to an unusable endpoint/key.
function cleanSettingsEnv(settings = {}) {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => isNonBlankString(value)),
  );
}

function readProcessEnv() {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

// Precedence (lowest -> highest): processEnv, DESKTOP_ENGINE_DEFAULTS, settings, overrides.
// `overrides` carries values resolved at launch or passed by the current session, so it is
// the highest-priority layer.
function buildEngineEnv(processEnv, settings = {}, overrides = {}) {
  const env = { ...(processEnv ?? readProcessEnv()) };

  for (const [key, value] of Object.entries(DESKTOP_ENGINE_DEFAULTS)) {
    if (!isNonBlankString(env[key])) env[key] = value;
  }

  return {
    ...env,
    ...cleanSettingsEnv(settings),
    ...cleanSettingsEnv(overrides),
  };
}

module.exports = {
  buildEngineEnv,
  cleanSettingsEnv,
  DESKTOP_ENGINE_DEFAULTS,
};
