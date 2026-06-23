'use client';

export const SUPPORTED_PLUGIN_SDK_MAJOR = 1;

export type ValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; errors: string[] };

export type CustomSourceSpecValue = {
  id: string;
  label: string;
  group: string;
  color: string;
  icon?: string;
  url: string;
  jsonPath?: string;
  latProp: string;
  lngProp: string;
  labelProp?: string;
  markerType: 'circle' | 'symbol';
  radius?: number;
  intervalMs?: number;
  defaultActive?: boolean;
};

export type PluginDefinitionValue = {
  id: string;
  name: string;
  version: string;
  sdk?: number;
  activate: (ctx: unknown) => unknown | Promise<unknown>;
  deactivate?: (ctx: unknown) => unknown | Promise<unknown>;
};

export type ExtensionBundleValue = {
  version: 1;
  plugins: unknown[];
  customSources: unknown[];
};

export type CustomSourceValidationOptions = {
  groupIds?: string[];
  existingIds?: string[];
  currentId?: string;
};

const CUSTOM_SOURCE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTRIBUTION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROP_RE = /^[A-Za-z_$][A-Za-z0-9_$:-]{0,127}$/;
const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$:-]*(\.[A-Za-z_$][A-Za-z0-9_$:-]*)*$/;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const STYLE_LAYER_TYPES = new Set(['circle', 'symbol', 'line', 'fill', 'heatmap']);
const INTERACTION_KINDS = new Set(['popup', 'custom', 'entityGraph', 'camera', 'liveFeed']);

const asObj = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value, errors: [] });
const fail = <T>(errors: string[]): ValidationResult<T> => ({ ok: false, errors });

export function formatValidationErrors(errors: string[]): string {
  return errors.join('\n');
}

function pushStringError(errors: string[], field: string, label = field): string {
  errors.push(`${label} is required.`);
  return '';
}

function isAllowedUrl(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateInterval(value: unknown, errors: string[], field = 'intervalMs'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1000) {
    errors.push(`${field} must be a finite number of at least 1000ms.`);
    return undefined;
  }
  return Math.round(n);
}

function validatePositiveNumber(value: unknown, errors: string[], field: string, max = Number.POSITIVE_INFINITY): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    errors.push(`${field} must be a finite positive number${Number.isFinite(max) ? ` up to ${max}` : ''}.`);
    return undefined;
  }
  return n;
}

export function validateCustomSourceSpec(input: unknown, opts: CustomSourceValidationOptions = {}): ValidationResult<CustomSourceSpecValue> {
  const source = asObj(input);
  if (!source) return fail(['Custom source must be a JSON object.']);

  const errors: string[] = [];
  const id = str(source.id);
  const label = str(source.label);
  const group = str(source.group);
  const color = str(source.color);
  const url = str(source.url);
  const jsonPath = str(source.jsonPath);
  const latProp = str(source.latProp);
  const lngProp = str(source.lngProp);
  const labelProp = str(source.labelProp);
  const icon = str(source.icon);
  const markerType = str(source.markerType) || 'circle';

  if (!id) pushStringError(errors, 'id');
  else if (!CUSTOM_SOURCE_ID_RE.test(id)) errors.push('id must start with a letter and contain only lowercase letters, numbers, underscores, or hyphens.');

  const duplicateIds = new Set((opts.existingIds ?? []).filter((existingId) => existingId !== opts.currentId));
  if (id && duplicateIds.has(id)) errors.push(`id "${id}" already exists.`);

  if (!label) pushStringError(errors, 'label');
  if (!group) pushStringError(errors, 'group');
  else if (opts.groupIds?.length && !opts.groupIds.includes(group)) errors.push(`group "${group}" is not registered.`);

  if (!color) pushStringError(errors, 'color');
  else if (!HEX_COLOR_RE.test(color)) errors.push('color must be a hex color like #00E5FF.');

  if (!url) pushStringError(errors, 'url', 'Feed URL');
  else if (!isAllowedUrl(url)) errors.push('Feed URL must be same-origin (/path), http, or https.');

  if (jsonPath && !PATH_RE.test(jsonPath)) errors.push('jsonPath must be a dot path such as data.items.');
  if (!latProp) pushStringError(errors, 'latProp', 'lat property');
  else if (!PROP_RE.test(latProp)) errors.push('lat property must be a single JSON property name.');
  if (!lngProp) pushStringError(errors, 'lngProp', 'lng property');
  else if (!PROP_RE.test(lngProp)) errors.push('lng property must be a single JSON property name.');
  if (labelProp && !PROP_RE.test(labelProp)) errors.push('label property must be a single JSON property name.');

  if (markerType !== 'circle' && markerType !== 'symbol') errors.push('markerType must be circle or symbol.');
  const radius = validatePositiveNumber(source.radius, errors, 'radius', 64);
  const intervalMs = validateInterval(source.intervalMs, errors);

  if (errors.length) return fail(errors);

  const value: CustomSourceSpecValue = {
    id,
    label,
    group,
    color,
    url,
    latProp,
    lngProp,
    markerType: markerType as 'circle' | 'symbol',
  };
  if (icon) value.icon = icon;
  if (jsonPath) value.jsonPath = jsonPath;
  if (labelProp) value.labelProp = labelProp;
  if (radius != null) value.radius = radius;
  if (intervalMs != null) value.intervalMs = intervalMs;
  if (typeof source.defaultActive === 'boolean') value.defaultActive = source.defaultActive;
  return ok(value);
}

