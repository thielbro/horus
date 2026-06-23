// Host services bridge. The plugin runtime is decoupled from React: the app (page.tsx,
// OsirisMap) registers live capabilities here, and a plugin's OsirisContext delegates to
// whatever is currently wired. Everything is null-safe so a plugin calling a service the
// host hasn't wired yet degrades gracefully instead of throwing.

import type { Map as MaplibreMap } from 'maplibre-gl';

export interface HostServices {
  map: MaplibreMap | null;
  /** Current merged data buckets. */
  getData: () => Record<string, unknown[]>;
  /** Merge buckets into the global store (advanced — most plugins use a feed). */
  setData: (buckets: Record<string, unknown[]>) => void;
  flyTo: (o: { lat: number; lng: number; zoom?: number }) => void;
  toast: (msg: string, kind?: 'info' | 'warn' | 'error') => void;
  openCamera: (cam: Record<string, unknown>) => void;
  openLiveFeed: (url: string, name?: string) => void;
  openEntityGraph: (ref: { type: string; id: string; label?: string; properties?: Record<string, any> }) => void;
}

const host: HostServices = {
  map: null,
  getData: () => ({}),
  setData: () => {},
  flyTo: () => {},
  toast: (msg) => console.info('[OSIRIS plugin toast]', msg),
  openCamera: () => {},
  openLiveFeed: () => {},
  openEntityGraph: () => {},
};

/** Patch in the live app capabilities (called by page.tsx / OsirisMap). */
export function setHostServices(patch: Partial<HostServices>): void {
  Object.assign(host, patch);
}

export function getHost(): HostServices {
  return host;
}
