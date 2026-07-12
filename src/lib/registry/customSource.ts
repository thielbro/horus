import { registerFeed, unregisterFeed } from './feeds';
import { registerLayer, unregisterLayer } from './store';
import type { FeedDef, RegistryLayer } from './types';

export type CustomSourceType = 'live-camera' | 'snapshot-camera' | 'json-points' | 'geojson' | 'tile-layer';
export type CustomStreamFormat = 'auto' | 'hls' | 'mp4' | 'mjpeg' | 'iframe';

export interface CustomSourceSpec {
  version: 2;
  sourceType: CustomSourceType;
  id: string;
  label: string;
  group: string;
  color: string;
  icon?: string;
  url: string;
  defaultActive?: boolean;
  intervalMs?: number;
  lat?: number;
  lng?: number;
  streamFormat?: CustomStreamFormat;
  jsonPath?: string;
  latProp?: string;
  lngProp?: string;
  labelProp?: string;
  markerType?: 'circle' | 'symbol';
  radius?: number;
  tileKind?: 'raster' | 'vector';
  sourceLayer?: string;
  minZoom?: number;
  maxZoom?: number;
  attribution?: string;
}

export function migrateCustomSource(input: any): CustomSourceSpec {
  if (input?.version === 2 && input?.sourceType) return input as CustomSourceSpec;
  return {
    ...input,
    version: 2,
    sourceType: 'json-points',
    latProp: input?.latProp || 'lat',
    lngProp: input?.lngProp || 'lng',
    markerType: input?.markerType || 'circle',
  };
}

const sourceName = (id: string) => `${id}__src`;
const getPath = (obj: any, path?: string) => path ? path.split('.').reduce((acc, key) => acc == null ? acc : acc[key], obj) : obj;
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const popupHtml = (label: string, props: Record<string, any>) => `<div style="font-family:monospace;font-size:11px"><b style="color:#D4AF37">${escapeHtml(label)}</b>${Object.entries(props).slice(0, 12).map(([k,v]) => `<div>${escapeHtml(k)}: ${escapeHtml(v)}</div>`).join('')}</div>`;

function cameraLayer(spec: CustomSourceSpec): RegistryLayer {
  const src = sourceName(spec.id);
  const autoType = /\.m3u8(?:\?|$)/i.test(spec.url) ? 'hls' : /\.mp4(?:\?|$)/i.test(spec.url) ? 'mp4' : /mjpeg|\.mpe?g(?:\?|$)/i.test(spec.url) ? 'mjpeg' : /youtube|embed|player/i.test(spec.url) ? 'iframe' : 'snapshot';
  const streamType = spec.sourceType === 'snapshot-camera' ? 'snapshot' : spec.streamFormat === 'auto' ? autoType : spec.streamFormat;
  return {
    id: spec.id, label: spec.label, group: spec.group, color: spec.color, icon: 'Camera', origin: 'custom', defaultActive: spec.defaultActive,
    styleLayers: [{ id: `${spec.id}-dots`, source: src, type: 'circle', paint: { 'circle-radius': 7, 'circle-color': spec.color, 'circle-stroke-width': 2, 'circle-stroke-color': '#000' } }],
    render: [{ source: src, toFeatures: (_data, active) => active[spec.id] ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [spec.lng, spec.lat] }, properties: { id: spec.id, name: spec.label, city: 'Custom', country: 'Custom', source: 'Custom Source', ...(spec.sourceType === 'snapshot-camera' ? { feed_url: spec.url } : { stream_url: spec.url }), stream_type: streamType, refresh_interval_ms: spec.intervalMs } }] : [] }],
    interaction: { kind: 'camera' },
  };
}

function pointLayer(spec: CustomSourceSpec): { feed: FeedDef; layer: RegistryLayer } {
  const src = sourceName(spec.id);
  const feed: FeedDef = { id: spec.id, url: spec.url, priority: 'lazy', activatedBy: [spec.id], intervalMs: spec.intervalMs, origin: 'custom', transform: raw => {
    const selected = getPath(raw, spec.jsonPath);
    if (spec.sourceType === 'geojson') {
      const features = selected?.type === 'FeatureCollection' ? selected.features : selected?.type === 'Feature' ? [selected] : [];
      return { [src]: features };
    }
    return { [src]: Array.isArray(selected) ? selected : [] };
  } };
  const radius = spec.radius || 5;
  const styleLayers: RegistryLayer['styleLayers'] = [{ id: `${spec.id}-dots`, source: src, type: 'circle', paint: { 'circle-radius': radius, 'circle-color': spec.color, 'circle-opacity': .85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#000' } }];
  const layer: RegistryLayer = {
    id: spec.id, label: spec.label, group: spec.group, color: spec.color, icon: spec.sourceType === 'geojson' ? 'FileJson' : spec.icon, origin: 'custom', countBuckets: [src], defaultActive: spec.defaultActive, styleLayers,
    render: [{ source: src, toFeatures: (data, active) => {
      if (!active[spec.id] || !Array.isArray(data[src])) return [];
      if (spec.sourceType === 'geojson') return data[src];
      return data[src].flatMap((item: any) => {
        const lat = Number(item?.[spec.latProp || 'lat']); const lng = Number(item?.[spec.lngProp || 'lng']);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { ...item, __label: spec.labelProp ? item[spec.labelProp] : undefined } }] : [];
      });
    } }],
    interaction: { kind: 'popup', html: props => popupHtml(spec.label, props) },
  };
  return { feed, layer };
}

function tileLayer(spec: CustomSourceSpec): RegistryLayer {
  const src = sourceName(spec.id);
  const vector = spec.tileKind === 'vector';
  return {
    id: spec.id, label: spec.label, group: spec.group, color: spec.color, icon: 'Layers', origin: 'custom', defaultActive: spec.defaultActive,
    mapSourceSpec: { id: src, definition: { type: vector ? 'vector' : 'raster', tiles: [spec.url], minzoom: spec.minZoom ?? 0, maxzoom: spec.maxZoom ?? 22, attribution: spec.attribution, ...(vector ? {} : { tileSize: 256 }) } },
    styleLayers: [{ id: `${spec.id}-tiles`, source: src, type: vector ? 'line' : 'raster', ...(vector && spec.sourceLayer ? { sourceLayer: spec.sourceLayer } : {}), paint: vector ? { 'line-color': spec.color, 'line-width': 1.5 } : { 'raster-opacity': .85 } }],
  };
}

export function buildCustomSource(raw: CustomSourceSpec): { feed?: FeedDef; layer: RegistryLayer } {
  const spec = migrateCustomSource(raw);
  if (spec.sourceType === 'live-camera' || spec.sourceType === 'snapshot-camera') return { layer: cameraLayer(spec) };
  if (spec.sourceType === 'tile-layer') return { layer: tileLayer(spec) };
  return pointLayer(spec);
}

export function registerCustomSource(spec: CustomSourceSpec): void { const built = buildCustomSource(spec); if (built.feed) registerFeed(built.feed); registerLayer(built.layer); }
export function unregisterCustomSource(id: string): void { unregisterLayer(id); unregisterFeed(id); }
