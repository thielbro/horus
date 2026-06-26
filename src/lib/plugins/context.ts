// The renderer-side HorusContext handed to a plugin's activate(). It adapts the
// @horus/plugin-sdk shapes (LayerDef/FeedDef/GroupDef) into the internal registry,
// tracks every registration for disposal, and exposes live host services.
//
// Fully wired: registerLayer / registerFeed (endpoint) / registerGroup + data/map/ui/
// log/settings/fetch services. Not yet wired (logged, non-throwing no-ops): panels,
// recon tools, commands, themes, custom-run feeds, the event bus beyond what the host
// emits. A plugin calling those degrades gracefully instead of crashing the host.

import {
  registerLayer, unregisterLayer,
  registerGroup, unregisterGroup,
} from '../registry/store';
import { registerFeed, unregisterFeed } from '../registry/feeds';
import type { FeedDef, RegistryGroup, RegistryLayer, LayerInteraction } from '../registry/types';
import { getHost } from './host';
import {
  formatValidationErrors,
  validatePluginFeedDefinition,
  validatePluginGroupDefinition,
  validatePluginLayerDefinition,
} from './validation';

interface Disposable { dispose(): void; }

export interface PluginContextHandle {
  ctx: any; // HorusContext-shaped (typed against @horus/plugin-sdk in plugin code)
  /** Tear down everything the plugin registered. */
  dispose(): void;
  /** After activate(): wire feed activation from each layer's `feeds: string[]`. */
  finalize(): void;
}

const INTERACTION_KINDS = new Set(['popup', 'custom', 'entityGraph', 'camera', 'liveFeed']);

