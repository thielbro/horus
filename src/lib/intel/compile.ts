// Compile orchestrator — runs a provider's gather → synthesize pipeline, streams progress
// events, caches the result, and assembles the Dossier. Server-side only (invoked from
// /api/intel/compile). The LLM only ever sees the provider's structured signals.

import { stableHash, safeAbortTimeout, safeAbortAny, releaseResponseBody, cloneJson } from '@/lib/http-utils';
import type {
  CompileEvent,
  Dossier,
  DossierGraph,
  EntityRef,
  GatherResult,
  LLMClient,
  ProviderCtx,
  SynthResult,
  IntelProvider,
} from './types';
import { getProvider, providerKinds } from './providers';
import { getLLM } from '@/lib/llm';
import { getSearch } from '@/lib/search';

export { providerKinds };

const INTEL_URL =
  process.env.INTEL_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');

const RESOLVE_TYPES = new Set(['aircraft', 'vessel', 'company', 'person', 'ip', 'country']);

// ── Dossier cache (TTL + bounded, mirrors the sidecar's Wikidata LRU posture) ──
const CACHE = new Map<string, { dossier: Dossier; at: number; bytes: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
const CACHE_MAX_BYTES = 5 * 1024 * 1024;
const PROVIDER_STAGE_TIMEOUT_MS = 30_000;
const INFLIGHT = new Map<string, Promise<Dossier>>();
let cacheBytes = 0;

function dossierBytes(dossier: Dossier): number {
  try {
    return JSON.stringify(dossier).length;
  } catch {
    return CACHE_MAX_BYTES + 1;
  }
}

function evictCacheEntry(key: string): void {
  const entry = CACHE.get(key);
  if (!entry) return;
  cacheBytes = Math.max(0, cacheBytes - entry.bytes);
  CACHE.delete(key);
}

function trimCache(): void {
  while ((CACHE.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES) && CACHE.size > 0) {
    const oldest = CACHE.keys().next().value;
    if (!oldest) break;
    evictCacheEntry(oldest);
  }
}

function cacheGet(key: string): Dossier | null {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    evictCacheEntry(key);
    return null;
  }
  CACHE.delete(key);
  CACHE.set(key, entry);
  return cloneJson(entry.dossier);
}
function cacheSet(key: string, dossier: Dossier): void {
  const cached = cloneJson(dossier);
  const bytes = dossierBytes(cached);
  if (bytes > CACHE_MAX_BYTES) return;
  evictCacheEntry(key);
  CACHE.set(key, { dossier: cached, at: Date.now(), bytes });
  cacheBytes += bytes;
  trimCache();
}

function cloneDossierWithCacheHit(dossier: Dossier, cacheHit: boolean): Dossier {
  const cloned = cloneJson(dossier);
  cloned.provenance = { ...cloned.provenance, cacheHit };
  return cloned;
}

