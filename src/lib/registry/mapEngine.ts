// Map render engine — applies a registry layer's declarative styleLayers/render to a
// live MapLibre map. Used incrementally: OsirisMap calls addRegistryLayer at the exact
// init position of the layer it's replacing (preserving z-order) and renderRegistryLayer
// from that layer's existing data-sync effect (preserving its fine-grained deps).

import type { Map as MaplibreMap } from 'maplibre-gl';
import { getLayer } from './store';

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

type SetGeo = (source: string, features: any[]) => void;

/** Register a layer's sources + style layers (idempotent — skips ones already present). */
export function addRegistryLayer(map: MaplibreMap, layerId: string): void {
  const layer = getLayer(layerId);
  if (!layer?.styleLayers?.length) return;

  for (const sl of layer.styleLayers) {
    if (!map.getSource(sl.source)) {
      try {
        map.addSource(sl.source, { type: 'geojson', data: EMPTY_FC } as any);
      } catch (err) {
        console.error('[OSIRIS] Registry source add failed', { layerId, source: sl.source, err });
      }
    }
  }
  for (const sl of layer.styleLayers) {
    if (map.getLayer(sl.id)) continue;
    const spec: Record<string, unknown> = { id: sl.id, type: sl.type, source: sl.source };
    if (sl.paint) spec.paint = sl.paint;
    if (sl.layout) spec.layout = sl.layout;
    if (sl.filter) spec.filter = sl.filter;
    if (sl.minzoom != null) spec.minzoom = sl.minzoom;
    if (sl.maxzoom != null) spec.maxzoom = sl.maxzoom;
    try {
      map.addLayer(spec as any);
    } catch (err) {
      console.error('[OSIRIS] Registry layer add failed', { layerId, styleLayerId: sl.id, source: sl.source, err });
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
    try {
      setGeo(binding.source, binding.toFeatures(data, active));
    } catch (err) {
      console.error('[OSIRIS] Registry render binding failed', { layerId, source: binding.source, err });
    }
  }
}
