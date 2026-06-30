// Saved-workspace snapshot model — pure, dependency-free logic.
//
// This module is imported by the settings store, page.tsx, AND the workspace tests
// (which `import()` this .ts file directly under Node's type-stripping). It must
// therefore stay free of `@/` path aliases, React, and any non-erasable TS syntax
// (no enums / namespaces / param-properties).
//
// A workspace captures the persisted UI + map state worth restoring. The schema is
// `version: 1`; `normalizeWorkspaceSnapshot` is the only migration surface — it fills
// absent fields from defaults so older/partial snapshots load without throwing.

export type WorkspaceTheme = 'core' | 'ghost' | 'custom';
export type WorkspaceProjection = 'globe' | 'mercator';
export type WorkspaceMapStyle = 'dark' | 'satellite';

export interface WorkspaceView {
  latitude: number;
  longitude: number;
  zoom: number;
}

/** Panel / sidebar visibility worth restoring with a layout. */
export interface WorkspaceUi {
  showLayers: boolean;
  showMarkets: boolean;
  showAlerts: boolean;
  showScmPanel: boolean;
  showIntel: boolean;
  showRansomware: boolean;
  showEntityGraph: boolean;
}

export interface WorkspaceSnapshot {
  version: 1;
  /** layerId -> on. Includes builtin, custom, and plugin layer ids. */
  activeLayers: Record<string, boolean>;
  view: WorkspaceView;
  projection: WorkspaceProjection;
  mapStyle: WorkspaceMapStyle;
  theme: WorkspaceTheme;
  ui: WorkspaceUi;
}

export const DEFAULT_WORKSPACE_VIEW: WorkspaceView = { latitude: 20, longitude: 0, zoom: 2.5 };

export const DEFAULT_WORKSPACE_UI: WorkspaceUi = {
  showLayers: true,
  showMarkets: false,
  showAlerts: false,
  showScmPanel: true,
  showIntel: false,
  showRansomware: false,
  showEntityGraph: false,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Keep only boolean-valued entries; silently drop anything malformed. */
function normalizeActiveLayers(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'boolean') out[k] = val;
    }
  }
  return out;
}

/**
 * Coerce an arbitrary persisted value into a valid `version: 1` snapshot, filling any
 * absent or malformed field from defaults. Never throws.
 */
export function normalizeWorkspaceSnapshot(raw: unknown): WorkspaceSnapshot {
  const r = isPlainObject(raw) ? raw : {};
  const view = isPlainObject(r.view) ? r.view : {};
  const ui = isPlainObject(r.ui) ? r.ui : {};
  return {
    version: 1,
    activeLayers: normalizeActiveLayers(r.activeLayers),
    view: {
      latitude: num(view.latitude, DEFAULT_WORKSPACE_VIEW.latitude),
      longitude: num(view.longitude, DEFAULT_WORKSPACE_VIEW.longitude),
      zoom: num(view.zoom, DEFAULT_WORKSPACE_VIEW.zoom),
    },
    projection: oneOf(r.projection, ['globe', 'mercator'] as const, 'globe'),
    mapStyle: oneOf(r.mapStyle, ['dark', 'satellite'] as const, 'dark'),
    theme: oneOf(r.theme, ['core', 'ghost', 'custom'] as const, 'core'),
    ui: {
      showLayers: bool(ui.showLayers, DEFAULT_WORKSPACE_UI.showLayers),
      showMarkets: bool(ui.showMarkets, DEFAULT_WORKSPACE_UI.showMarkets),
      showAlerts: bool(ui.showAlerts, DEFAULT_WORKSPACE_UI.showAlerts),
      showScmPanel: bool(ui.showScmPanel, DEFAULT_WORKSPACE_UI.showScmPanel),
      showIntel: bool(ui.showIntel, DEFAULT_WORKSPACE_UI.showIntel),
      showRansomware: bool(ui.showRansomware, DEFAULT_WORKSPACE_UI.showRansomware),
      showEntityGraph: bool(ui.showEntityGraph, DEFAULT_WORKSPACE_UI.showEntityGraph),
    },
  };
}

export interface RestoreLayersResult {
  /** Only ids present in the live registry; safe to apply. */
  applied: Record<string, boolean>;
  /** Ids the snapshot wanted ON but that no longer exist (missing custom/plugin layers). */
  dropped: string[];
}

/**
 * Filter a snapshot's active-layer map against the set of layer ids currently
 * registered (builtins + bootstrapped custom/plugin layers). Unknown ids are dropped;
 * an unknown id that was ON is reported in `dropped` so the UI can warn that the
 * workspace referenced an unavailable extension layer. Missing-but-OFF ids are ignored.
 */
export function restoreActiveLayers(
  active: Record<string, boolean>,
  knownIds: Iterable<string>,
): RestoreLayersResult {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  const applied: Record<string, boolean> = {};
  const dropped: string[] = [];
  for (const [id, on] of Object.entries(active || {})) {
    if (known.has(id)) applied[id] = !!on;
    else if (on) dropped.push(id);
  }
  return { applied, dropped };
}
