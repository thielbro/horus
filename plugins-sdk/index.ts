/**
 * @osiris/plugin-sdk — v1
 *
 * The contract every OSIRIS plugin is written against. Plugins are TRUSTED,
 * in-process extensions (authored by the operator / their agents — never published),
 * so transforms and React components run directly in the host. There is no sandbox,
 * permission model, or IPC marshaling.
 *
 * A plugin has up to two entry points, because the desktop app splits the renderer
 * from the embedded Next.js/Node server:
 *   - index.ts   → runs in the RENDERER. Layers, panels, UI, client-side feeds.
 *   - server.ts  → runs in NODE (optional). Feeds needing secrets / CORS-bypass /
 *                  Node-only libs, plus custom API routes. Functions never cross
 *                  between the two; the client references a server feed by id.
 *
 * STATUS: This file is the locked interface. The runtime helpers below
 * (definePlugin, point, line, featureCollection, colors) are real and usable today.
 * The host-provided services (OsirisContext.*) are typed here but only become live
 * once the registry engine (Phase 2) is implemented.
 */

import type { ReactNode, ComponentType } from 'react';
import type { Feature, FeatureCollection, Point, LineString, Position } from 'geojson';
import type { Map as MaplibreMap } from 'maplibre-gl';

export const SDK_VERSION = 1 as const;

/* ────────────────────────────────────────────────────────────────────────── *
 * Core
 * ────────────────────────────────────────────────────────────────────────── */

/** Identity helper — wraps a definition for type inference. Returns it unchanged. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

export interface PluginDefinition {
  /** Unique kebab-case id. Auto-namespaces every id this plugin registers. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** SDK major version targeted. The host refuses to load on a mismatch. */
  sdk?: number;
  /** Other plugin ids to activate before this one. */
  dependsOn?: string[];
  activate(ctx: OsirisContext): void | Promise<void>;
  /** Optional — the host auto-disposes everything registered via ctx by plugin id. */
  deactivate?(ctx: OsirisContext): void | Promise<void>;
}

/** The renderer-side API surface handed to a plugin's `activate`. */
export interface OsirisContext {
  readonly plugin: Readonly<{ id: string; name: string; version: string }>;

  // ── registration (each returns a Disposable; also auto-cleaned on disable/reload) ──
  registerFeed(def: FeedDef): Disposable;
  registerLayer(def: LayerDef): Disposable;
  registerGroup(def: GroupDef): Disposable;
  registerPanel(def: PanelDef): Disposable;
  registerReconTool(def: ReconToolDef): Disposable;
  registerCommand(def: CommandDef): Disposable;
  registerTheme(def: ThemeDef): Disposable;

  // ── services ──
  readonly data: DataApi;
  readonly settings: SettingsApi;
  readonly map: MapApi;
  readonly ui: UiApi;
  readonly log: Logger;
  /** Client-side fetch. For CORS-blocked or key-bearing feeds, use a server feed instead. */
  fetch(url: string, init?: OsirisFetchInit): Promise<Response>;
  on<E extends keyof OsirisEvents>(event: E, handler: (payload: OsirisEvents[E]) => void): Disposable;
}

