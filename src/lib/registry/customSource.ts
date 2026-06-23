// No-code custom sources. A CustomSourceSpec is a fully JSON-serializable description of
// "fetch this endpoint, pull an array out of it, plot each item on the map". It is turned
// into a builtin-shaped FeedDef + RegistryLayer at registration time (the functions are
// reconstructed from the spec, so the spec itself persists cleanly to the settings store).

import { registerFeed, unregisterFeed } from './feeds';
import { registerLayer, unregisterLayer } from './store';
import type { FeedDef, RegistryLayer } from './types';

export interface CustomSourceSpec {
  /** Stable id (also the activeLayers key). Generated as `custom_<slug>`. */
  id: string;
  label: string;
  /** Existing group id (e.g. 'THREAT', 'NETWORK', 'DISPLAY'). */
  group: string;
  color: string;
  icon?: string;
  /** Feed endpoint (same-origin /api/... or absolute URL). */
  url: string;
  /** Dot path into the JSON response to the array of items, e.g. "data.items". Empty = root. */
  jsonPath?: string;
  /** Property names on each item for coordinates + label. */
  latProp: string;
  lngProp: string;
  labelProp?: string;
  markerType: 'circle' | 'symbol';
  radius?: number;
  /** Poll interval (ms). Omit → fetched once on activation. */
  intervalMs?: number;
  defaultActive?: boolean;
}

const sourceName = (id: string) => `${id}__src`;

function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}
const asArray = (v: any): any[] => (Array.isArray(v) ? v : []);

function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function popupHtml(label: string, props: Record<string, any>): string {
  const rows = Object.entries(props)
    .filter(([k]) => k !== '__label')
    .slice(0, 12)
    .map(([k, v]) => `<div style="display:flex;gap:8px;justify-content:space-between"><span style="color:#8A8880">${escapeHtml(k)}</span><span style="color:#E8E6E0">${escapeHtml(v)}</span></div>`)
    .join('');
  return `<div style="font-family:monospace;font-size:11px;min-width:160px"><div style="color:#D4AF37;font-weight:bold;margin-bottom:6px">${escapeHtml(label)}</div>${rows}</div>`;
}

/** Build the FeedDef + RegistryLayer pair a CustomSourceSpec describes. */
export function buildCustomSource(spec: CustomSourceSpec): { feed: FeedDef; layer: RegistryLayer } {
  const src = sourceName(spec.id);
  const radius = spec.radius ?? 5;

  const feed: FeedDef = {
    id: spec.id,
    url: spec.url,
    priority: 'lazy',
    activatedBy: [spec.id],
    intervalMs: spec.intervalMs,
    transform: (raw) => ({ [src]: asArray(getPath(raw, spec.jsonPath)) }),
    origin: 'custom',
  };

  const styleLayers: RegistryLayer['styleLayers'] =
    spec.markerType === 'symbol'
      ? [{
          id: `${spec.id}-sym`, source: src, type: 'symbol',
          layout: { 'text-field': ['coalesce', ['get', '__label'], ''], 'text-size': 10, 'text-font': ['Open Sans Bold'], 'text-offset': [0, 1.2], 'text-allow-overlap': false },
          paint: { 'text-color': spec.color, 'text-halo-color': '#000', 'text-halo-width': 1 },
        }]
      : [{
          id: `${spec.id}-dots`, source: src, type: 'circle',
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, Math.max(2, radius - 2), 6, radius, 12, radius + 4], 'circle-color': spec.color, 'circle-opacity': 0.85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#000', 'circle-stroke-opacity': 0.5 },
        }];

  if (spec.markerType === 'circle' && spec.labelProp) {
    styleLayers.push({
      id: `${spec.id}-label`, source: src, type: 'symbol', minzoom: 4,
      layout: { 'text-field': ['coalesce', ['get', '__label'], ''], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.4], 'text-max-width': 12, 'text-allow-overlap': false },
      paint: { 'text-color': spec.color, 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.85 },
    });
  }

  const layer: RegistryLayer = {
    id: spec.id, label: spec.label, group: spec.group, color: spec.color, icon: spec.icon,
    origin: 'custom', countBuckets: [src], defaultActive: spec.defaultActive,
    styleLayers,
    render: [{
      source: src,
      toFeatures: (data, active) => {
        if (!active[spec.id] || !Array.isArray(data[src])) return [];
        return data[src]
          .map((it: any) => {
            const lng = Number(it?.[spec.lngProp]);
            const lat = Number(it?.[spec.latProp]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
            const props: Record<string, any> = { ...it };
            if (spec.labelProp) props.__label = it?.[spec.labelProp];
            return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
          })
          .filter(Boolean);
      },
    }],
    interaction: { kind: 'popup', html: (props) => popupHtml(spec.label, props) },
  };

  return { feed, layer };
}

/** Register (or re-register) a custom source's feed + layer into the live registry. */
export function registerCustomSource(spec: CustomSourceSpec): void {
  const { feed, layer } = buildCustomSource(spec);
  registerFeed(feed);
  registerLayer(layer);
}

export function unregisterCustomSource(id: string): void {
  unregisterLayer(id);
  unregisterFeed(id);
}
