'use client';

import type { InstalledPlugin } from '@/lib/settings';
import { getGroups } from '@/lib/registry';
import { getPlugins, installPlugin } from './loader';
import { getCustomSourceSpecs, upsertCustomSource } from './customSources';
import {
  formatValidationErrors,
  validateCustomSourceSpec,
  validateExtensionBundle,
  validatePluginBundleEntry,
  type CustomSourceSpecValue,
} from './validation';

export const EXTENSION_BUNDLE_VERSION = 1 as const;

export interface ExtensionBundle {
  version: typeof EXTENSION_BUNDLE_VERSION;
  plugins: InstalledPlugin[];
  customSources: CustomSourceSpecValue[];
}

export interface ExtensionImportIssue {
  kind: 'bundle' | 'plugin' | 'customSource';
  id?: string;
  error: string;
}

export interface ExtensionImportResult {
  ok: boolean;
  imported: {
    plugins: number;
    customSources: number;
  };
  skipped: ExtensionImportIssue[];
}

export function exportExtensionBundle(): ExtensionBundle {
  return {
    version: EXTENSION_BUNDLE_VERSION,
    plugins: getPlugins().map(({ id, name, version, code, enabled }) => ({ id, name, version, code, enabled })),
    customSources: getCustomSourceSpecs() as CustomSourceSpecValue[],
  };
}

export function serializeExtensionBundle(bundle: ExtensionBundle = exportExtensionBundle()): string {
  return JSON.stringify(bundle, null, 2);
}

function parseBundle(payload: string | unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch (e: any) {
    throw new Error(`Invalid JSON: ${String(e?.message ?? e)}`);
  }
}

function itemId(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'id' in value ? String((value as any).id) : undefined;
}

export async function importExtensionBundle(payload: string | unknown): Promise<ExtensionImportResult> {
  const result: ExtensionImportResult = {
    ok: true,
    imported: { plugins: 0, customSources: 0 },
    skipped: [],
  };

  let raw: unknown;
  try {
    raw = parseBundle(payload);
  } catch (e: any) {
    return {
      ok: false,
      imported: { plugins: 0, customSources: 0 },
      skipped: [{ kind: 'bundle', error: String(e?.message ?? e) }],
    };
  }

  const bundle = validateExtensionBundle(raw);
  if (!bundle.ok) {
    return {
      ok: false,
      imported: { plugins: 0, customSources: 0 },
      skipped: [{ kind: 'bundle', error: formatValidationErrors(bundle.errors) }],
    };
  }

  const groupIds = getGroups().map((g) => g.id);
  const existingSourceIds = new Set(getCustomSourceSpecs().map((s) => s.id));
  const importedSourceIds = new Set<string>();

  for (const source of bundle.value.customSources) {
    const id = itemId(source);
    if (id && importedSourceIds.has(id)) {
      result.skipped.push({ kind: 'customSource', id, error: `Custom source "${id}" appears more than once in the bundle.` });
      continue;
    }

    const validation = validateCustomSourceSpec(source, {
      groupIds,
      existingIds: [...existingSourceIds, ...importedSourceIds],
      currentId: id && existingSourceIds.has(id) ? id : undefined,
    });
    if (!validation.ok) {
      result.skipped.push({ kind: 'customSource', id, error: formatValidationErrors(validation.errors) });
      continue;
    }

    const upsert = upsertCustomSource(validation.value);
    if (!upsert.ok) {
      result.skipped.push({ kind: 'customSource', id: validation.value.id, error: upsert.error ?? 'Custom source import failed.' });
      continue;
    }
    importedSourceIds.add(validation.value.id);
    result.imported.customSources += 1;
  }

  for (const plugin of bundle.value.plugins) {
    const shallow = validatePluginBundleEntry(plugin);
    const id = itemId(plugin);
    if (!shallow.ok) {
      result.skipped.push({ kind: 'plugin', id, error: formatValidationErrors(shallow.errors) });
      continue;
    }

    const install = await installPlugin(shallow.value.code, {
      name: shallow.value.name,
      enabled: shallow.value.enabled ?? true,
    });
    if (!install.ok) {
      result.skipped.push({ kind: 'plugin', id: id ?? install.id, error: install.error ?? 'Plugin import failed.' });
      continue;
    }
    result.imported.plugins += 1;
    if (install.error) {
      result.skipped.push({ kind: 'plugin', id: install.id, error: install.error });
    }
  }

  result.ok = result.skipped.length === 0;
  return result;
}
