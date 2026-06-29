/**
 * HORUS — Surveillance Feed Sidecar
 *
 * Stores fixed counter-surveillance records in SQLite and serves the four map
 * layers that used to depend on direct app-side Overpass calls:
 * surveillance, flock, police, and mass_surveil.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
    }
    if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseEnvValue(value) {
  const trimmed = stripInlineComment(value);
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }
  return trimmed;
}

function loadEnvFile(filePath = path.join(__dirname, '.env'), target = process.env) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const loaded = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (target[key] != null && String(target[key]).trim() !== '') continue;
    const value = parseEnvValue(match[2]);
    target[key] = value;
    loaded[key] = value;
  }
  return loaded;
}

loadEnvFile(process.env.SURVEILLANCE_FEED_ENV || path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || process.env.SURVEILLANCE_FEED_PORT || 7800);
const HOST = process.env.SURVEILLANCE_FEED_BIND || process.env.HOST || '0.0.0.0';
const DEFAULT_REFRESH_MS = Number(process.env.SURVEILLANCE_FEED_REFRESH_MS || 7 * 24 * 60 * 60 * 1000);
const DEFAULT_DB_PATH = process.env.SURVEILLANCE_FEED_DB || path.join(__dirname, 'data', 'surveillance-feed.sqlite');
const DEFAULT_ADMIN_TOKEN = process.env.SURVEILLANCE_FEED_ADMIN_TOKEN || '';
const MAX_BBOX_AREA_DEG2 = Number(process.env.SURVEILLANCE_FEED_MAX_BBOX_AREA || 25);
const MAX_LAYER_ROWS = Number(process.env.SURVEILLANCE_FEED_MAX_ROWS || 5000);
const OVERPASS_TIMEOUT_MS = Number(process.env.SURVEILLANCE_FEED_OVERPASS_TIMEOUT_MS || 45_000);
const OVERPASS_ENDPOINTS = (process.env.SURVEILLANCE_FEED_OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_LAYERS = new Set(['surveillance', 'flock', 'police', 'mass_surveil']);
const OSM_SOURCES = {
  surveillance: 'osm-surveillance',
  flock: 'osm-flock',
  police: 'osm-police',
  mass_surveil: 'osm-mass_surveil',
};

const SOURCE_DEFAULTS = [
  {
    id: OSM_SOURCES.surveillance,
    label: 'OpenStreetMap Surveillance',
    layer: 'surveillance',
    kind: 'osm',
    attribution: 'OpenStreetMap contributors (ODbL)',
    refresh_ms: DEFAULT_REFRESH_MS,
  },
  {
    id: OSM_SOURCES.flock,
    label: 'OpenStreetMap / DeFlock',
    layer: 'flock',
    kind: 'osm',
    attribution: 'OpenStreetMap contributors (ODbL)',
    refresh_ms: DEFAULT_REFRESH_MS,
  },
  {
    id: OSM_SOURCES.police,
    label: 'OpenStreetMap Police',
    layer: 'police',
    kind: 'osm',
    attribution: 'OpenStreetMap contributors (ODbL)',
    refresh_ms: DEFAULT_REFRESH_MS,
  },
  {
    id: OSM_SOURCES.mass_surveil,
    label: 'OpenStreetMap Mass Surveillance',
    layer: 'mass_surveil',
    kind: 'osm',
    attribution: 'OpenStreetMap contributors (ODbL)',
    refresh_ms: DEFAULT_REFRESH_MS,
  },
  {
    id: 'nz-police-curated',
    label: 'New Zealand Police curated',
    layer: 'police',
    kind: 'curated',
    attribution: 'Bundled HORUS curated police station dataset',
    refresh_ms: 0,
  },
];

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'record';
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function parseBbox(raw) {
  if (Array.isArray(raw)) {
    if (raw.length !== 4) throw new Error('invalid bbox format; expected south,west,north,east');
    raw = raw.join(',');
  }
  if (typeof raw !== 'string') throw new Error('invalid bbox format; expected south,west,north,east');
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error('invalid bbox format; expected south,west,north,east');
  }
  const [s, w, n, e] = parts;
  if (s < -90 || n > 90) throw new Error('invalid bbox latitude');
  if (w < -180 || w > 180 || e < -180 || e > 180) throw new Error('invalid bbox longitude');
  if (s >= n) throw new Error('invalid bbox: south must be less than north');
  if (w >= e) throw new Error('invalid bbox: west must be less than east');
  if ((n - s) * (e - w) > MAX_BBOX_AREA_DEG2) throw new Error('bbox area too large');
  return [s, w, n, e];
}

function tileKeyFor(bbox) {
  return bbox.map((n) => Number(n).toFixed(4)).join(',');
}

function parseLayers(raw) {
  const layers = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const selected = layers.length ? layers : [...ALLOWED_LAYERS];
  for (const layer of selected) {
    if (!ALLOWED_LAYERS.has(layer)) throw new Error(`unsupported layer: ${layer}`);
  }
  return [...new Set(selected)];
}

function isTileStale(refreshedAt, refreshMs, nowMs = Date.now()) {
  if (!refreshedAt) return true;
  if (!Number.isFinite(refreshMs) || refreshMs <= 0) return false;
  return nowMs - refreshedAt > refreshMs;
}

function tagValue(tags, key) {
  return tags[key] ?? tags[key.toLowerCase()] ?? tags[key.toUpperCase()];
}

function isAlprTag(tags) {
  return Object.entries(tags).some(([key, value]) => {
    const k = key.toLowerCase();
    const v = String(value || '').toLowerCase();
    return (k === 'surveillance:type' || k === 'camera:type' || k === 'enforcement' || k === 'operator') &&
      (v === 'alpr' || v.includes('alpr') || v.includes('flock'));
  });
}

function defaultKind(layer, tags) {
  if (layer === 'flock') return 'alpr';
  if (layer === 'police') return 'police_station';
  if (layer === 'mass_surveil') return 'mass_surveillance';
  if (tagValue(tags, 'highway') === 'speed_camera') return 'speed_camera';
  if (isAlprTag(tags)) return 'alpr';
  return String(tagValue(tags, 'surveillance:type') || tagValue(tags, 'camera:type') || 'camera').toLowerCase();
}

function defaultName(layer, kind, tags) {
  if (tags.name) return String(tags.name);
  if (tags.description) return String(tags.description);
  if (layer === 'flock') return 'ALPR Camera';
  if (layer === 'police') return 'Police Station';
  if (layer === 'mass_surveil') return 'Surveillance';
  if (kind === 'speed_camera') return 'Speed Camera';
  if (kind === 'alpr') return 'ALPR Camera';
  return 'Surveillance Camera';
}

function normalizeSourceSpec(source, fallbackLayer = null) {
  if (typeof source === 'string') {
    return {
      id: source,
      label: source,
      kind: 'manual',
      layer: fallbackLayer,
      enabled: true,
      refresh_ms: DEFAULT_REFRESH_MS,
      attribution: null,
      metadata: {},
    };
  }
  const spec = cleanObject(source);
  const id = String(spec.id || spec.key || slug(spec.label || spec.name || 'manual-source')).trim();
  return {
    id,
    label: String(spec.label || spec.name || id),
    kind: String(spec.kind || spec.type || 'manual'),
    layer: spec.layer || fallbackLayer || null,
    enabled: spec.enabled !== false,
    refresh_ms: Number.isFinite(Number(spec.refresh_ms)) ? Number(spec.refresh_ms) : DEFAULT_REFRESH_MS,
    attribution: spec.attribution ? String(spec.attribution) : null,
    metadata: cleanObject(spec.metadata),
  };
}

function normalizeLayerRecord(input, options = {}) {
  const sourceSpec = normalizeSourceSpec(options.source || input.source || 'manual', input.layer || options.layer || null);
  const layer = String(input.layer || options.layer || sourceSpec.layer || '').trim();
  if (!ALLOWED_LAYERS.has(layer)) throw new Error(`unsupported layer: ${layer}`);
  const lat = Number(input.lat);
  const lng = Number(input.lng ?? input.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('record requires numeric lat/lng');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('record coordinates out of range');

  const tags = cleanObject(input.tags);
  const properties = cleanObject(input.properties);
  const externalId = String(input.source_id || input.external_id || input.osm_id || input.id || stableHash({ layer, lat, lng, name: input.name })).trim();
  const sourceId = String(sourceSpec.id).trim();
  const kind = String(input.kind || defaultKind(layer, tags)).toLowerCase();
  const id = String(input.id || `${sourceId}:${layer}:${externalId}`).trim();

  if (tagValue(tags, 'surveillance:type')) properties.surveillance_type = tagValue(tags, 'surveillance:type');
  if (tagValue(tags, 'camera:type')) properties.camera_type = tagValue(tags, 'camera:type');
  if (tagValue(tags, 'surveillance:zone')) properties.zone = tagValue(tags, 'surveillance:zone');
  if (tagValue(tags, 'surveillance')) properties.zone = properties.zone || tagValue(tags, 'surveillance');
  if (tagValue(tags, 'direction')) properties.direction = tagValue(tags, 'direction');
  if (tagValue(tags, 'highway') === 'speed_camera') properties.surveillance_type = 'speed_camera';
  if (layer === 'flock') properties.surveillance_type = 'ALPR';
  if (input.osm_url) properties.osm_url = input.osm_url;
  if (input.external_url) properties.external_url = input.external_url;

  return {
    id,
    layer,
    kind,
    source_id: sourceId,
    external_id: externalId,
    name: String(input.name || defaultName(layer, kind, tags)),
    operator: input.operator || tags.operator || null,
    lat,
    lng,
    country: input.country || null,
    tags,
    properties,
  };
}

function migrate(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      layer TEXT,
      kind TEXT NOT NULL DEFAULT 'manual',
      refresh_ms INTEGER,
      attribution TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      row_key INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      layer TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT,
      name TEXT NOT NULL,
      operator TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      country TEXT,
      tags_json TEXT NOT NULL DEFAULT '{}',
      properties_json TEXT NOT NULL DEFAULT '{}',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_layer_source_idx ON records(layer, source_id);
    CREATE INDEX IF NOT EXISTS records_external_idx ON records(source_id, layer, external_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS record_index USING rtree(
      row_key,
      min_lng, max_lng,
      min_lat, max_lat
    );
    CREATE TABLE IF NOT EXISTS tiles (
      id TEXT PRIMARY KEY,
      tile_key TEXT NOT NULL,
      layer TEXT NOT NULL,
      source_id TEXT NOT NULL,
      bbox_json TEXT NOT NULL,
      refreshed_at INTEGER,
      stale_after INTEGER,
      status TEXT NOT NULL DEFAULT 'missing',
      updated_at INTEGER NOT NULL,
      UNIQUE(tile_key, layer, source_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      layer TEXT,
      source_id TEXT,
      tile_key TEXT,
      bbox_json TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_refresh_idx ON jobs(type, status, layer, source_id, tile_key);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      record_id TEXT,
      layer TEXT,
      source_id TEXT,
      kind TEXT,
      lat REAL,
      lng REAL,
      observed_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
}

function upsertSource(db, source, nowMs = Date.now()) {
  const spec = normalizeSourceSpec(source);
  const existing = db.prepare('SELECT created_at FROM sources WHERE id = ?').get(spec.id);
  db.prepare(`
    INSERT INTO sources (id, label, layer, kind, refresh_ms, attribution, enabled, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      layer = COALESCE(excluded.layer, sources.layer),
      kind = excluded.kind,
      refresh_ms = excluded.refresh_ms,
      attribution = excluded.attribution,
      enabled = excluded.enabled,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    spec.id,
    spec.label,
    spec.layer,
    spec.kind,
    spec.refresh_ms,
    spec.attribution,
    spec.enabled ? 1 : 0,
    JSON.stringify(spec.metadata || {}),
    existing?.created_at || nowMs,
    nowMs,
  );
  return spec;
}

function seedSources(db, nowMs = Date.now()) {
  for (const source of SOURCE_DEFAULTS) upsertSource(db, source, nowMs);
}

function upsertRecord(db, record, nowMs = Date.now()) {
  const existing = db.prepare('SELECT row_key, first_seen_at FROM records WHERE id = ?').get(record.id);
  db.prepare(`
    INSERT INTO records (
      id, layer, kind, source_id, external_id, name, operator, lat, lng, country,
      tags_json, properties_json, first_seen_at, last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      layer = excluded.layer,
      kind = excluded.kind,
      source_id = excluded.source_id,
      external_id = excluded.external_id,
      name = excluded.name,
      operator = excluded.operator,
      lat = excluded.lat,
      lng = excluded.lng,
      country = excluded.country,
      tags_json = excluded.tags_json,
      properties_json = excluded.properties_json,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.layer,
    record.kind,
    record.source_id,
    record.external_id,
    record.name,
    record.operator,
    record.lat,
    record.lng,
    record.country,
    JSON.stringify(record.tags || {}),
    JSON.stringify(record.properties || {}),
    existing?.first_seen_at || nowMs,
    nowMs,
    nowMs,
  );
  const row = db.prepare('SELECT row_key FROM records WHERE id = ?').get(record.id);
  db.prepare('INSERT OR REPLACE INTO record_index (row_key, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)')
    .run(row.row_key, record.lng, record.lng, record.lat, record.lat);
  return row.row_key;
}

function importRecords(db, records, source, nowMs = Date.now()) {
  const sourceSpec = upsertSource(db, source, nowMs);
  const touched = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of records) {
      const record = normalizeLayerRecord(item, { source: sourceSpec });
      upsertRecord(db, record, nowMs);
      touched.add(record.id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
  return { imported: records.length, upserted: touched.size, source: sourceSpec };
}

function mapRecord(row) {
  const properties = parseJson(row.properties_json, {});
  return {
    id: row.id,
    layer: row.layer,
    kind: row.kind,
    lat: row.lat,
    lng: row.lng,
    name: row.name,
    operator: row.operator,
    country: row.country,
    source: row.source_label || row.source_id,
    source_key: row.source_id,
    source_id: row.external_id,
    attribution: row.attribution,
    updated_at: nowIso(row.updated_at),
    ...properties,
  };
}

function queryRecords(db, bbox, layers) {
  const [s, w, n, e] = bbox;
  const placeholders = layers.map(() => '?').join(',');
  return db.prepare(`
    SELECT r.*, s.label AS source_label, s.attribution
    FROM records r
    JOIN record_index i ON i.row_key = r.row_key
    LEFT JOIN sources s ON s.id = r.source_id
    WHERE r.layer IN (${placeholders})
      AND i.min_lng <= ?
      AND i.max_lng >= ?
      AND i.min_lat <= ?
      AND i.max_lat >= ?
    ORDER BY r.layer ASC, r.name ASC
    LIMIT ?
  `).all(...layers, e, w, n, s, MAX_LAYER_ROWS).map(mapRecord);
}

function getTile(db, layer, sourceId, bbox) {
  return db.prepare('SELECT * FROM tiles WHERE layer = ? AND source_id = ? AND tile_key = ?')
    .get(layer, sourceId, tileKeyFor(bbox));
}

function markTileFresh(db, layer, sourceId, bbox, refreshMs, nowMs = Date.now()) {
  const key = tileKeyFor(bbox);
  const id = `${sourceId}:${layer}:${key}`;
  db.prepare(`
    INSERT INTO tiles (id, tile_key, layer, source_id, bbox_json, refreshed_at, stale_after, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'fresh', ?)
    ON CONFLICT(tile_key, layer, source_id) DO UPDATE SET
      bbox_json = excluded.bbox_json,
      refreshed_at = excluded.refreshed_at,
      stale_after = excluded.stale_after,
      status = 'fresh',
      updated_at = excluded.updated_at
  `).run(id, key, layer, sourceId, JSON.stringify(bbox), nowMs, nowMs + refreshMs, nowMs);
}

function queueRefreshJob(db, { layer, source_id, bbox, reason = 'missing_or_stale' }, nowMs = Date.now()) {
  if (!ALLOWED_LAYERS.has(layer)) throw new Error(`unsupported layer: ${layer}`);
  const sourceId = source_id || OSM_SOURCES[layer];
  const key = tileKeyFor(bbox);
  const existing = db.prepare(`
    SELECT * FROM jobs
    WHERE type = 'refresh'
      AND layer = ?
      AND source_id = ?
      AND tile_key = ?
      AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(layer, sourceId, key);
  if (existing) return { created: false, job: existing };
  const id = crypto.randomUUID();
  const payload = { layer, source_id: sourceId, bbox, reason };
  db.prepare(`
    INSERT INTO jobs (id, type, status, layer, source_id, tile_key, bbox_json, payload_json, created_at, updated_at)
    VALUES (?, 'refresh', 'queued', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, layer, sourceId, key, JSON.stringify(bbox), JSON.stringify(payload), nowMs, nowMs);
  return { created: true, job: { id, type: 'refresh', status: 'queued', layer, source_id: sourceId, tile_key: key, created_at: nowMs } };
}

function sourceFreshness(db, bbox, layers, nowMs = Date.now()) {
  const out = [];
  for (const layer of layers) {
    const sourceId = OSM_SOURCES[layer];
    const source = db.prepare('SELECT refresh_ms FROM sources WHERE id = ? AND enabled = 1').get(sourceId);
    if (!source) continue;
    const tile = getTile(db, layer, sourceId, bbox);
    if (isTileStale(tile?.refreshed_at, source.refresh_ms ?? DEFAULT_REFRESH_MS, nowMs)) {
      out.push({ layer, source_id: sourceId, refresh_ms: source.refresh_ms ?? DEFAULT_REFRESH_MS });
    }
  }
  return out;
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quote = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quote = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row.map((v) => v.trim()));
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row.map((v) => v.trim()));
  return rows;
}

function seedNzPolice(db, nowMs = Date.now()) {
  const csvPath = path.join(__dirname, 'data', 'nz_police_stations.csv');
  if (!fs.existsSync(csvPath)) return { seeded: 0, skipped: true };
  const rows = csvRows(fs.readFileSync(csvPath, 'utf8'));
  const [header, ...data] = rows;
  const nameIdx = header.indexOf('station_name');
  const latIdx = header.indexOf('lat');
  const lonIdx = header.indexOf('lon');
  const records = data.map((row) => ({
    layer: 'police',
    source_id: `nz-police:${slug(row[nameIdx])}`,
    name: row[nameIdx],
    lat: Number(row[latIdx]),
    lng: Number(row[lonIdx]),
    country: 'New Zealand',
    tags: { amenity: 'police' },
    properties: { curated: true },
  })).filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng));
  const result = importRecords(db, records, {
    id: 'nz-police-curated',
    label: 'New Zealand Police curated',
    layer: 'police',
    kind: 'curated',
    refresh_ms: 0,
    attribution: 'Bundled HORUS curated police station dataset',
  }, nowMs);
  return { seeded: result.upserted, skipped: false };
}

function bboxForOverpass(bbox) {
  return bbox.map((n) => Number(n).toFixed(6)).join(',');
}

function overpassClauses(layer, bbox) {
  const b = bboxForOverpass(bbox);
  if (layer === 'surveillance') {
    return `node["man_made"="surveillance"](${b});\n  node["highway"="speed_camera"](${b});`;
  }
  if (layer === 'flock') {
    return `node["man_made"="surveillance"]["surveillance:type"~"^alpr$","i"](${b});\n  node["man_made"="surveillance"]["camera:type"~"^alpr$","i"](${b});\n  node["man_made"="surveillance"]["operator"~"flock|alpr","i"](${b});`;
  }
  if (layer === 'police') {
    return `node["amenity"="police"](${b});`;
  }
  if (layer === 'mass_surveil') {
    return `node["man_made"="surveillance"]["surveillance"="public"](${b});\n  node["man_made"="surveillance"]["surveillance:zone"~"^(town|area)$","i"](${b});`;
  }
  throw new Error(`unsupported layer: ${layer}`);
}

function osmRecordFor(layer, element) {
  const tags = cleanObject(element.tags);
  return {
    layer,
    source_id: `${element.type || 'node'}/${element.id}`,
    external_id: `${element.type || 'node'}/${element.id}`,
    lat: element.lat,
    lng: element.lon,
    name: tags.name || tags.description || tags.operator,
    operator: tags.operator,
    tags,
    properties: {
      osm_url: `https://www.openstreetmap.org/${element.type || 'node'}/${element.id}`,
    },
  };
}

async function fetchOsmRecords(layer, bbox, fetchImpl = fetch) {
  const query = `[out:json][timeout:25];\n(\n  ${overpassClauses(layer, bbox)}\n);\nout body;`;
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': 'HORUS-surveillance-feed/1.0 (fixed counter-surveillance layer refresh)',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = await res.json();
      const elements = Array.isArray(data.elements) ? data.elements : [];
      return elements
        .filter((el) => Number.isFinite(el.lat) && Number.isFinite(el.lon))
        .map((el) => osmRecordFor(layer, el));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Overpass refresh failed');
}

function jobJson(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    layer: row.layer,
    source_id: row.source_id,
    tile_key: row.tile_key,
    bbox: parseJson(row.bbox_json, null),
    payload: parseJson(row.payload_json, {}),
    error: row.error,
    created_at: nowIso(row.created_at),
    updated_at: nowIso(row.updated_at),
    started_at: row.started_at ? nowIso(row.started_at) : null,
    finished_at: row.finished_at ? nowIso(row.finished_at) : null,
  };
}

async function processOneJob(db, job, now, fetchImpl) {
  const started = now();
  db.prepare('UPDATE jobs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?')
    .run('running', started, started, job.id);
  try {
    const bbox = parseJson(job.bbox_json, null);
    if (!bbox) throw new Error('job missing bbox');
    const records = await fetchOsmRecords(job.layer, bbox, fetchImpl);
    importRecords(db, records, SOURCE_DEFAULTS.find((s) => s.id === job.source_id) || job.source_id, now());
    const source = db.prepare('SELECT refresh_ms FROM sources WHERE id = ?').get(job.source_id);
    markTileFresh(db, job.layer, job.source_id, bbox, source?.refresh_ms ?? DEFAULT_REFRESH_MS, now());
    const finished = now();
    db.prepare('UPDATE jobs SET status = ?, finished_at = ?, updated_at = ?, error = NULL WHERE id = ?')
      .run('complete', finished, finished, job.id);
  } catch (error) {
    const finished = now();
    db.prepare('UPDATE jobs SET status = ?, finished_at = ?, updated_at = ?, error = ? WHERE id = ?')
      .run('failed', finished, finished, error instanceof Error ? error.message : String(error), job.id);
  }
}

function createService(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const fetchImpl = options.fetch || fetch;
  const autoProcessJobs = options.autoProcessJobs !== false;
  let processing = false;

  migrate(db);
  seedSources(db, now());
  const nzSeed = options.seedNzPolice === false ? { seeded: 0, skipped: true } : seedNzPolice(db, now());

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function requireAdmin(req, res, next) {
    const token = String(options.adminToken ?? DEFAULT_ADMIN_TOKEN).trim();
    if (!token) return res.status(503).json({ error: 'admin token not configured' });
    const header = req.get('authorization') || '';
    if (header !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }

  async function processQueuedJobs() {
    if (!autoProcessJobs || processing) return;
    processing = true;
    try {
      while (true) {
        const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
        if (!job) break;
        await processOneJob(db, job, now, fetchImpl);
      }
    } finally {
      processing = false;
    }
  }

  function scheduleJobs() {
    if (!autoProcessJobs) return;
    setImmediate(() => {
      processQueuedJobs().catch((error) => console.error('[surveillance-feed] job processor failed', error));
    });
  }

  app.get('/health', (_req, res) => {
    const counts = Object.fromEntries([...ALLOWED_LAYERS].map((layer) => [
      layer,
      db.prepare('SELECT COUNT(*) AS count FROM records WHERE layer = ?').get(layer).count,
    ]));
    const queue = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status').all()
      .map((row) => [row.status, row.count]));
    const sources = Object.fromEntries(db.prepare('SELECT * FROM sources ORDER BY id ASC').all().map((row) => [
      row.id,
      {
        label: row.label,
        layer: row.layer,
        kind: row.kind,
        refresh_ms: row.refresh_ms,
        enabled: !!row.enabled,
        updated_at: nowIso(row.updated_at),
      },
    ]));
    res.json({
      status: 'ok',
      service: 'horus-surveillance-feed',
      db: dbPath,
      counts,
      queue,
      sources,
      seed: { nz_police: nzSeed },
      uptime_s: Math.round(process.uptime()),
      timestamp: nowIso(now()),
    });
  });

  app.get('/v1/layers', (req, res) => {
    let bbox;
    let layers;
    try {
      bbox = parseBbox(req.query.bbox);
      layers = parseLayers(req.query.layers);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }

    const records = queryRecords(db, bbox, layers);
    const byLayer = Object.fromEntries(layers.map((layer) => [layer, []]));
    for (const record of records) byLayer[record.layer]?.push(record);

    const stale = sourceFreshness(db, bbox, layers, now());
    let queued = 0;
    for (const item of stale) {
      const result = queueRefreshJob(db, { layer: item.layer, source_id: item.source_id, bbox }, now());
      if (result.created) queued += 1;
    }
    if (queued > 0) scheduleJobs();

    return res.json({
      ...byLayer,
      total: records.length,
      bbox,
      timestamp: nowIso(now()),
      refresh: {
        queued,
        stale: stale.map((s) => ({ layer: s.layer, source_id: s.source_id })),
      },
    });
  });

  app.post('/v1/admin/import', requireAdmin, (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.records)) return res.status(400).json({ error: 'records array is required' });
    try {
      const result = importRecords(db, body.records, body.source || 'admin-import', now());
      return res.json({
        imported: result.imported,
        upserted: result.upserted,
        source: { id: result.source.id, label: result.source.label },
        timestamp: nowIso(now()),
      });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/v1/admin/refresh', requireAdmin, (req, res) => {
    const body = req.body || {};
    let bbox;
    let layers;
    try {
      bbox = parseBbox(body.bbox);
      layers = parseLayers(Array.isArray(body.layers) ? body.layers.join(',') : body.layers);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    const jobs = layers.map((layer) => queueRefreshJob(db, {
      layer,
      source_id: body.source || OSM_SOURCES[layer],
      bbox,
      reason: 'admin_refresh',
    }, now()).job);
    scheduleJobs();
    return res.json({ queued: jobs.length, jobs: jobs.map((job) => jobJson({ ...job, bbox_json: JSON.stringify(bbox), payload_json: '{}', updated_at: job.created_at })) });
  });

  app.get('/v1/admin/jobs', requireAdmin, (req, res) => {
    const status = String(req.query.status || '').trim();
    const rows = status
      ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status)
      : db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all();
    return res.json({ jobs: rows.map(jobJson), total: rows.length });
  });

  app.get('/', (_req, res) => {
    res.json({
      service: 'horus-surveillance-feed',
      endpoints: ['/health', '/v1/layers', '/v1/admin/import', '/v1/admin/refresh', '/v1/admin/jobs'],
      layers: [...ALLOWED_LAYERS],
    });
  });

  return {
    app,
    db,
    close: () => db.close(),
    importRecords: (records, source) => importRecords(db, records, source, now()),
    queueRefreshJob: (job) => queueRefreshJob(db, job, now()),
    processQueuedJobs,
  };
}

if (require.main === module) {
  const service = createService();
  const server = service.app.listen(PORT, HOST, () => {
    console.log(`[surveillance-feed] listening on ${HOST}:${PORT}`);
    if (!DEFAULT_ADMIN_TOKEN) console.warn('[surveillance-feed] SURVEILLANCE_FEED_ADMIN_TOKEN not set; admin endpoints disabled');
  });

  const shutdown = (signal) => {
    console.log(`[surveillance-feed] ${signal} received; shutting down`);
    server.close(() => {
      service.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[surveillance-feed] unhandled rejection:', err);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[surveillance-feed] uncaught exception:', err);
    shutdown('uncaughtException');
  });
}

module.exports = {
  ALLOWED_LAYERS,
  createService,
  isTileStale,
  loadEnvFile,
  normalizeLayerRecord,
  parseBbox,
  tileKeyFor,
};
