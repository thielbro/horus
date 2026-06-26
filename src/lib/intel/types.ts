// HORUS — on-the-go intel framework: the core contracts.
//
// A SearchProvider (Firecrawl) + an LLMClient (Ollama→Gemini→deterministic) let an
// IntelProvider compile a Dossier for an entity at request time — no static database.
// The Dossier is a superset of the intel sidecar's /resolve payload, so its `graph` drops
// straight into EntityGraphPanel. `address` is the first provider; the same seam later wraps
// person / company / vehicle / route across the whole intel side.
//
// These are pure types (server-side framework). Keep this module free of runtime imports so
// it stays the shared contract hub for src/lib/llm, src/lib/search, and the providers.

export type Confidence = 'high' | 'med' | 'low';

/** Graph node — identical shape to EntityGraphPanel's EntityNode. */
export interface EntityNode {
  id: string;
  label: string;
  type: string; // aircraft|vessel|company|person|ip|country|address|camera|postcode|route|event|sanction…
  properties?: Record<string, unknown>;
}

/** Graph link — identical shape to EntityGraphPanel's EntityLink. */
export interface EntityLink {
  source: string;
  target: string;
  label?: string;
}

export interface DossierGraph {
  nodes: EntityNode[];
  links: EntityLink[];
}

export interface Citation {
  id: string;
  title: string;
  url: string;
  source: string;
  fetchedAt: string;
}

export interface Fact {
  label: string;
  value: string;
  confidence?: Confidence;
  citationIds?: string[];
  source?: string;
}

export interface Section {
  id: string;
  title: string;
  body: string;
  facts?: Fact[];
  citationIds?: string[];
}

export interface EntityRef {
  kind: string;
  id: string;
  label?: string;
  lat?: number;
  lng?: number;
  /** Optional graph node type for this ref (defaults to kind). */
  type?: string;
}

export type DossierAction =
  | { type: 'flyTo'; lat: number; lng: number; zoom?: number }
  | { type: 'drawRadius'; lat: number; lng: number; radiusM: number }
  | { type: 'drawRoute'; geometry: unknown }
  | { type: 'openGraph'; ref: EntityRef };

export interface Privacy {
  tier: 'public' | 'business' | 'residential' | 'person';
  notice: string;
}

/** Imagery / media attached to a dossier (e.g. nearest Mapillary street-level shots). */
export interface MediaItem {
  type: 'image';
  url: string;
  thumbUrl?: string;
  lat?: number;
  lng?: number;
  capturedAt?: string;
  /** Camera heading in degrees, if known. */
  heading?: number;
  source: string;
  sourceUrl?: string;
}

export interface Provenance {
  generatedAt: string;
  model: string;
  durationMs: number;
  signalSources: string[];
  cacheHit: boolean;
}

export interface Dossier {
  kind: string;
  ref: EntityRef;
  summary: string;
  sections: Section[];
  facts: Fact[];
  graph: DossierGraph;
  related: EntityRef[];
  actions: DossierAction[];
  citations: Citation[];
  media?: MediaItem[];
  geometry?: unknown;
  privacy?: Privacy;
  provenance: Provenance;
}

// ── Gather / synthesize split ──────────────────────────────────────────────────

/** A structured, source-tagged signal — the only thing the LLM ever sees (low hallucination). */
export interface Signal {
  key: string;
  label: string;
  value: unknown;
  source: string;
}

export interface GatherResult {
  signals: Signal[];
  citations: Citation[];
  graph?: DossierGraph;
  geometry?: unknown;
  facts?: Fact[];
  actions?: DossierAction[];
  media?: MediaItem[];
  privacy?: Privacy;
}

export interface SynthResult {
  summary: string;
  sections: Section[];
  facts: Fact[];
  related?: EntityRef[];
  privacy?: Privacy;
}

// ── Provider services ───────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type LLMBackend = 'ollama' | 'gemini' | 'deterministic';

export interface LLMResult {
  text: string;
  model: string;
  backend: LLMBackend;
}

export interface LLMClient {
  chat(messages: LLMMessage[], opts?: LLMChatOptions): Promise<LLMResult>;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  markdown?: string;
  source: string;
}

export interface SearchProvider {
  name: string;
  available(): boolean;
  search(query: string, opts?: { count?: number; signal?: AbortSignal }): Promise<SearchHit[]>;
  /** Read a page as clean text/markdown. `url` is SSRF-validated by the implementation. */
  fetchPage(url: string, opts?: { signal?: AbortSignal }): Promise<{ text: string; title?: string; url: string } | null>;
}

// ── Compile streaming events (SSE) ──────────────────────────────────────────────

export type CompileEvent =
  | { event: 'status'; data: { stage: string; [k: string]: unknown } }
  | { event: 'graph'; data: DossierGraph }
  | { event: 'section'; data: Section }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: { provenance: Provenance; citations: Citation[]; dossier: Dossier } };

export interface ProviderCtx {
  search: SearchProvider;
  llm: LLMClient;
  /** Enrich the graph by resolving a discovered sub-entity via the intel sidecar's /resolve. */
  resolve(type: string, id: string): Promise<DossierGraph | null>;
  /** Read a web page as text (SSRF-guarded). */
  fetchPage(url: string): Promise<string | null>;
  emit(ev: CompileEvent): void;
  signal?: AbortSignal;
}

export interface IntelProvider {
  kind: string;
  version: string;
  canHandle?(ref: EntityRef): boolean;
  gather(ref: EntityRef, ctx: ProviderCtx): Promise<GatherResult>;
  synthesize(ref: EntityRef, gathered: GatherResult, ctx: ProviderCtx): Promise<SynthResult>;
}
