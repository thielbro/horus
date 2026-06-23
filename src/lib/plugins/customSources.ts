'use client';

// Manages the user's no-code custom sources: the persisted list of CustomSourceSpecs,
// their registration into the live registry, and a reactive hook for the editor UI.

import { useSyncExternalStore } from 'react';
import { getSettings, updateSettings } from '@/lib/settings';
import { registerCustomSource, unregisterCustomSource, type CustomSourceSpec } from '@/lib/registry';

let specs: CustomSourceSpec[] = [];
let bootstrapped = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function persist() {
  updateSettings({ customSources: specs });
}

export function getCustomSources(): CustomSourceSpec[] {
  return specs;
}

/** Create or replace a custom source (re-registers it live and persists). */
export function upsertCustomSource(spec: CustomSourceSpec): void {
  const i = specs.findIndex((s) => s.id === spec.id);
  if (i >= 0) { unregisterCustomSource(spec.id); specs = specs.map((s) => (s.id === spec.id ? spec : s)); }
  else specs = [...specs, spec];
  try { registerCustomSource(spec); } catch (e) { console.error('[OSIRIS] custom source register failed', spec.id, e); }
  persist();
  notify();
}

export function removeCustomSource(id: string): void {
  unregisterCustomSource(id);
  specs = specs.filter((s) => s.id !== id);
  persist();
  notify();
}

/** Register all persisted custom sources into the registry. Call once settings are ready. */
export function bootstrapCustomSources(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  const persisted = (getSettings().customSources ?? []) as CustomSourceSpec[];
  specs = [];
  for (const s of persisted) {
    try { registerCustomSource(s); specs.push(s); }
    catch (e) { console.error('[OSIRIS] custom source bootstrap failed', (s as any)?.id, e); }
  }
  notify();
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export function useCustomSources(): CustomSourceSpec[] {
  return useSyncExternalStore(subscribe, getCustomSources, getCustomSources);
}