export function validatePluginDefinition(input: unknown): ValidationResult<PluginDefinitionValue> {
  const def = asObj(input);
  if (!def) return fail(['Plugin must export a definition object.']);

  const errors: string[] = [];
  const id = str(def.id);
  const name = str(def.name);
  const version = str(def.version);

  if (!id) pushStringError(errors, 'id');
  else if (!PLUGIN_ID_RE.test(id)) errors.push('id must be kebab-case lowercase letters and numbers.');
  if (!name) pushStringError(errors, 'name');
  if (!version) pushStringError(errors, 'version');
  if (def.sdk != null && def.sdk !== SUPPORTED_PLUGIN_SDK_MAJOR) errors.push(`sdk must be ${SUPPORTED_PLUGIN_SDK_MAJOR}.`);
  if (typeof def.activate !== 'function') errors.push('activate(ctx) must be a function.');
  if (def.deactivate != null && typeof def.deactivate !== 'function') errors.push('deactivate(ctx) must be a function when provided.');

  if (errors.length) return fail(errors);
  return ok({
    id,
    name,
    version,
    sdk: def.sdk,
    activate: def.activate,
    deactivate: def.deactivate,
  });
}

function validateContributionId(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== 'string') {
    errors.push(`${field} is required.`);
    return '';
  }
  const id = value.trim();
  if (!id) errors.push(`${field} is required.`);
  else if (id !== value) errors.push(`${field} must not include leading or trailing whitespace.`);
  else if (!CONTRIBUTION_ID_RE.test(id)) errors.push(`${field} must start with a letter and contain only letters, numbers, underscores, or hyphens.`);
  return id;
}

export function validatePluginGroupDefinition(input: unknown): ValidationResult<Record<string, any>> {
  const group = asObj(input);
  if (!group) return fail(['Group definition must be an object.']);

  const errors: string[] = [];
  validateContributionId(group.id, 'group.id', errors);
  if (!str(group.label)) errors.push('group.label is required.');
  if (!str(group.fullLabel)) errors.push('group.fullLabel is required.');
  if (!str(group.color)) errors.push('group.color is required.');
  if (group.order != null && !Number.isFinite(Number(group.order))) errors.push('group.order must be a finite number.');

  return errors.length ? fail(errors) : ok(group);
}

export function validatePluginFeedDefinition(input: unknown): ValidationResult<Record<string, any>> {
  const feed = asObj(input);
  if (!feed) return fail(['Feed definition must be an object.']);

  const errors: string[] = [];
  validateContributionId(feed.id, 'feed.id', errors);

  const fetchDef = asObj(feed.fetch);
  const legacyUrl = str(feed.url);
  if (fetchDef) {
    if (fetchDef.kind !== 'endpoint') {
      errors.push('feed.fetch.kind must be endpoint; custom-run feeds are not wired yet.');
    } else if (!isAllowedUrl(str(fetchDef.url))) {
      errors.push('feed.fetch.url must be same-origin (/path), http, or https.');
    }
    if (fetchDef.transform != null && typeof fetchDef.transform !== 'function') errors.push('feed.fetch.transform must be a function when provided.');
  } else if (!isAllowedUrl(legacyUrl)) {
    errors.push('feed.url is required and must be same-origin (/path), http, or https.');
  }

  validateInterval(feed.intervalMs, errors, 'feed.intervalMs');
  if (feed.priority != null && feed.priority !== 'core' && feed.priority !== 'lazy') errors.push('feed.priority must be core or lazy.');

  return errors.length ? fail(errors) : ok(feed);
}

