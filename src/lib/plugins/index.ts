'use client';

// Public surface for the plugin + custom-source subsystem, plus the one-shot bootstrap
// the app calls once settings are hydrated.

export {
  installPlugin, uninstallPlugin, setPluginEnabled, getPlugins, usePlugins,
  bootstrapPlugins, type PluginRecord,
} from './loader';
export {
  upsertCustomSource, removeCustomSource, getCustomSources, useCustomSources,
  bootstrapCustomSources,
} from './customSources';
export { setHostServices, getHost, type HostServices } from './host';
export type { CustomSourceSpec } from '@/lib/registry';

import { bootstrapPlugins } from './loader';
import { bootstrapCustomSources } from './customSources';

/** Minimal in-app SDK exposed on `window.OsirisSDK` so editor plugins can author without
 *  resolving the `@osiris/plugin-sdk` bare import (which a blob module can't resolve). */
function installSdkGlobal() {
  if (typeof window === 'undefined' || (window as any).OsirisSDK) return;
  const point = (lng: number, lat: number, props: Record<string, unknown> = {}) =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props });
  const line = (coords: Array<[number, number]>, props: Record<string, unknown> = {}) =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });
  const featureCollection = (features: unknown[]) => ({ type: 'FeatureCollection', features });
  (window as any).OsirisSDK = {
    SDK_VERSION: 1,
    definePlugin: (def: unknown) => def,
    point, line, featureCollection,
    colors: { token: (name: string) => `token:${name}` },
  };
}

let started = false;
/** Register persisted custom sources + activate enabled plugins. Idempotent. */
export async function bootstrapExtensions(): Promise<void> {
  if (started) return;
  started = true;
  installSdkGlobal();
  bootstrapCustomSources();
  await bootstrapPlugins();
}