function emitDossier(dossier: Dossier, emit: (ev: CompileEvent) => void): void {
  emit({ event: 'graph', data: dossier.graph });
  for (const section of dossier.sections) emit({ event: 'section', data: section });
  emit({ event: 'done', data: { provenance: dossier.provenance, citations: dossier.citations, dossier } });
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function runProviderStage<T>(
  stage: 'gather' | 'synthesize',
  emit: (ev: CompileEvent) => void,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stageSignal = safeAbortAny([parentSignal, safeAbortTimeout(PROVIDER_STAGE_TIMEOUT_MS)]);
  try {
    return await abortable(run(stageSignal), stageSignal);
  } catch (e) {
    emit({ event: 'error', data: { message: `${stage} failed: ${errorMessage(e, 'provider failed')}` } });
    throw e;
  }
}

/** Enrich the dossier graph by resolving a discovered sub-entity via the intel sidecar. */
async function resolveGraph(type: string, id: string, signal?: AbortSignal): Promise<DossierGraph | null> {
  if (!RESOLVE_TYPES.has(type) || !id) return null;
  try {
    const res = await fetch(
      `${INTEL_URL}/resolve?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
      { signal: safeAbortAny([signal, safeAbortTimeout(12_000)]) },
    );
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    return {
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
      links: Array.isArray(data?.links) ? data.links : [],
    };
  } catch {
    return null;
  }
}

export interface CompileOptions {
  signal?: AbortSignal;
  emit?: (ev: CompileEvent) => void;
  force?: boolean;
}

export async function compile(kind: string, ref: EntityRef, opts: CompileOptions = {}): Promise<Dossier> {
  const emit = opts.emit ?? (() => {});
  throwIfAborted(opts.signal);

  const provider = getProvider(kind);
  if (!provider) throw new Error(`Unknown intel kind: ${kind}`);
  if (provider.canHandle && !provider.canHandle(ref)) throw new Error(`Provider ${kind} cannot handle ref: ${ref.id}`);

  const t0 = Date.now();
  const cacheKey = stableHash({
    kind,
    ref: { kind: ref.kind, id: ref.id, label: ref.label, type: ref.type, lat: ref.lat, lng: ref.lng },
    v: provider.version,
  });

  if (!opts.force) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      const dossier = cloneDossierWithCacheHit(cached, true);
      emitDossier(dossier, emit);
      return dossier;
    }

    const inflight = INFLIGHT.get(cacheKey);
    if (inflight) {
      const dossier = cloneDossierWithCacheHit(await abortable(inflight, opts.signal), true);
      emitDossier(dossier, emit);
      return dossier;
    }
  }

  const work = compileUncached(kind, ref, provider, cacheKey, emit, opts, t0);
  if (opts.force) return work;

  INFLIGHT.set(cacheKey, work);
  try {
    return await work;
  } finally {
    if (INFLIGHT.get(cacheKey) === work) INFLIGHT.delete(cacheKey);
  }
}

async function compileUncached(
  kind: string,
  ref: EntityRef,
  provider: IntelProvider,
  cacheKey: string,
  emit: (ev: CompileEvent) => void,
  opts: CompileOptions,
  t0: number,
): Promise<Dossier> {
  const search = getSearch();

  // Wrap the LLM so provenance can record which rung actually produced the prose.
  let lastModel = 'unknown';
  const base = getLLM();
  const llm: LLMClient = {
    async chat(messages, chatOpts) {
      const result = await base.chat(messages, chatOpts);
      lastModel = `${result.backend}:${result.model}`;
      return result;
    },
  };

  const makeCtx = (signal: AbortSignal): ProviderCtx => ({
    search,
    llm,
    resolve: (type: string, id: string) => resolveGraph(type, id, signal),
    fetchPage: async (url: string) => {
      const page = await search.fetchPage(url, { signal });
      return page ? page.text : null;
    },
    emit,
    signal,
  });

  emit({ event: 'status', data: { stage: 'gathering' } });
  const gathered: GatherResult = await runProviderStage('gather', emit, opts.signal, (signal) =>
    provider.gather(ref, makeCtx(signal)),
  );
  const graph = gathered.graph ?? { nodes: [], links: [] };
  emit({ event: 'graph', data: graph });

  emit({ event: 'status', data: { stage: 'synthesizing' } });
  const synth: SynthResult = await runProviderStage('synthesize', emit, opts.signal, (signal) =>
    provider.synthesize(ref, gathered, makeCtx(signal)),
  );
  for (const section of synth.sections) emit({ event: 'section', data: section });

  const signalSources = [
    ...new Set([...gathered.signals.map((s) => s.source), ...gathered.citations.map((c) => c.source)]),
  ];

  const dossier: Dossier = {
    kind,
    ref,
    summary: synth.summary,
    sections: synth.sections,
    facts: [...(gathered.facts ?? []), ...synth.facts],
    graph,
    related: synth.related ?? [],
    actions: gathered.actions ?? [],
    citations: gathered.citations,
    geometry: gathered.geometry,
    privacy: synth.privacy ?? gathered.privacy,
    provenance: {
      generatedAt: new Date().toISOString(),
      model: lastModel,
      durationMs: Date.now() - t0,
      signalSources,
      cacheHit: false,
    },
  };

  cacheSet(cacheKey, dossier);
  emit({ event: 'done', data: { provenance: dossier.provenance, citations: dossier.citations, dossier } });
  return dossier;
}
