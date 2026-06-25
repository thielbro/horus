// Compile orchestrator — runs a provider's gather → synthesize pipeline, streams progress
// events, caches the result, and assembles the Dossier. Server-side only (invoked from
// /api/intel/compile). The LLM only ever sees the provider's structured signals.

import { stableHash, safeAbortTimeout, releaseResponseBody } from '@/lib/http-utils';
import type { CompileEvent, Dossier, DossierGraph, EntityRef, LLMClient } from './types';
import { getProvider, providerKinds } from './providers';
import { getLLM } from '@/lib/llm';
import { getSearch } from '@/lib/search';

export { providerKinds };

const INTEL_URL =
  process.env.INTEL_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://osiris-intel:4000' : 'http://localhost:4000');

const RESOLVE_TYPES = new Set(['aircraft', 'vessel', 'company', 'person', 'ip', 'country']);

// ── Dossier cache (TTL + bounded, mirrors the sidecar's Wikidata LRU posture) ──
const CACHE = new Map<string, { dossier: Dossier; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

function cacheGet(key: string): Dossier | null {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return entry.dossier;
}
function cacheSet(key: string, dossier: Dossier): void {
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value;
    if (oldest) CACHE.delete(oldest);
  }
  CACHE.set(key, { dossier, at: Date.now() });
}

/** Enrich the dossier graph by resolving a discovered sub-entity via the intel sidecar. */
async function resolveGraph(type: string, id: string): Promise<DossierGraph | null> {
  if (!RESOLVE_TYPES.has(type) || !id) return null;
  try {
    const res = await fetch(
      `${INTEL_URL}/resolve?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
      { signal: safeAbortTimeout(12_000) },
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
  const provider = getProvider(kind);
  if (!provider) throw new Error(`Unknown intel kind: ${kind}`);

  const t0 = Date.now();
  const cacheKey = stableHash({
    kind,
    ref: { kind: ref.kind, id: ref.id, lat: ref.lat, lng: ref.lng },
    v: provider.version,
  });

  if (!opts.force) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      const provenance = { ...cached.provenance, cacheHit: true };
      const dossier = { ...cached, provenance };
      emit({ event: 'graph', data: dossier.graph });
      for (const section of dossier.sections) emit({ event: 'section', data: section });
      emit({ event: 'done', data: { provenance, citations: dossier.citations, dossier } });
      return dossier;
    }
  }

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

  const ctx = {
    search: getSearch(),
    llm,
    resolve: resolveGraph,
    fetchPage: async (url: string) => {
      const page = await getSearch().fetchPage(url, { signal: opts.signal });
      return page ? page.text : null;
    },
    emit,
    signal: opts.signal,
  };

  emit({ event: 'status', data: { stage: 'gathering' } });
  const gathered = await provider.gather(ref, ctx);
  const graph = gathered.graph ?? { nodes: [], links: [] };
  emit({ event: 'graph', data: graph });

  emit({ event: 'status', data: { stage: 'synthesizing' } });
  const synth = await provider.synthesize(ref, gathered, ctx);
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
