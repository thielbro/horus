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
const MAX_CUSTOM_SOURCES = 200;
const notify = () => listeners.forEach((l) => {
  try { l(); } catch (err) { console.error('[HORUS] custom source listener failed', err); }
});

function persist() {
  updateSettings({ customSources: specs.map(stripRuntimeFields) });
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
  return specs.map(stripRuntimeFields);
}

function commitSpecs(nextSpecs: CustomSourceRecord[]): void {
  const previousSpecs = specs;
  specs = nextSpecs;
  try {
    persist();
    notify();
  } catch (err) {
    specs = previousSpecs;
    notify();
    throw err;
  }
}

function rollbackLiveRegistry(id: string, previousRecord: CustomSourceRecord | null): void {
  try { unregisterCustomSource(id); } catch { /* best effort cleanup */ }
  if (previousRecord) {
    try {
      registerCustomSource(stripRuntimeFields(previousRecord));
    } catch (restoreErr) {
      console.error('[HORUS] custom source rollback failed', previousRecord.id, restoreErr);
    }
  }
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
  const previousRecord = previous ? { ...previous } : null;
  if (!previous && specs.length >= MAX_CUSTOM_SOURCES) {
    return { ok: false, error: `Custom source limit reached (${MAX_CUSTOM_SOURCES}).` };
  }

  try {
    if (previous) unregisterCustomSource(clean.id);
    registerCustomSource(clean);
    const record: CustomSourceRecord = { ...clean, error: null };
    commitSpecs(previous ? specs.map((s) => (s.id === clean.id ? record : s)) : [...specs, record]);
  } catch (e: any) {
    const error = String(e?.message ?? e);
    console.error('[HORUS] custom source register failed', clean.id, e);
    rollbackLiveRegistry(clean.id, previousRecord);
    const record: CustomSourceRecord = previousRecord ? { ...previousRecord, error } : { ...clean, error };
    try {
      commitSpecs(previous ? specs.map((s) => (s.id === clean.id ? record : s)) : [...specs, record]);
    } catch (persistErr) {
      console.error('[HORUS] custom source persist failed', clean.id, persistErr);
      return { ok: false, id: clean.id, error: String((persistErr as any)?.message ?? persistErr) };
    }
    return { ok: false, id: clean.id, error };
  }
  return { ok: true, id: clean.id };
}

export function removeCustomSource(id: string): void {
  const previousSpecs = specs;
  const previousRecord = specs.find((s) => s.id === id) ?? null;
  unregisterCustomSource(id);
  try {
    commitSpecs(specs.filter((s) => s.id !== id));
  } catch (err) {
    rollbackLiveRegistry(id, previousRecord);
    specs = previousSpecs;
    console.error('[HORUS] custom source remove persist failed', id, err);
    throw err;
  }
}

/** Register all persisted custom sources into the registry. Call once settings are ready. */
export function bootstrapCustomSources(): void {
  if (bootstrapped) return;
  const persisted = (getSettings().customSources ?? []) as CustomSourceSpec[];
  specs = [];
  const seen = new Set<string>();
  for (const s of persisted) {
    const validation = validateCustomSourceSpec(s, {
      groupIds: groupIds(),
      existingIds: [...seen],
    });
    if (!validation.ok) {
      console.error('[HORUS] custom source validation failed', (s as any)?.id, validation.errors);
      continue;
    }
    const clean = validation.value as CustomSourceSpec;
    try {
      registerCustomSource(clean);
      specs.push({ ...clean, error: null });
      seen.add(clean.id);
    } catch (e: any) {
      console.error('[HORUS] custom source bootstrap failed', clean.id, e);
      specs.push({ ...clean, error: String(e?.message ?? e) });
      seen.add(clean.id);
    }
  }
  bootstrapped = true;
  notify();
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export function useCustomSources(): CustomSourceRecord[] {
  return useSyncExternalStore(subscribe, getCustomSources, getCustomSources);
}
