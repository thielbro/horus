'use client';

// Public surface for the plugin + custom-source subsystem, plus the one-shot bootstrap
// the app calls once settings are hydrated.

export {
  installPlugin, uninstallPlugin, setPluginEnabled, getPlugins, usePlugins,
  bootstrapPlugins, type PluginRecord,
} from './loader';
export {
  upsertCustomSource, removeCustomSource, getCustomSources, useCustomSources,
  bootstrapCustomSources, getCustomSourceSpecs, type CustomSourceRecord,
} from './customSources';
export {
  exportExtensionBundle, importExtensionBundle, serializeExtensionBundle,
  type ExtensionBundle, type ExtensionImportResult,
} from './bundles';
export {
  validateCustomSourceSpec, validatePluginDefinition, formatValidationErrors,
} from './validation';
export { setHostServices, getHost, type HostServices } from './host';
export type { CustomSourceSpec } from '@/lib/registry';

import { bootstrapPlugins } from './loader';
import { bootstrapCustomSources } from './customSources';

/** Minimal in-app SDK exposed on `window.HorusSDK` so editor plugins can author without
 *  resolving the `@horus/plugin-sdk` bare import (which a blob module can't resolve). */
function installSdkGlobal() {
  if (typeof window === 'undefined' || (window as any).HorusSDK) return;
  const point = (lng: number, lat: number, props: Record<string, unknown> = {}) =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props });
  const line = (coords: Array<[number, number]>, props: Record<string, unknown> = {}) =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });
  const featureCollection = (features: unknown[]) => ({ type: 'FeatureCollection', features });
  (window as any).HorusSDK = {
    SDK_VERSION: 1,
    definePlugin: (def: unknown) => def,
    point, line, featureCollection,
    colors: { token: (name: string) => `token:${name}` },
  };
}

let started = false;
let bootstrapPromise: Promise<void> | null = null;
/** Register persisted custom sources + activate enabled plugins. Idempotent. */
export async function bootstrapExtensions(): Promise<void> {
  if (started) return;
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      installSdkGlobal();
      bootstrapCustomSources();
      await bootstrapPlugins();
      started = true;
    } catch (err) {
      console.error('[HORUS] extension bootstrap failed', err);
      throw err;
    }
  })().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}
