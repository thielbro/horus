import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function file(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('review 03c0485 LLM fallback paths honor aborts and bounded input', () => {
  const llm = file('src/lib/llm/index.ts');
  const gemini = file('src/lib/llm/gemini-adapter.ts');
  const ollama = file('src/lib/llm/ollama.ts');

  assert.match(llm, /DETERMINISTIC_INPUT_LIMIT/);
  assert.match(llm, /throwIfAborted\(opts\?\.signal\)/);
  assert.doesNotMatch(llm, /\[\.\.\.messages\]\.reverse\(\)/);
  assert.match(llm, /\.slice\(0,\s*DETERMINISTIC_INPUT_LIMIT\)/);
  assert.match(llm, /GEMINI_MODEL/);

  assert.match(gemini, /export const GEMINI_MODEL/);
  assert.match(gemini, /GEMINI_TIMEOUT_MS/);
  assert.match(gemini, /generationConfig/);
  assert.match(gemini, /maxOutputTokens/);
  assert.match(gemini, /signal: opts\?\.signal/);

  assert.match(ollama, /process\.env\.LLM_MODEL\?\.trim\(\) \|\| DEFAULT_MODEL/);
});

test('review 03c0485 settings store and panel avoid stale hydration and custom theme crashes', () => {
  const settings = file('src/lib/settings/index.ts');
  const panel = file('src/components/SettingsPanel.tsx');

  assert.match(settings, /mutationRevision/);
  assert.match(settings, /hydrateRevision/);
  assert.match(settings, /mutationRevision === hydrateRevision/);
  assert.match(settings, /Object\.getPrototypeOf/);
  assert.match(settings, /Settings listener failed/);
  assert.match(settings, /\[0-9a-f\]\{3\}/i);
  assert.match(settings, /Promise<boolean>/);

  assert.match(panel, /DEFAULT_SETTINGS/);
  assert.match(panel, /APPEARANCE_OPTIONS/);
  assert.match(panel, /useCallback/);
  assert.match(panel, /getSettings\(\)\.apiKeys/);
  assert.match(panel, /setSaveError/);
  assert.match(panel, /await update\(\{ apiKeys: keys \}\)/);
  assert.doesNotMatch(panel, /wasOpenRef/);
  assert.doesNotMatch(panel, /as Partial<CustomThemeTokens>/);
});

test('review 03c0485 search and geo guards are explicit', () => {
  const firecrawl = file('src/lib/search/firecrawl.ts');
  const geo = file('src/lib/geo.ts');

  assert.match(firecrawl, /VALIDATE_HOST_TIMEOUT_MS/);
  assert.match(firecrawl, /validateHostWithTimeout/);
  assert.match(firecrawl, /query\.trim\(\)/);
  assert.match(firecrawl, /raw && typeof raw === 'object'/);

  assert.match(geo, /BBox \| null/);
  assert.match(geo, /points\.length === 0/);
  assert.match(geo, /normalizeLng/);
});

test('review 03c0485 compile pipeline is bounded, deduped, cloned, and emits errors', () => {
  const compile = file('src/lib/intel/compile.ts');
  const providers = file('src/lib/intel/providers/index.ts');
  const stub = file('src/lib/intel/providers/stub.ts');

  assert.match(compile, /CACHE_MAX_BYTES/);
  assert.match(compile, /INFLIGHT/);
  assert.match(compile, /cloneJson/);
  assert.match(compile, /runProviderStage/);
  assert.match(compile, /PROVIDER_STAGE_TIMEOUT_MS/);
  assert.match(compile, /resolveGraph\(type: string, id: string, signal\?: AbortSignal\)/);
  assert.match(compile, /safeAbortAny/);
  assert.match(compile, /cloneDossierWithCacheHit\([\s\S]*,\s*true\)/);
  assert.match(compile, /event: 'error'/);
  assert.match(compile, /ref: \{ kind: ref\.kind, id: ref\.id, label: ref\.label, type: ref\.type/);
  assert.match(compile, /provider\.canHandle/);

  assert.match(providers, /PROVIDERS\.has\(provider\.kind\)/);
  assert.match(providers, /console\.warn/);
  assert.match(stub, /JSON\.stringify\(s\.value\)/);
});

test('review 03c0485 routes and desktop precedence match the stability review', () => {
  const route = file('src/app/api/intel/compile/route.ts');
  const health = file('src/app/api/llm/health/route.ts');
  const runtime = file('desktop/runtime-config.js');

  assert.match(route, /const allowed = providerKinds\(\)/);
  assert.match(route, /controller\.desiredSize/);
  assert.match(health, /status:\s*503/);
  assert.match(runtime, /\.\.\.cleanSettingsEnv\(settings\),\s*\.\.\.cleanSettingsEnv\(overrides\)/);
});