export function createPluginContext(pluginId: string, meta: { name: string; version: string }): PluginContextHandle {
  const ns = (s: string) => `${pluginId}__${s}`;
  const disposers: Array<() => void> = [];
  const fetchControllers = new Set<AbortController>();
  const registeredFeeds = new Map<string, FeedDef>();
  const layerFeedDeps: Array<{ layerId: string; feeds: string[] }> = [];
  const warned = new Set<string>();
  const warnOnce = (what: string) =>
    warned.has(what) || (warned.add(what), console.warn(`[HORUS plugin:${pluginId}] ${what} is not wired yet — ignored.`));

  const adaptInteraction = (i: any): LayerInteraction | undefined => {
    if (!i || !INTERACTION_KINDS.has(i.kind)) { if (i) warnOnce(`interaction kind '${i.kind}'`); return undefined; }
    return i as LayerInteraction;
  };

  const adaptLayer = (def: any): RegistryLayer => {
    const styleLayers = (def.styleLayers ?? []).map((sl: any) => ({
      id: ns(sl.id), mapSource: ns(sl.mapSource ?? sl.id), type: sl.type,
      paint: sl.paint, layout: sl.layout, filter: sl.filter, minzoom: sl.minzoom, maxzoom: sl.maxzoom,
    }));
    const render = (def.render ?? []).map((rb: any) => {
      const mapSource = ns(rb.mapSource);
      const s = rb.source ?? {};
      if (typeof s.compute === 'function') {
        return { mapSource, toFeatures: (data: any, active: any) => (active[def.id] ? s.compute(data, active) : []) };
      }
      const bucket: string = s.bucket;
      const decimate: number = s.decimate ?? 1;
      const toF = s.toFeatures;
      return {
        mapSource,
        toFeatures: (data: any, active: any) => {
          if (!active[def.id]) return [];
          let arr: any[] = Array.isArray(data[bucket]) ? data[bucket] : [];
          if (decimate > 1) arr = arr.filter((_, i) => i % decimate === 0);
          return typeof toF === 'function' ? toF(arr) : arr;
        },
      };
    });
    return {
      id: def.id, label: def.label, group: def.group, color: def.color, icon: def.icon,
      origin: 'plugin', pluginId, countBuckets: def.countBuckets, defaultActive: def.defaultActive,
      comingSoon: def.comingSoon, interaction: adaptInteraction(def.interaction), styleLayers, render,
    };
  };

  const adaptFeed = (def: any): FeedDef | null => {
    const f = def.fetch ?? {};
    if (f.kind === 'custom') { warnOnce('custom-run feeds'); return null; }
    const url: string | undefined = f.kind === 'endpoint' ? f.url : def.url;
    if (!url) { warnOnce('feed without an endpoint url'); return null; }
    return {
      id: def.id, url, transform: f.transform ?? def.transform,
      intervalMs: def.intervalMs, priority: def.priority ?? 'lazy',
      activatedBy: def.activatedBy ?? [], origin: 'plugin', pluginId,
    };
  };

  const track = (undo: () => void): Disposable => {
    disposers.push(undo);
    return { dispose: undo };
  };

  const kvKey = (key: string) => `horus:plugin:${pluginId}:${key}`;
  const logSettingsError = (op: string, err: unknown) => {
    console.warn(`[HORUS plugin:${pluginId}] settings.${op} failed`, err);
  };

  const pluginFetch = (url: string, init: RequestInit = {}) => {
    const controller = new AbortController();
    const externalSignal = init.signal;
    let removeExternalAbort: (() => void) | null = null;

    if (externalSignal?.aborted) {
      controller.abort();
    } else if (externalSignal) {
      const onAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
    }

    fetchControllers.add(controller);
    return fetch(url, { ...init, signal: controller.signal })
      .finally(() => {
        removeExternalAbort?.();
        fetchControllers.delete(controller);
      });
  };

  const ctx = {
    plugin: Object.freeze({ id: pluginId, name: meta.name, version: meta.version }),

    registerLayer: (def: any) => {
      const validation = validatePluginLayerDefinition(def);
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      registerLayer(adaptLayer(validation.value));
      if (Array.isArray(def.feeds) && def.feeds.length) layerFeedDeps.push({ layerId: def.id, feeds: def.feeds });
      return track(() => unregisterLayer(def.id));
    },
    registerFeed: (def: any) => {
      const validation = validatePluginFeedDefinition(def);
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      const f = adaptFeed(validation.value);
      if (!f) return { dispose() {} };
      registeredFeeds.set(f.id, f);
      registerFeed(f);
      return track(() => unregisterFeed(f.id));
    },
    registerGroup: (def: any) => {
      const validation = validatePluginGroupDefinition(def);
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      const clean = validation.value;
      const g: RegistryGroup = { id: clean.id, label: clean.label, fullLabel: clean.fullLabel, color: clean.color, order: clean.order ?? 100, origin: 'plugin', pluginId };
      registerGroup(g);
      return track(() => unregisterGroup(clean.id));
    },
    registerPanel: () => { warnOnce('registerPanel'); return { dispose() {} }; },
    registerReconTool: () => { warnOnce('registerReconTool'); return { dispose() {} }; },
    registerCommand: () => { warnOnce('registerCommand'); return { dispose() {} }; },
    registerTheme: () => { warnOnce('registerTheme'); return { dispose() {} }; },

    data: {
      get: (bucket: string) => getHost().getData()[bucket],
      snapshot: () => getHost().getData(),
      set: (buckets: Record<string, unknown[]>) => getHost().setData(buckets),
      subscribe: () => { warnOnce('data.subscribe'); return { dispose() {} }; },
    },
    settings: {
      get: (key: string, fallback?: unknown) => { try { const v = localStorage.getItem(kvKey(key)); return v == null ? fallback : JSON.parse(v); } catch (err) { logSettingsError('get', err); return fallback; } },
      set: (key: string, value: unknown) => { try { localStorage.setItem(kvKey(key), JSON.stringify(value)); } catch (err) { logSettingsError('set', err); } },
      delete: (key: string) => { try { localStorage.removeItem(kvKey(key)); } catch (err) { logSettingsError('delete', err); } },
      onChange: () => ({ dispose() {} }),
      registerSection: () => { warnOnce('settings.registerSection'); return { dispose() {} }; },
    },
    map: {
      flyTo: (o: { lat: number; lng: number; zoom?: number }) => getHost().flyTo(o),
      getView: () => { const m = getHost().map; const c = m?.getCenter(); return { lat: c?.lat ?? 0, lng: c?.lng ?? 0, zoom: m?.getZoom() ?? 0 }; },
      setLayerVisible: (layerId: string, visible: boolean) => { const m = getHost().map; if (m?.getLayer(ns(layerId))) m.setLayoutProperty(ns(layerId), 'visibility', visible ? 'visible' : 'none'); },
      onClick: (cb: (e: any) => void) => { const m = getHost().map; if (!m) return { dispose() {} }; const h = (e: any) => cb({ lng: e.lngLat.lng, lat: e.lngLat.lat }); m.on('click', h); return track(() => m.off('click', h)); },
      getInstance: () => getHost().map,
    },
    ui: {
      toast: (msg: string, kind?: 'info' | 'warn' | 'error') => getHost().toast(msg, kind),
      openCamera: (cam: any) => getHost().openCamera(cam),
      openLiveFeed: (url: string, name?: string) => getHost().openLiveFeed(url, name),
      openEntityGraph: (ref: any) => getHost().openEntityGraph(ref),
      confirm: async (msg: string) => (typeof window !== 'undefined' ? window.confirm(msg) : false),
    },
    log: {
      debug: (m: string, ...a: unknown[]) => console.debug(`[${pluginId}]`, m, ...a),
      info: (m: string, ...a: unknown[]) => console.info(`[${pluginId}]`, m, ...a),
      warn: (m: string, ...a: unknown[]) => console.warn(`[${pluginId}]`, m, ...a),
      error: (m: string, ...a: unknown[]) => console.error(`[${pluginId}]`, m, ...a),
    },
    fetch: (url: string, init?: RequestInit) => pluginFetch(url, init),
    on: () => { warnOnce('event subscriptions'); return { dispose() {} }; },
  };

  const finalize = () => {
    for (const { layerId, feeds } of layerFeedDeps) {
      for (const feedId of feeds) {
        const f = registeredFeeds.get(feedId);
        if (f && f.priority !== 'core' && !(f.activatedBy ?? []).includes(layerId)) {
          f.activatedBy = [...(f.activatedBy ?? []), layerId];
        }
      }
    }
  };

  const dispose = () => {
    fetchControllers.forEach((controller) => controller.abort());
    fetchControllers.clear();
    while (disposers.length) {
      try {
        disposers.pop()!();
      } catch (err) {
        console.error(`[HORUS plugin:${pluginId}] dispose failed`, err);
      }
    }
  };

  return { ctx, dispose, finalize };
}
