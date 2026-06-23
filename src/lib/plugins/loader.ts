'use client';

// Plugin loader. Trusted in-process model: a plugin is an ES module that default-exports
// a definition `{ id, name, version, activate(ctx) }`. We import it from a blob URL (works
// in both the web and desktop renderer), call activate() with an OsirisContext, and track
// everything for clean teardown. Errors are caught per-plugin so a bad plugin can never
// crash the host. Installed plugins persist (code + enabled) to the settings store.

import { useSyncExternalStore } from 'react';
import { getSettings, updateSettings, type InstalledPlugin } from '@/lib/settings';
import { clearByPlugin } from '@/lib/registry/store';
import { clearFeedsByPlugin } from '@/lib/registry/feeds';
import { createPluginContext, type PluginContextHandle } from './context';
import { formatValidationErrors, validatePluginDefinition } from './validation';

export interface PluginRecord extends InstalledPlugin {
  /** Last activation error, or null when healthy. */
  error: string | null;
  /** True once activate() has succeeded for the current enabled state. */
  loaded: boolean;
}

type PluginDefinition = {
  id: string;
  name: string;
  version: string;
  sdk?: number;
  activate: (ctx: unknown) => unknown | Promise<unknown>;
  deactivate?: (ctx: unknown) => unknown | Promise<unknown>;
};

let records: PluginRecord[] = [];
let bootstrapped = false;
let bootstrapPromise: Promise<void> | null = null;
const handles = new Map<string, PluginContextHandle>();
const listeners = new Set<() => void>();
const installLocks = new Map<string, Promise<void>>();
const MAX_PLUGINS = 50;
const notify = () => listeners.forEach((l) => {
  try { l(); } catch (err) { console.error('[OSIRIS] plugin listener failed', err); }
});

// Bundler-opaque dynamic import so webpack/turbopack don't try to resolve the blob URL.
const dynamicImport: (u: string) => Promise<any> = new Function('u', 'return import(u)') as any;

function persist() {
  const plugins: InstalledPlugin[] = records.map(({ id, name, version, code, enabled }) => ({ id, name, version, code, enabled }));
  updateSettings({ plugins });
}

async function importDef(code: string): Promise<any> {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') throw new Error('Plugins can only load in the browser/renderer.');
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    const mod = await dynamicImport(url);
    return mod?.default ?? (typeof mod?.activate === 'function' ? mod : null);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function teardown(id: string) {
  try { handles.get(id)?.dispose(); } catch (err) { console.error('[OSIRIS] plugin teardown failed', id, err); }
  handles.delete(id);
  clearByPlugin(id);
  clearFeedsByPlugin(id);
}

async function withPluginLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const next = previous.catch(() => undefined).then(() => current);
  installLocks.set(id, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (installLocks.get(id) === next) installLocks.delete(id);
  }
}

async function runActivate(def: PluginDefinition, rec: PluginRecord) {
  try {
    const handle = createPluginContext(rec.id, { name: rec.name, version: rec.version });
    await def.activate(handle.ctx);
    handle.finalize();
    handles.set(rec.id, handle);
    rec.error = null;
    rec.loaded = true;
  } catch (e: any) {
    teardown(rec.id);
    rec.error = String(e?.message ?? e);
    rec.loaded = false;
  }
}

async function activateFromCode(rec: PluginRecord) {
  teardown(rec.id);
  try {
    const def = await importDef(rec.code);
    const validation = validatePluginDefinition(def);
    if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
    await runActivate(validation.value as PluginDefinition, rec);
  } catch (e: any) {
    teardown(rec.id);
    rec.error = String(e?.message ?? e);
    rec.loaded = false;
    rec.enabled = false;
  }
}

/** Install (or replace) a plugin from source code. Activates immediately and persists. */
export async function installPlugin(code: string, opts?: { name?: string; enabled?: boolean }): Promise<{ ok: boolean; id?: string; error?: string }> {
  let def: any;
  try {
    def = await importDef(code);
    const validation = validatePluginDefinition(def);
    if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
    def = validation.value;
  }
  catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }

  const id = def.id;
  const name = opts?.name ?? def.name;
  const version = def.version;

  return withPluginLock(id, async () => {
    const replacing = records.some((r) => r.id === id);
    if (!replacing && records.length >= MAX_PLUGINS) {
      return { ok: false, id, error: `Plugin limit reached (${MAX_PLUGINS}).` };
    }

    teardown(id); // replacing an existing plugin with the same id
    const rec: PluginRecord = { id, name, version, code, enabled: opts?.enabled ?? true, error: null, loaded: false };
    records = [...records.filter((r) => r.id !== id), rec];
    if (rec.enabled) {
      await runActivate(def, rec);
      if (rec.error) rec.enabled = false;
    }
    persist();
    notify();
    return { ok: true, id, error: rec.error ?? undefined };
  });
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  rec.enabled = enabled;
  if (enabled) {
    await activateFromCode(rec);
    if (rec.error) rec.enabled = false;
  }
  else { teardown(id); rec.loaded = false; rec.error = null; }
  records = [...records];
  persist();
  notify();
}

export function uninstallPlugin(id: string): void {
  teardown(id);
  records = records.filter((r) => r.id !== id);
  persist();
  notify();
}

export function getPlugins(): PluginRecord[] {
  return records;
}

/** Re-activate every enabled persisted plugin. Call once settings are ready. */
export async function bootstrapPlugins(): Promise<void> {
  if (bootstrapped) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const persisted = getSettings().plugins ?? [];
    records = persisted.slice(0, MAX_PLUGINS).map((p) => ({ ...p, error: null, loaded: false }));
    notify();
    for (const rec of records) {
      if (rec.enabled) {
        await activateFromCode(rec);
        if (rec.error) rec.enabled = false;
      }
    }
    persist();
    notify();
    bootstrapped = true;
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export function usePlugins(): PluginRecord[] {
  return useSyncExternalStore(subscribe, getPlugins, getPlugins);
}
