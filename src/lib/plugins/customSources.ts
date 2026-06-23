'use client';

// Manages the user's no-code custom sources: the persisted list of CustomSourceSpecs,
// their registration into the live registry, and a reactive hook for the editor UI.

import { useSyncExternalStore } from 'react';
import { getSettings, updateSettings } from '@/lib/settings';
import { registerCustomSource, unregisterCustomSource, getGroups, type CustomSourceSpec } from '@/lib/registry';
import { formatValidationErrors, validateCustomSourceSpec } from './validation';

export interface CustomSourceRecord extends CustomSourceSpec {
  error: string | null;
}

let specs: CustomSourceRecord[] = [];
let bootstrapped = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function persist() {
  updateSettings({ customSources: specs.filter((s) => !s.error).map(stripRuntimeFields) });
}

function stripRuntimeFields(spec: CustomSourceRecord): CustomSourceSpec {
  const persisted: Partial<CustomSourceRecord> = { ...spec };
  delete persisted.error;
  return persisted as CustomSourceSpec;
}

function groupIds(): string[] {
  return getGroups().map((g) => g.id);
}

export function getCustomSources(): CustomSourceRecord[] {
  return specs;
}

export function getCustomSourceSpecs(): CustomSourceSpec[] {
  return specs.filter((s) => !s.error).map(stripRuntimeFields);
}

/** Create or replace a custom source (re-registers it live and persists). */
export function upsertCustomSource(spec: CustomSourceSpec): { ok: boolean; id?: string; error?: string } {
  const validation = validateCustomSourceSpec(spec, {
    groupIds: groupIds(),
    existingIds: specs.map((s) => s.id),
    currentId: spec.id,
  });
  if (!validation.ok) return { ok: false, error: formatValidationErrors(validation.errors) };

  const clean = validation.value as CustomSourceSpec;
  const previous = specs.find((s) => s.id === clean.id);
  if (previous) unregisterCustomSource(clean.id);

  try {
    registerCustomSource(clean);
    const record: CustomSourceRecord = { ...clean, error: null };
    specs = previous ? specs.map((s) => (s.id === clean.id ? record : s)) : [...specs, record];
  } catch (e: any) {
    const error = String(e?.message ?? e);
    console.error('[OSIRIS] custom source register failed', clean.id, e);
    const record: CustomSourceRecord = { ...clean, error };
    specs = previous ? specs.map((s) => (s.id === clean.id ? record : s)) : [...specs, record];
    persist();
    notify();
    return { ok: false, id: clean.id, error };
  }
  persist();
  notify();
  return { ok: true, id: clean.id };
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
  const seen = new Set<string>();
  for (const s of persisted) {
    const validation = validateCustomSourceSpec(s, {
      groupIds: groupIds(),
      existingIds: [...seen],
    });
    if (!validation.ok) {
      console.error('[OSIRIS] custom source validation failed', (s as any)?.id, validation.errors);
      continue;
    }
    const clean = validation.value as CustomSourceSpec;
    try {
      registerCustomSource(clean);
      specs.push({ ...clean, error: null });
      seen.add(clean.id);
    } catch (e: any) {
      console.error('[OSIRIS] custom source bootstrap failed', clean.id, e);
      specs.push({ ...clean, error: String(e?.message ?? e) });
      seen.add(clean.id);
    }
  }
  notify();
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export function useCustomSources(): CustomSourceRecord[] {
  return useSyncExternalStore(subscribe, getCustomSources, getCustomSources);
}