export interface Disposable {
  dispose(): void;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Feeds
 * ────────────────────────────────────────────────────────────────────────── */

/** A fetch result: one or more named buckets merged into the global data store. */
export type DataBuckets = Record<string, unknown[]>;

export interface FeedDef {
  id: string;
  fetch:
    | { kind: 'endpoint'; url: string; transform?: (raw: unknown) => DataBuckets }
    | { kind: 'custom'; run: (c: FeedRunContext) => Promise<DataBuckets> };
  /** Omit → fetch once when the first dependent layer activates. */
  intervalMs?: number;
  /** 'core' → fetched at startup; 'lazy' (default) → on first dependent layer activation. */
  priority?: 'core' | 'lazy';
  /** Default false — polling is otherwise skipped while the window is hidden. */
  pollWhileHidden?: boolean;
}

export interface FeedRunContext {
  signal: AbortSignal;
  fetch: typeof fetch;
  log: Logger;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Layers
 * ────────────────────────────────────────────────────────────────────────── */

export type BuiltinGroup =
  | 'SDK' | 'AVIATION' | 'MARITIME' | 'SURVEIL'
  | 'HAZARD' | 'THREAT' | 'NETWORK' | 'DISPLAY';

/** A hex string (`'#26C6DA'`) or a theme-resolved palette token (`'token:flight.mil'`). */
export type Color = string;

/** A lucide-react icon name (`'Ship'`) or a registered custom icon id. */
export type IconRef = string;

export type DataSnapshot = Record<string, unknown[]>;
export type ActiveLayers = Record<string, boolean>;

export interface LayerDef {
  id: string;
  label: string;
  /** A builtin group id (see BuiltinGroup) or a custom group you registered. */
  group: BuiltinGroup | string;
  color: Color;
  icon?: IconRef;
  /** Feed ids this layer needs fetched — builtin (`'flights'`) or your own (`'ais'`). */
  feeds?: string[];
  defaultActive?: boolean;
  /** Buckets summed for the sidebar count badge. */
  countBuckets?: string[];
  /** MapLibre style layers, registered once at map init. */
  styleLayers: StyleLayerDef[];
  /** Data → map source bindings, re-applied on data/active change. */
  render: RenderBinding[];
  interaction?: Interaction;
  comingSoon?: boolean;
}

export interface StyleLayerDef {
  id: string;
  type: 'circle' | 'symbol' | 'line' | 'fill' | 'heatmap';
  /** Defaults to the layer id. Auto-namespaced to avoid collisions. */
  mapSource?: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: unknown[];
  minzoom?: number;
  maxzoom?: number;
}

export type RenderBinding = {
  mapSource: string;
  source:
    | { bucket: string; toFeatures?: (items: any[]) => Feature[]; decimate?: number }
    | { compute: (data: DataSnapshot, active: ActiveLayers) => Feature[]; deps?: string[] };
};

export type Interaction =
  | { kind: 'popup'; html: (props: Record<string, any>) => string }
  | { kind: 'panel'; render: (entity: any) => ReactNode }
  | { kind: 'camera' }
  | { kind: 'liveFeed'; url: (props: any) => string; name?: (props: any) => string }
  | { kind: 'entityGraph'; map: (props: any) => EntityRef }
  | { kind: 'custom'; onClick: (e: LayerClickEvent) => void };

export interface EntityRef {
  type: 'aircraft' | 'vessel' | 'ip' | 'country' | (string & {});
  id: string;
  label?: string;
  properties?: Record<string, any>;
}

export interface LayerClickEvent {
  lng: number;
  lat: number;
  layerId: string;
  props: Record<string, any>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Panels, recon tools, commands, groups, themes
 * ────────────────────────────────────────────────────────────────────────── */

export interface PanelDef {
  id: string;
  title: string;
  icon?: IconRef;
  /** Default 'right-rail'. */
  placement?: 'right-rail' | 'left' | 'modal' | 'mobile-drawer';
  component: ComponentType<PanelProps>;
  defaultOpen?: boolean;
  /** e.g. 'shift+a' */
  shortcut?: string;
}

export interface PanelProps {
  ctx: OsirisContext;
  close(): void;
}

export interface ReconToolDef {
  id: string;
  label: string;
  group?: string;
  inputs: ReconInput[];
  run(args: Record<string, any>, c: FeedRunContext): Promise<ReconResult>;
  renderResult?: ComponentType<{ result: ReconResult }>;
}

export interface ReconInput {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface ReconResult {
  ok: boolean;
  title?: string;
  data?: unknown;
  error?: string;
}

export interface CommandDef {
  id: string;
  title: string;
  shortcut?: string;
  run(ctx: OsirisContext): void;
}

export interface GroupDef {
  id: string;
  label: string;
  fullLabel: string;
  color: Color;
  order?: number;
}

export interface ThemeDef {
  id: string;
  label: string;
  base: 'core' | 'ghost';
  /** CSS-variable palette tokens, e.g. { 'flight.mil': '#FF0000' }. */
  tokens: Record<string, string>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Services
 * ────────────────────────────────────────────────────────────────────────── */

export interface DataApi {
  get<T = unknown>(bucket: string): T[] | undefined;
  snapshot(): DataSnapshot;
  /** Write your own buckets directly (advanced — most plugins use a feed instead). */
  set(buckets: DataBuckets): void;
  subscribe(buckets: string[], cb: (snapshot: DataSnapshot) => void): Disposable;
}

export interface SettingsApi {
  get<T>(key: string, fallback?: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  onChange(cb: (key: string) => void): Disposable;
  registerSection(def: SettingsSection): Disposable;
}

export interface SettingsSection {
  id: string;
  title: string;
  component: ComponentType<{ ctx: OsirisContext }>;
}

export interface MapApi {
  flyTo(o: { lat: number; lng: number; zoom?: number }): void;
  getView(): { lat: number; lng: number; zoom: number };
  setLayerVisible(layerId: string, visible: boolean): void;
  onClick(cb: (e: MapClickEvent) => void): Disposable;
  /** Escape hatch — direct MapLibre access. Bypasses the registry; advanced use only. */
  getInstance(): MaplibreMap | null;
}

export interface MapClickEvent {
  lng: number;
  lat: number;
  features?: unknown[];
}

export interface UiApi {
  toast(msg: string, kind?: 'info' | 'warn' | 'error'): void;
  openCamera(cam: CameraEntity): void;
  openLiveFeed(url: string, name?: string): void;
  openEntityGraph(ref: EntityRef): void;
  confirm(msg: string): Promise<boolean>;
}

export interface CameraEntity {
  id: string;
  lat: number;
  lng: number;
  name: string;
  feed_url?: string;
  stream_url?: string;
  [key: string]: unknown;
}

export interface OsirisEvents {
  ready: void;
  dataUpdate: { buckets: string[]; snapshot: DataSnapshot };
  layerToggle: { layerId: string; active: boolean };
  viewChange: { lat: number; lng: number; zoom: number };
  themeChange: { theme: string };
  mapClick: MapClickEvent;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export type OsirisFetchInit = RequestInit;

/* ────────────────────────────────────────────────────────────────────────── *
 * Server entry (server.ts) — runs in Node / the embedded Next server
 * ────────────────────────────────────────────────────────────────────────── */

export function definePluginServer(def: ServerPluginDefinition): ServerPluginDefinition {
  return def;
}

export interface ServerPluginDefinition {
  activate(ctx: ServerContext): void | Promise<void>;
}

export interface ServerContext {
  /** Register a feed that runs in Node — has secrets and SSRF-guarded fetch. */
  registerFeed(def: ServerFeedDef): Disposable;
  /** Mounts a handler under /api/plugins/<pluginId>/<path>. */
  registerRoute(path: string, handler: RouteHandler): Disposable;
  /** Reads a key the user configured in Settings (the .env-equivalent store). */
  getSecret(key: string): string | undefined;
  /** Reuses the app's ssrf-guard + stealthFetch. */
  fetch: GuardedFetch;
  log: Logger;
}

export interface ServerFeedDef {
  id: string;
  run(c: {
    signal: AbortSignal;
    fetch: GuardedFetch;
    getSecret(key: string): string | undefined;
  }): Promise<DataBuckets>;
  intervalMs?: number;
  priority?: 'core' | 'lazy';
}

export type RouteHandler = (req: Request) => Response | Promise<Response>;
export type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/* ────────────────────────────────────────────────────────────────────────── *
 * GeoJSON helpers (real implementations — usable today)
 * ────────────────────────────────────────────────────────────────────────── */

export function point(lng: number, lat: number, props: Record<string, unknown> = {}): Feature<Point> {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
}

export function line(coords: Array<[number, number]>, props: Record<string, unknown> = {}): Feature<LineString> {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords as Position[] },
    properties: props,
  };
}

export function featureCollection(features: Feature[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

/** Build a theme-palette color token, e.g. colors.token('flight.mil') → 'token:flight.mil'. */
export const colors = {
  token(name: string): Color {
    return `token:${name}`;
  },
};

/* ── Re-exported primitives for plugin authors ── */
export type { Feature, FeatureCollection, Point, LineString } from 'geojson';
export type { ReactNode, ComponentType } from 'react';
