// Map render engine — applies a registry layer's declarative styleLayers/render to a
// live MapLibre map. Used incrementally: OsirisMap calls addRegistryLayer at the exact
// init position of the layer it's replacing (preserving z-order) and renderRegistryLayer
// from that layer's existing data-sync effect (preserving its fine-grained deps).

import type { Map as MaplibreMap } from 'maplibre-gl';
import { getRenderBindingSource, getStyleLayerSource, type RegistryLayer, type ThemeMode } from './types';
import { getLayer } from './store';

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

type SetGeo = (source: string, features: any[]) => void;

function registryLayerSources(layer: RegistryLayer): Set<string> {
  return new Set([
    ...(layer.styleLayers ?? []).map(getStyleLayerSource),
    ...(layer.render ?? []).map(getRenderBindingSource),
  ]);
}

/**
 * Register a layer's sources + style layers (idempotent — skips ones already present).
 * `theme` resolves any theme→paint/layout functions (ghost-recolored layers like cctv);
 * runtime theme changes are handled in-place by OsirisMap's setPaint effect, so this only
 * needs the initial theme to paint correctly.
 */
export function addRegistryLayer(map: MaplibreMap, layerId: string, theme: ThemeMode = 'core'): void {
  const layer = getLayer(layerId);
  if (!layer) return;

  for (const source of registryLayerSources(layer)) {
    if (!map.getSource(source)) {
      try {
        map.addSource(source, { type: 'geojson', data: EMPTY_FC } as any);
      } catch (err) {
        console.error('[OSIRIS] Registry source add failed', { layerId, source, err });
      }
    }
  }
  if (!layer.styleLayers?.length) return;
  for (const sl of layer.styleLayers ?? []) {
    if (map.getLayer(sl.id)) continue;
    const source = getStyleLayerSource(sl);
    const spec: Record<string, unknown> = { id: sl.id, type: sl.type, source };
    const paint = typeof sl.paint === 'function' ? sl.paint(theme) : sl.paint;
    const layout = typeof sl.layout === 'function' ? sl.layout(theme) : sl.layout;
    if (paint) spec.paint = paint;
    if (layout) spec.layout = layout;
    if (sl.filter) spec.filter = sl.filter;
    if (sl.minzoom != null) spec.minzoom = sl.minzoom;
    if (sl.maxzoom != null) spec.maxzoom = sl.maxzoom;
    try {
      map.addLayer(spec as any);
    } catch (err) {
      console.error('[OSIRIS] Registry layer add failed', { layerId, styleLayerId: sl.id, source, err });
    }
  }
}

/** Remove a layer's style layers (and its now-unused sources) — used when a dynamic layer is disposed. */
export function removeRegistryLayer(map: MaplibreMap, layerId: string): void {
  const layer = getLayer(layerId);
  if (!layer) return;
  const sources = registryLayerSources(layer);
  for (const sl of layer.styleLayers ?? []) {
    try { if (map.getLayer(sl.id)) map.removeLayer(sl.id); } catch { /* ignore */ }
  }
  // Drop sources no other surviving style layer still references.
  const style = (() => { try { return map.getStyle(); } catch { return null; } })();
  const stillUsed = new Set((style?.layers ?? []).map((l: any) => l.source).filter(Boolean));
  for (const src of sources) {
    if (!stillUsed.has(src)) {
      try { if (map.getSource(src)) map.removeSource(src); } catch { /* ignore */ }
    }
  }
}

/** Re-resolve themed paint/layout values without tearing down style layers or sources. */
export function updateRegistryLayerTheme(map: MaplibreMap, layerId: string, theme: ThemeMode = 'core'): void {
  const layer = getLayer(layerId);
  if (!layer?.styleLayers?.length) return;

  for (const sl of layer.styleLayers) {
    if (!map.getLayer(sl.id)) continue;
    const paint = typeof sl.paint === 'function' ? sl.paint(theme) : sl.paint;
    const layout = typeof sl.layout === 'function' ? sl.layout(theme) : sl.layout;
    if (paint) {
      for (const [key, value] of Object.entries(paint)) {
        try { map.setPaintProperty(sl.id, key, value as any); } catch { /* ignore bad plugin paint */ }
      }
    }
    if (layout) {
      for (const [key, value] of Object.entries(layout)) {
        try { map.setLayoutProperty(sl.id, key, value as any); } catch { /* ignore bad plugin layout */ }
      }
    }
  }
}

/** Push a layer's render-binding features into its map sources via setGeo. */
export function renderRegistryLayer(
  setGeo: SetGeo,
  layerId: string,
  data: any,
  active: Record<string, boolean>,
): void {
  const layer = getLayer(layerId);
  if (!layer?.render?.length) return;
  for (const binding of layer.render) {
    const source = getRenderBindingSource(binding);
    try {
      setGeo(source, binding.toFeatures(data, active));
    } catch (err) {
      console.error('[OSIRIS] Registry render binding failed', { layerId, source, err });
    }
  }
}