export function validatePluginLayerDefinition(input: unknown): ValidationResult<Record<string, any>> {
  const layer = asObj(input);
  if (!layer) return fail(['Layer definition must be an object.']);

  const errors: string[] = [];
  validateContributionId(layer.id, 'layer.id', errors);
  if (!str(layer.label)) errors.push('layer.label is required.');
  if (!str(layer.group)) errors.push('layer.group is required.');
  if (!str(layer.color)) errors.push('layer.color is required.');

  if (layer.feeds != null && (!Array.isArray(layer.feeds) || layer.feeds.some((feed: unknown) => !str(feed)))) {
    errors.push('layer.feeds must be an array of feed ids.');
  }
  if (layer.countBuckets != null && (!Array.isArray(layer.countBuckets) || layer.countBuckets.some((bucket: unknown) => !str(bucket)))) {
    errors.push('layer.countBuckets must be an array of bucket names.');
  }

  if (!Array.isArray(layer.styleLayers) || layer.styleLayers.length === 0) {
    errors.push('layer.styleLayers must contain at least one style layer.');
  } else {
    const seenStyleIds = new Set<string>();
    layer.styleLayers.forEach((styleLayer: unknown, index: number) => {
      const sl = asObj(styleLayer);
      if (!sl) {
        errors.push(`styleLayers[${index}] must be an object.`);
        return;
      }
      const id = validateContributionId(sl.id, `styleLayers[${index}].id`, errors);
      if (id && seenStyleIds.has(id)) errors.push(`styleLayers[${index}].id is duplicated.`);
      if (id) seenStyleIds.add(id);
      if (!STYLE_LAYER_TYPES.has(str(sl.type))) errors.push(`styleLayers[${index}].type is not supported.`);
      if (sl.mapSource != null && !str(sl.mapSource)) errors.push(`styleLayers[${index}].mapSource must be a non-empty string.`);
      if (sl.paint != null && (typeof sl.paint !== 'object' || Array.isArray(sl.paint))) errors.push(`styleLayers[${index}].paint must be an object.`);
      if (sl.layout != null && (typeof sl.layout !== 'object' || Array.isArray(sl.layout))) errors.push(`styleLayers[${index}].layout must be an object.`);
    });
  }

  if (!Array.isArray(layer.render) || layer.render.length === 0) {
    errors.push('layer.render must contain at least one render binding.');
  } else {
    layer.render.forEach((binding: unknown, index: number) => {
      const rb = asObj(binding);
      if (!rb) {
        errors.push(`render[${index}] must be an object.`);
        return;
      }
      if (!str(rb.mapSource)) errors.push(`render[${index}].mapSource is required.`);
      const source = asObj(rb.source);
      if (!source) {
        errors.push(`render[${index}].source is required.`);
      } else if (typeof source.compute === 'function') {
        // Supported advanced path.
      } else if (str(source.bucket)) {
        if (source.toFeatures != null && typeof source.toFeatures !== 'function') errors.push(`render[${index}].source.toFeatures must be a function when provided.`);
        if (source.decimate != null && (!Number.isFinite(Number(source.decimate)) || Number(source.decimate) < 1)) errors.push(`render[${index}].source.decimate must be at least 1.`);
      } else {
        errors.push(`render[${index}].source must define bucket or compute.`);
      }
    });
  }

  const interaction = asObj(layer.interaction);
  if (interaction) {
    const kind = str(interaction.kind);
    if (!INTERACTION_KINDS.has(kind)) errors.push('interaction.kind is not supported by the current runtime.');
    if (kind === 'popup' && typeof interaction.html !== 'function') errors.push('interaction.html must be a function.');
    if (kind === 'custom' && typeof interaction.onClick !== 'function') errors.push('interaction.onClick must be a function.');
    if (kind === 'entityGraph' && typeof interaction.map !== 'function') errors.push('interaction.map must be a function.');
    if (kind === 'liveFeed' && typeof interaction.url !== 'function') errors.push('interaction.url must be a function.');
  }

  return errors.length ? fail(errors) : ok(layer);
}

export function validatePluginBundleEntry(input: unknown): ValidationResult<Record<string, any>> {
  const plugin = asObj(input);
  if (!plugin) return fail(['Plugin bundle entry must be an object.']);

  const errors: string[] = [];
  if (!str(plugin.code)) errors.push('plugin.code is required.');
  if (plugin.enabled != null && typeof plugin.enabled !== 'boolean') errors.push('plugin.enabled must be a boolean.');
  if (plugin.id != null && !PLUGIN_ID_RE.test(str(plugin.id))) errors.push('plugin.id must be kebab-case lowercase letters and numbers.');
  if (plugin.name != null && !str(plugin.name)) errors.push('plugin.name must be a non-empty string.');
  if (plugin.version != null && !str(plugin.version)) errors.push('plugin.version must be a non-empty string.');

  return errors.length ? fail(errors) : ok(plugin);
}

export function validateExtensionBundle(input: unknown): ValidationResult<ExtensionBundleValue> {
  const bundle = asObj(input);
  if (!bundle) return fail(['Extension bundle must be a JSON object.']);

  const errors: string[] = [];
  if (bundle.version !== 1) errors.push('Extension bundle version must be 1.');
  if (!Array.isArray(bundle.plugins)) errors.push('plugins must be an array.');
  if (!Array.isArray(bundle.customSources)) errors.push('customSources must be an array.');

  if (errors.length) return fail(errors);
  return ok({
    version: 1,
    plugins: bundle.plugins,
    customSources: bundle.customSources,
  });
}
