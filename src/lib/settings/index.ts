'use client';

// OSIRIS settings store.
//
// One store, two backends:
//   - Desktop: persisted to userData/settings.json over the window.osiris IPC bridge.
//   - Web:     persisted to localStorage.
// The renderer never cares which — it calls useSettings()/updateSettings() and the
// store routes to whichever backend is present. This is the foundation the API-key
// config, theme editor, and (later) saved workspaces all build on.

import { useEffect, useMemo, useState } from 'react';
import { cloneJson } from '@/lib/http-utils';
import type { WorkspaceSnapshot } from '@/lib/workspaces';

// ── Schema ──────────────────────────────────────────────────────────────────

export interface ApiKeys {
  INTEL_URL?: string;
  SCANNER_URL?: string;
  SCANNER_KEY?: string;
  FIRMS_API_KEY?: string;
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;
  N2YO_API_KEY?: string;
  AIS_API_KEY?: string;
  // ── On-the-go intel framework (search engine + local LLM, compiled on demand) ──
  /** OpenAI-compatible local LLM base URL (Ollama/LM Studio/llama.cpp). */
  LLM_URL?: string;
  /** Local LLM model name (e.g. llama3.1). */
  LLM_MODEL?: string;
  /** Self-hosted Firecrawl base URL (web search + page scraping). */
  FIRECRAWL_URL?: string;
  /** Optional Firecrawl API key (cloud or secured self-host). */
  FIRECRAWL_KEY?: string;
  /** Mapillary token for street-level imagery near an address. */
  MAPILLARY_TOKEN?: string;
}

export interface CustomThemeTokens {
  'bg-void': string;
  'gold-primary': string;
  'cyan-primary': string;
  'text-primary': string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Versioned UI/map snapshot. Loaded through `normalizeWorkspaceSnapshot`. */
  state: WorkspaceSnapshot;
}

/** A persisted JS plugin (trusted, in-process). `code` is the plugin's ES-module source. */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  code: string;
  enabled: boolean;
}

export interface OsirisSettings {
  version: number;
  appearance: {
    theme: 'core' | 'ghost' | 'custom';
    custom: CustomThemeTokens;
  };
  map: {
    defaultProjection: 'globe' | 'mercator';
    defaultStyle: 'dark' | 'satellite';
  };
  apiKeys: ApiKeys;
  workspaces: Workspace[];
  /** Installed JS plugins (see src/lib/plugins). */
  plugins: InstalledPlugin[];
  /** No-code custom sources — persisted as serializable CustomSourceSpec objects. */
  customSources: unknown[];
}

export const DEFAULT_SETTINGS: OsirisSettings = {
  version: 1,
  appearance: {
    theme: 'core',
    // Seeded from the core palette so the custom pickers always start valid.
    custom: {
      'bg-void': '#04040A',
      'gold-primary': '#D4AF37',
      'cyan-primary': '#00E5FF',
      'text-primary': '#E8E6E0',
    },
  },
  map: {
    defaultProjection: 'globe',
    defaultStyle: 'dark',
  },
  apiKeys: {},
  workspaces: [],
  plugins: [],
  customSources: [],
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ── Merge helper (plain objects merge, arrays/scalars replace) ────────────────

type Plain = Record<string, unknown>;
function isPlain(v: unknown): v is Plain {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined || patch === null ? base : (patch as T));
  const out: Plain = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (out as Plain)[k];
    const pv = (patch as Plain)[k];
    out[k] = isPlain(bv) && isPlain(pv) ? deepMerge(bv, pv) : pv;
  }
  return out as T;
}

// ── Backend ───────────────────────────────────────────────────────────────────

interface DesktopBridge {
  settings?: {
    getAll(): Promise<Partial<OsirisSettings>>;
    set(full: OsirisSettings): Promise<void>;
  };
}

const STORAGE_KEY = 'osiris:settings:v1';

function backend() {
  const os = (typeof window !== 'undefined' ? (window as unknown as { osiris?: DesktopBridge }).osiris : undefined);
  if (os?.settings) {
    return {
      getAll: () => os.settings!.getAll(),
      set: (full: OsirisSettings) => os.settings!.set(full),
    };
  }
  return {
    getAll: async (): Promise<Partial<OsirisSettings>> => {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      } catch {
        return {};
      }
    },
    set: async (full: OsirisSettings) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
      } catch {
        /* ignore quota / private mode */
      }
    },
  };
}

// ── Store singleton ─────────────────────────────────────────────────────────

let current: OsirisSettings = DEFAULT_SETTINGS;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const MAX_LISTENERS = 500;
const notify = () => listeners.forEach((l) => l());

async function hydrate() {
  if (loaded) return;
  if (!inflight) {
    inflight = (async () => {
      try {
        const persisted = await backend().getAll();
        current = deepMerge(DEFAULT_SETTINGS, persisted || {});
      } catch {
        current = DEFAULT_SETTINGS;
      }
      loaded = true;
      notify();
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function getSettings(): OsirisSettings {
  return cloneJson(current);
}

export function updateSettings(patch: DeepPartial<OsirisSettings>) {
  current = deepMerge(current, patch);
  notify();
  backend().set(current).catch(() => { /* best effort */ });
}

export function useSettings() {
  const [version, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    if (listeners.size >= MAX_LISTENERS) {
      const oldest = listeners.values().next().value;
      if (oldest) listeners.delete(oldest);
      console.warn('[OSIRIS] Settings listener limit reached; evicted oldest listener');
    }
    listeners.add(l);
    hydrate();
    return () => { listeners.delete(l); };
  }, []);
  const settings = useMemo(() => cloneJson(current), [version]);
  return { settings, update: updateSettings, ready: loaded };
}

// ── Theme application ─────────────────────────────────────────────────────────
//
// Core/ghost are driven by body class (handled in page.tsx). Custom themes layer
// CSS-variable overrides on top via body.style — and derive the *-rgb triplets the
// stylesheet uses for borders/glows so a custom accent actually propagates.

const CUSTOM_VARS = ['--bg-void', '--gold-primary', '--gold-rgb', '--cyan-primary', '--cyan-rgb', '--text-primary'];

function hexToRgb(hex: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
}

export function applyAppearance(appearance: OsirisSettings['appearance']) {
  if (typeof document === 'undefined') return;
  const s = document.body.style;
  CUSTOM_VARS.forEach((v) => s.removeProperty(v));
  if (appearance.theme !== 'custom') return;

  const c = appearance.custom;
  if (c['bg-void']) s.setProperty('--bg-void', c['bg-void']);
  if (c['text-primary']) s.setProperty('--text-primary', c['text-primary']);
  if (c['gold-primary']) {
    s.setProperty('--gold-primary', c['gold-primary']);
    const rgb = hexToRgb(c['gold-primary']);
    if (rgb) s.setProperty('--gold-rgb', rgb);
  }
  if (c['cyan-primary']) {
    s.setProperty('--cyan-primary', c['cyan-primary']);
    const rgb = hexToRgb(c['cyan-primary']);
    if (rgb) s.setProperty('--cyan-rgb', rgb);
  }
}
