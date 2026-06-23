// OSIRIS layer/source registry — internal types.
//
// This is the declarative model that replaces the three hardcoded copies of the layer
// list (LayerPanel.getLayerGroups, OsirisMap addLayer/setGeo, page.tsx fetch wiring).
// It is migrated in via the strangler pattern: each step moves one consumer onto the
// registry with zero visible change. Feed/render fields are added in later steps; this
// first cut carries only the metadata the sidebar needs, and is designed to converge
// with the @osiris/plugin-sdk LayerDef so builtins and plugins share one contract.

export type ThemeMode = 'core' | 'ghost';

/** A color that may depend on the active theme (e.g. flight colors differ in ghost mode). */
export type ResolvableColor = string | ((theme: ThemeMode) => string);

export interface RegistryGroup {
  id: string;
  /** Short label shown in the collapsed sidebar rail. */
  label: string;
  /** Expanded label shown in the fly-out header. */
  fullLabel: string;
  color: ResolvableColor;
  order: number;
  origin?: RegistryOrigin;
  pluginId?: string;
}

/** Where a registry entry came from. Builtins are undefined/'builtin'; the rest are dynamic. */
export type RegistryOrigin = 'builtin' | 'custom' | 'plugin';

/**
 * Click behaviour for a layer's features. Builtins still wire clicks imperatively in
 * OsirisMap; dynamic (custom/plugin) layers declare interaction here and the map wires it
 * generically. `props` is the clicked feature's GeoJSON properties.
 */
export type LayerInteraction =
  | { kind: 'popup'; html: (props: Record<string, any>) => string }
  | { kind: 'custom'; onClick: (e: { lng: number; lat: number; layerId: string; props: Record<string, any> }) => void }
  | { kind: 'entityGraph'; map: (props: Record<string, any>) => { type: string; id: string; label?: string; properties?: Record<string, any> } }
  | { kind: 'camera'; toCamera?: (props: Record<string, any>) => Record<string, any> }
  | { kind: 'liveFeed'; url: (props: Record<string, any>) => string; name?: (props: Record<string, any>) => string };

export interface RegistryLayer {
  /** Stable id — equals the `activeLayers` key (and the `?layers=` URL token). */
  id: string;
  label: string;
  /** Owning group id. */
  group: string;
  color: ResolvableColor;
  /** Provenance — undefined ⇒ builtin. Dynamic entries are 'custom' or 'plugin'. */
  origin?: RegistryOrigin;
  /** For origin: 'plugin' — the owning plugin id (used to clear a plugin's contributions). */
  pluginId?: string;
  /** Declarative click behaviour (dynamic layers). */
  interaction?: LayerInteraction;
  /** Lucide icon name resolved via icons.tsx. */
  icon?: string;
  /** Data-store buckets summed for the sidebar count badge (was the comma `dataKey`). */
  countBuckets?: string[];
  defaultActive?: boolean;
  /** Greys the toggle and shows a "coming soon" alert instead of activating. */
  comingSoon?: boolean;
  /**
   * Hide from the sidebar (no toggle). Used for always-on layers (conflict-zones), layers
   * driven by a flag with no UI (sigint-news / news_intel), or imperatively-rendered overlays
   * whose style layers we still want defined in the registry (ip-sweep, scan-targets).
   * The map engine still registers/renders headless layers — only the sidebar skips them.
   */
  headless?: boolean;
  /** MapLibre style layers, registered at map init (the former addLayer calls). */
  styleLayers?: StyleLayerSpec[];
  /** Data → map-source render bindings (the former setGeo specs). */
  render?: RenderBinding[];
}

/** A value that may be a constant or computed from the active theme (e.g. ghost recolors). */
export type Themed<T> = T | ((theme: ThemeMode) => T);

/** A single MapLibre style layer bound to a geojson source. */
export interface StyleLayerSpec {
  id: string;
  source: string;
  type: 'circle' | 'symbol' | 'line' | 'fill' | 'heatmap';
  /** Paint object, or a theme→paint function for ghost-recolored layers (cctv, surveillance). */
  paint?: Themed<Record<string, unknown>>;
  /** Layout object, or a theme→layout function. */
  layout?: Themed<Record<string, unknown>>;
  filter?: unknown[];
  minzoom?: number;
  maxzoom?: number;
}

/** Computes the features for a map source from the data store + active layer state. */
export interface RenderBinding {
  source: string;
  toFeatures: (data: any, active: Record<string, boolean>) => any[];
}

export function resolveColor(c: ResolvableColor, theme: ThemeMode): string {
  return typeof c === 'function' ? c(theme) : c;
}

/** A fetch result merged into the page data store: bucket name → array of entities. */
export type DataBuckets = Record<string, unknown[]>;

/**
 * A data source. `core` feeds load at startup and poll regardless of layers (they back
 * panels); `lazy` feeds load once when any of their `activatedBy` layer keys is active,
 * and poll only while active if `intervalMs` is set.
 */
export interface FeedDef {
  id: string;
  url: string;
  /** Maps the raw response into named data buckets; identity if omitted. */
  transform?: (raw: any) => DataBuckets;
  /** Poll interval in ms. Omitted → fetched once, never polled. */
  intervalMs?: number;
  priority?: 'core' | 'lazy';
  /** Delay (ms) before the initial fetch (core feeds only, e.g. markets = 800). */
  startupDelayMs?: number;
  /** `activeLayers` keys that trigger a lazy feed. */
  activatedBy?: string[];
  origin?: RegistryOrigin;
  pluginId?: string;
}
