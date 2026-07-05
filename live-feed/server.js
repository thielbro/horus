/**
 * HORUS Live Feed Sidecar
 *
 * Activation-gated live data broker. Maritime AIS is the first feed:
 * - no durable vessel-position storage
 * - AISStream socket streams continuously, but only while a renderer lease is active
 * - the subscription follows the renderer viewport (plus strategic chokepoints/ports)
 */

const express = require('express');
const DefaultWebSocket = require('ws');

const PORT = Number(process.env.PORT || process.env.LIVE_FEED_PORT || 7900);
const HOST = process.env.LIVE_FEED_BIND || process.env.HOST || '0.0.0.0';

const RECONNECT_MS = Number(process.env.LIVE_FEED_MARITIME_RECONNECT_MS || 5 * 1000);
const ERROR_RECONNECT_MS = Number(process.env.LIVE_FEED_MARITIME_ERROR_RECONNECT_MS || 60 * 1000);
const LEASE_TTL_MS = Number(process.env.LIVE_FEED_LEASE_TTL_MS || 150 * 1000);
const SHIP_TTL_MS = Number(process.env.LIVE_FEED_MARITIME_SHIP_TTL_MS || 15 * 60 * 1000);
const MAX_SHIPS_CACHE = Number(process.env.LIVE_FEED_MARITIME_MAX_CACHE || 50_000);
const MAX_SHIPS_RESPONSE = Number(process.env.LIVE_FEED_MARITIME_MAX_RESPONSE || 5000);
const MAX_SHIPS_FOR_AGGREGATES = 5000;
const MAX_VIEWPORT_AREA_DEG2 = Number(process.env.LIVE_FEED_MARITIME_MAX_VIEW_AREA || 20_000);
const AIS_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

const PORTS = [
  { name: 'Shanghai', country: 'CN', lat: 31.23, lng: 121.47, type: 'container', volume: '47.3M TEU', rank: 1 },
  { name: 'Singapore', country: 'SG', lat: 1.26, lng: 103.84, type: 'container', volume: '37.2M TEU', rank: 2 },
  { name: 'Ningbo-Zhoushan', country: 'CN', lat: 29.87, lng: 121.55, type: 'container', volume: '33.3M TEU', rank: 3 },
  { name: 'Shenzhen', country: 'CN', lat: 22.54, lng: 114.05, type: 'container', volume: '30.0M TEU', rank: 4 },
  { name: 'Guangzhou', country: 'CN', lat: 23.08, lng: 113.32, type: 'container', volume: '24.2M TEU', rank: 5 },
  { name: 'Busan', country: 'KR', lat: 35.10, lng: 129.04, type: 'container', volume: '22.7M TEU', rank: 6 },
  { name: 'Qingdao', country: 'CN', lat: 36.07, lng: 120.38, type: 'container', volume: '22.0M TEU', rank: 7 },
  { name: 'Rotterdam', country: 'NL', lat: 51.90, lng: 4.50, type: 'container', volume: '14.5M TEU', rank: 8 },
  { name: 'Dubai (Jebel Ali)', country: 'AE', lat: 25.01, lng: 55.06, type: 'container', volume: '14.0M TEU', rank: 9 },
  { name: 'Port Klang', country: 'MY', lat: 2.99, lng: 101.39, type: 'container', volume: '13.2M TEU', rank: 10 },
  { name: 'Antwerp', country: 'BE', lat: 51.30, lng: 4.40, type: 'container', volume: '12.0M TEU', rank: 11 },
  { name: 'Xiamen', country: 'CN', lat: 24.48, lng: 118.09, type: 'container', volume: '11.4M TEU', rank: 12 },
  { name: 'Los Angeles', country: 'US', lat: 33.74, lng: -118.27, type: 'container', volume: '9.9M TEU', rank: 13 },
  { name: 'Hamburg', country: 'DE', lat: 53.55, lng: 9.97, type: 'container', volume: '8.7M TEU', rank: 14 },
  { name: 'Long Beach', country: 'US', lat: 33.75, lng: -118.19, type: 'container', volume: '8.0M TEU', rank: 15 },
  { name: 'Tanjung Pelepas', country: 'MY', lat: 1.36, lng: 103.55, type: 'container', volume: '9.8M TEU', rank: 16 },
  { name: 'Colombo', country: 'LK', lat: 6.94, lng: 79.84, type: 'container', volume: '7.2M TEU', rank: 17 },
  { name: 'Savannah', country: 'US', lat: 32.08, lng: -81.09, type: 'container', volume: '5.6M TEU', rank: 20 },
  { name: 'Santos', country: 'BR', lat: -23.95, lng: -46.31, type: 'container', volume: '4.2M TEU', rank: 22 },
  { name: 'Felixstowe', country: 'GB', lat: 51.96, lng: 1.35, type: 'container', volume: '3.8M TEU', rank: 25 },
  { name: 'Tokyo', country: 'JP', lat: 35.61, lng: 139.79, type: 'container', volume: '4.5M TEU' },
  { name: 'Yokohama', country: 'JP', lat: 35.45, lng: 139.66, type: 'container', volume: '2.9M TEU' },
  { name: 'Kobe', country: 'JP', lat: 34.67, lng: 135.21, type: 'container', volume: '2.8M TEU' },
  { name: 'Nagoya', country: 'JP', lat: 35.08, lng: 136.87, type: 'container', volume: '2.6M TEU' },
  { name: 'Osaka', country: 'JP', lat: 34.63, lng: 135.41, type: 'container', volume: '2.1M TEU' },
  { name: 'Hakata (Fukuoka)', country: 'JP', lat: 33.60, lng: 130.40, type: 'container', volume: '0.9M TEU' },
  { name: 'Kitakyushu', country: 'JP', lat: 33.91, lng: 130.93, type: 'container', volume: '0.5M TEU' },
  { name: 'Shimizu', country: 'JP', lat: 35.00, lng: 138.50, type: 'container', volume: '0.5M TEU' },
  { name: 'Tomakomai', country: 'JP', lat: 42.63, lng: 141.63, type: 'container', volume: '0.4M TEU' },
  { name: 'Niigata', country: 'JP', lat: 37.95, lng: 139.06, type: 'container', volume: '0.2M TEU' },
  { name: 'Sendai', country: 'JP', lat: 38.27, lng: 141.02, type: 'container', volume: '0.2M TEU' },
  { name: 'Ras Tanura', country: 'SA', lat: 26.64, lng: 50.16, type: 'energy', volume: '6.5M bpd' },
  { name: 'Fujairah', country: 'AE', lat: 25.14, lng: 56.35, type: 'energy', volume: '3.5M bpd' },
  { name: 'Novorossiysk', country: 'RU', lat: 44.72, lng: 37.77, type: 'energy', volume: '2.8M bpd' },
  { name: 'Houston Ship Channel', country: 'US', lat: 29.73, lng: -95.27, type: 'energy', volume: '2.5M bpd' },
  { name: 'Kharg Island', country: 'IR', lat: 29.24, lng: 50.33, type: 'energy', volume: '2.0M bpd' },
  { name: 'Primorsk', country: 'RU', lat: 60.35, lng: 28.70, type: 'energy', volume: '1.6M bpd' },
  { name: 'Norfolk Naval Station', country: 'US', lat: 36.95, lng: -76.33, type: 'naval', fleet: 'US Atlantic Fleet' },
  { name: 'San Diego Naval Base', country: 'US', lat: 32.69, lng: -117.15, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Pearl Harbor', country: 'US', lat: 21.35, lng: -157.97, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Yokosuka', country: 'JP', lat: 35.28, lng: 139.67, type: 'naval', fleet: 'US 7th Fleet' },
  { name: 'Severomorsk', country: 'RU', lat: 69.07, lng: 33.42, type: 'naval', fleet: 'Russian Northern Fleet' },
  { name: 'Tartus', country: 'SY', lat: 34.89, lng: 35.89, type: 'naval', fleet: 'Russian Mediterranean' },
  { name: 'Zhanjiang', country: 'CN', lat: 21.20, lng: 110.39, type: 'naval', fleet: 'PLA Navy South Sea Fleet' },
  { name: 'Qingdao Naval', country: 'CN', lat: 36.09, lng: 120.43, type: 'naval', fleet: 'PLA Navy North Sea Fleet' },
  { name: 'Portsmouth', country: 'GB', lat: 50.80, lng: -1.11, type: 'naval', fleet: 'Royal Navy' },
  { name: 'Toulon', country: 'FR', lat: 43.12, lng: 5.93, type: 'naval', fleet: 'French Navy Mediterranean' },
  { name: 'Changi Naval Base', country: 'SG', lat: 1.33, lng: 104.01, type: 'naval', fleet: 'Republic of Singapore Navy' },
  { name: 'Visakhapatnam', country: 'IN', lat: 17.69, lng: 83.30, type: 'naval', fleet: 'Indian Navy Eastern Command' },
  { name: 'Mumbai Naval', country: 'IN', lat: 18.93, lng: 72.84, type: 'naval', fleet: 'Indian Navy Western Command' },
];

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.57, lng: 56.25, traffic: '21M bpd oil', risk: 'HIGH' },
  { name: 'Strait of Malacca', lat: 2.50, lng: 101.50, traffic: '16M bpd oil', risk: 'MODERATE' },
  { name: 'Suez Canal', lat: 30.43, lng: 32.34, traffic: '12% world trade', risk: 'ELEVATED' },
  { name: 'Bab el-Mandeb', lat: 12.58, lng: 43.33, traffic: '6.2M bpd oil', risk: 'CRITICAL' },
  { name: 'Panama Canal', lat: 9.08, lng: -79.68, traffic: '5% world trade', risk: 'LOW' },
  { name: 'Turkish Straits', lat: 41.12, lng: 29.07, traffic: '3M bpd oil', risk: 'MODERATE' },
  { name: 'Danish Straits', lat: 55.70, lng: 12.60, traffic: '3.2M bpd oil', risk: 'LOW' },
  { name: 'Cape of Good Hope', lat: -34.36, lng: 18.47, traffic: 'Alt route Suez', risk: 'LOW' },
  { name: 'Taiwan Strait', lat: 24.00, lng: 119.00, traffic: '88% large ships', risk: 'ELEVATED' },
  { name: 'Lombok Strait', lat: -8.47, lng: 115.72, traffic: 'Alt Malacca', risk: 'LOW' },
];

const STRATEGIC_PORT_NAMES = new Set([
  'Singapore',
  'Rotterdam',
  'Dubai (Jebel Ali)',
  'Los Angeles',
  'Long Beach',
  'Norfolk Naval Station',
  'San Diego Naval Base',
  'Yokosuka',
  'Zhanjiang',
  'Toulon',
]);

function nowIso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeViewport(input) {
  if (!input || typeof input !== 'object') return null;
  const south = finiteNumber(input.south ?? input.s);
  const west = finiteNumber(input.west ?? input.w);
  const north = finiteNumber(input.north ?? input.n);
  const east = finiteNumber(input.east ?? input.e);
  if ([south, west, north, east].some((n) => n == null)) return null;

  const s = clamp(south, -90, 90);
  const n = clamp(north, -90, 90);
  const w = clamp(west, -180, 180);
  const e = clamp(east, -180, 180);
  if (s >= n || w >= e) return null;
  if ((n - s) * (e - w) > MAX_VIEWPORT_AREA_DEG2) return null;
  return { south: s, west: w, north: n, east: e };
}

function boxAround(lat, lng, latRadius, lngRadius) {
  const south = clamp(lat - latRadius, -90, 90);
  const north = clamp(lat + latRadius, -90, 90);
  const west = clamp(lng - lngRadius, -180, 180);
  const east = clamp(lng + lngRadius, -180, 180);
  if (south >= north || west >= east) return null;
  return [[Number(south.toFixed(4)), Number(west.toFixed(4))], [Number(north.toFixed(4)), Number(east.toFixed(4))]];
}

function subscriptionBoxes(viewport) {
  const boxes = [];
  if (viewport) boxes.push([[viewport.south, viewport.west], [viewport.north, viewport.east]]);
  for (const point of CHOKEPOINTS) {
    const box = boxAround(point.lat, point.lng, 1.2, 1.5);
    if (box) boxes.push(box);
  }
  for (const port of PORTS) {
    if (!STRATEGIC_PORT_NAMES.has(port.name)) continue;
    const box = boxAround(port.lat, port.lng, 0.7, 0.9);
    if (box) boxes.push(box);
  }
  const seen = new Set();
  return boxes.filter((box) => {
    const key = JSON.stringify(box);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getDistanceKm(lat1, lng1, lat2, lng2) {
  const dx = (lng1 - lng2) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const dy = lat1 - lat2;
  return Math.sqrt(dx * dx + dy * dy) * 111.32;
}

function getHorusShipType(typeCode) {
  const n = Number(typeCode);
  if (!Number.isFinite(n) || n <= 0) return 'cargo';
  if (n >= 80 && n <= 89) return 'tanker';
  if (n >= 70 && n <= 79) return 'cargo';
  if (n === 35 || n === 55) return 'military';
  return 'cargo';
}

const NAV_STATUS = {
  0: 'Underway Using Engine',
  1: 'At Anchor',
  2: 'Not Under Command',
  3: 'Restricted Manoeuvrability',
  4: 'Constrained By Draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged In Fishing',
  8: 'Under Way Sailing',
};

// AIS sentinel handling: Sog 102.3 = "not available", heading 511 = "not available",
// Cog 360 = "not available". Render layers must never see the sentinels as data.
function sanitizeSpeed(value) {
  const n = finiteNumber(value);
  if (n == null || n < 0 || n >= 102.2) return null;
  return n;
}

function sanitizeHeading(trueHeading, cog) {
  const hdg = finiteNumber(trueHeading);
  if (hdg != null && hdg >= 0 && hdg < 360) return hdg;
  const course = finiteNumber(cog);
  if (course != null && course >= 0 && course < 360) return course;
  return null;
}

// (0,0) is the AIS "null island" default for misconfigured transponders.
function isPlausiblePosition(lat, lng) {
  if (lat == null || lng == null) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) return false;
  return true;
}

function formatEta(eta) {
  if (!eta || typeof eta !== 'object') return null;
  const month = finiteNumber(eta.Month);
  const day = finiteNumber(eta.Day);
  const hour = finiteNumber(eta.Hour);
  const minute = finiteNumber(eta.Minute);
  // AIS ETA sentinels: month 0, day 0, hour 24, minute 60 mean "not available".
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const time = hour != null && hour >= 0 && hour < 24 && minute != null && minute >= 0 && minute < 60
    ? ` ${pad(hour)}:${pad(minute)} UTC`
    : '';
  return `${pad(month)}-${pad(day)}${time}`;
}

function createService(options = {}) {
  const env = options.env || process.env;
  const timers = options.timers || {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const WebSocket = options.WebSocket || DefaultWebSocket;
  const reconnectMs = Number(options.reconnectMs || RECONNECT_MS);
  const errorReconnectMs = Number(options.errorReconnectMs || ERROR_RECONNECT_MS);
  const leaseTtlMs = Number(options.leaseTtlMs || LEASE_TTL_MS);
  const shipTtlMs = Number(options.shipTtlMs || SHIP_TTL_MS);
  const ships = new Map();
  const state = {
    active: { maritime: false },
    maritime: {
      socket: null,
      reconnectTimer: null,
      leaseTimer: null,
      streaming: false,
      expiresAt: null,
      viewport: null,
      status: 'idle',
      lastError: null,
      connectedAt: null,
      lastMessageAt: null,
    },
  };

  const app = express();
  app.use(express.json({ limit: '16kb' }));

  function apiKey() {
    return cleanString(env.AIS_API_KEY);
  }

  function isMaritimeActive() {
    return state.maritime.expiresAt != null && now() < state.maritime.expiresAt;
  }

  function closeActiveSocket() {
    const socket = state.maritime.socket;
    state.maritime.socket = null;
    if (!socket) return;
    try {
      socket.removeAllListeners?.('close');
      socket.removeAllListeners?.('error');
      socket.on?.('error', () => {});
    } catch {
      /* best effort */
    }
    try {
      socket.close();
    } catch {
      /* best effort */
    }
  }

  function pruneStaleShips() {
    const cutoff = now() - shipTtlMs;
    for (const [mmsi, ship] of ships.entries()) {
      if (!Number.isFinite(ship.timestamp) || ship.timestamp < cutoff) ships.delete(mmsi);
    }
    while (ships.size > MAX_SHIPS_CACHE) {
      const first = ships.keys().next().value;
      if (first == null) break;
      ships.delete(first);
    }
  }

  function disconnect(status = null, reconnectDelayMs = null) {
    closeActiveSocket();
    state.maritime.streaming = false;
    state.maritime.connectedAt = null;
    if (status) state.maritime.status = status;
    else state.maritime.status = isMaritimeActive() ? 'connecting' : 'idle';
    pruneStaleShips();
    if (reconnectDelayMs != null && isMaritimeActive()) scheduleReconnect(reconnectDelayMs);
  }

  function scheduleReconnect(delayMs) {
    if (state.maritime.reconnectTimer) timers.clearTimeout(state.maritime.reconnectTimer);
    state.maritime.reconnectTimer = timers.setTimeout(() => {
      state.maritime.reconnectTimer = null;
      ensureStreaming();
    }, delayMs);
  }

  function stopMaritime() {
    if (state.maritime.reconnectTimer) {
      timers.clearTimeout(state.maritime.reconnectTimer);
      state.maritime.reconnectTimer = null;
    }
    if (state.maritime.leaseTimer) {
      timers.clearTimeout(state.maritime.leaseTimer);
      state.maritime.leaseTimer = null;
    }
    state.maritime.expiresAt = null;
    disconnect('idle');
    state.active.maritime = false;
  }

  function parseShipMessage(parsed) {
    const metadata = parsed?.MetaData || parsed?.Metadata || {};
    const position = parsed?.Message?.PositionReport
      || parsed?.Message?.StandardClassBPositionReport
      || parsed?.Message?.ExtendedClassBPositionReport;
    const staticData = parsed?.Message?.ShipStaticData || parsed?.Message?.StaticDataReport;
    const mmsi = metadata.MMSI ?? metadata.MMSI_String ?? position?.UserID ?? staticData?.UserID;
    if (!mmsi) return;
    const key = Number(mmsi);
    if (!Number.isFinite(key)) return;

    const ship = ships.get(key) || { id: key, mmsi: key, timestamp: now(), type: 'cargo' };
    const metadataName = cleanString(metadata.ShipName);
    if (metadataName) ship.name = metadataName;

    if (position) {
      const lat = finiteNumber(position.Latitude);
      const lng = finiteNumber(position.Longitude);
      if (isPlausiblePosition(lat, lng)) {
        ship.lat = Math.round(lat * 100000) / 100000;
        ship.lng = Math.round(lng * 100000) / 100000;
        ship.speed = sanitizeSpeed(position.Sog);
        ship.heading = sanitizeHeading(position.TrueHeading, position.Cog);
        ship.timestamp = now();
      }
      const navStatus = NAV_STATUS[finiteNumber(position.NavigationalStatus)];
      if (navStatus) ship.nav_status = navStatus;
      const positionName = cleanString(position.Name);
      if (positionName) ship.name = positionName;
      if (position.Type != null) ship.type = getHorusShipType(position.Type);
    } else {
      const lat = finiteNumber(metadata.latitude ?? metadata.Latitude);
      const lng = finiteNumber(metadata.longitude ?? metadata.Longitude);
      if (isPlausiblePosition(lat, lng)) {
        ship.lat = Math.round(lat * 100000) / 100000;
        ship.lng = Math.round(lng * 100000) / 100000;
        ship.timestamp = now();
      }
    }

    if (staticData) {
      const name = cleanString(staticData.Name ?? staticData.ReportA?.Name ?? staticData.ReportB?.Name);
      const destination = cleanString(staticData.Destination ?? staticData.ReportB?.Destination);
      const callsign = cleanString(staticData.CallSign ?? staticData.ReportB?.CallSign);
      if (name) ship.name = name;
      if (destination) ship.destination = destination;
      if (callsign) ship.callsign = callsign;
      const imo = finiteNumber(staticData.ImoNumber);
      if (imo) ship.imo = imo;
      const draught = finiteNumber(staticData.MaximumStaticDraught);
      if (draught != null && draught > 0) ship.draught = draught;
      const eta = formatEta(staticData.Eta);
      if (eta) ship.eta = eta;
      const dim = staticData.Dimension ?? staticData.ReportB?.Dimension;
      if (dim && typeof dim === 'object') {
        const length = (finiteNumber(dim.A) || 0) + (finiteNumber(dim.B) || 0);
        const width = (finiteNumber(dim.C) || 0) + (finiteNumber(dim.D) || 0);
        if (length > 0) ship.length = length;
        if (width > 0) ship.width = width;
      }
      ship.type = getHorusShipType(staticData.Type ?? staticData.ReportB?.ShipType ?? staticData.ReportB?.Type);
    }

    if (Number.isFinite(ship.lat) && Number.isFinite(ship.lng)) ships.set(key, ship);
    // Hot path under continuous streaming — only evict on size here; TTL pruning
    // runs in snapshots and on lease/disconnect transitions.
    while (ships.size > MAX_SHIPS_CACHE) {
      const first = ships.keys().next().value;
      if (first == null) break;
      ships.delete(first);
    }
  }

  function sendSubscription(socket) {
    const subscription = {
      APIKey: apiKey(),
      BoundingBoxes: subscriptionBoxes(state.maritime.viewport),
      FilterMessageTypes: AIS_MESSAGE_TYPES,
    };
    socket.send(JSON.stringify(subscription));
  }

  function ensureStreaming() {
    if (!isMaritimeActive()) {
      stopMaritime();
      return;
    }
    const key = apiKey();
    if (!key) {
      state.maritime.status = 'missing_key';
      return;
    }
    if (state.maritime.socket) return;

    state.maritime.status = 'connecting';
    state.maritime.lastError = null;

    let socket;
    try {
      socket = new WebSocket('wss://stream.aisstream.io/v0/stream');
    } catch (error) {
      state.maritime.lastError = error instanceof Error ? error.message : String(error);
      disconnect('error', errorReconnectMs);
      return;
    }

    state.maritime.socket = socket;

    socket.on('open', () => {
      if (state.maritime.socket !== socket) return;
      try {
        sendSubscription(socket);
        state.maritime.streaming = true;
        state.maritime.status = 'streaming';
        state.maritime.connectedAt = now();
      } catch (error) {
        state.maritime.lastError = error instanceof Error ? error.message : String(error);
        disconnect('error', errorReconnectMs);
      }
    });

    socket.on('message', (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const parsed = JSON.parse(text);
        const upstreamError = cleanString(parsed?.error);
        if (upstreamError) {
          // Upstream rejections (bad key, bad subscription) back off hard so we
          // don't hammer AISStream with a broken subscription every few seconds.
          state.maritime.lastError = upstreamError;
          disconnect('error', errorReconnectMs);
          return;
        }
        state.maritime.lastMessageAt = now();
        parseShipMessage(parsed);
      } catch {
        /* Ignore malformed upstream messages. */
      }
    });

    socket.on('close', () => {
      if (state.maritime.socket !== socket) return;
      state.maritime.socket = null;
      state.maritime.streaming = false;
      state.maritime.connectedAt = null;
      if (isMaritimeActive()) {
        state.maritime.status = 'connecting';
        scheduleReconnect(reconnectMs);
      }
    });

    socket.on('error', (error) => {
      state.maritime.lastError = error instanceof Error ? error.message : String(error);
      disconnect('error', reconnectMs);
    });
  }

  function scheduleLeaseExpiry() {
    if (state.maritime.leaseTimer) {
      timers.clearTimeout(state.maritime.leaseTimer);
      state.maritime.leaseTimer = null;
    }
    if (!state.maritime.expiresAt) return;
    const delay = Math.max(0, state.maritime.expiresAt - now());
    state.maritime.leaseTimer = timers.setTimeout(() => {
      if (isMaritimeActive()) {
        scheduleLeaseExpiry();
        return;
      }
      stopMaritime();
    }, delay);
  }

  function activateMaritime(viewport) {
    state.maritime.expiresAt = now() + leaseTtlMs;
    state.active.maritime = true;
    const viewportChanged = viewport && JSON.stringify(viewport) !== JSON.stringify(state.maritime.viewport);
    if (viewport) state.maritime.viewport = viewport;
    scheduleLeaseExpiry();
    ensureStreaming();
    // AISStream accepts a replacement subscription on the open socket, so a viewport
    // change re-targets the live stream without a reconnect.
    if (viewportChanged && state.maritime.streaming && state.maritime.socket) {
      try {
        sendSubscription(state.maritime.socket);
      } catch (error) {
        state.maritime.lastError = error instanceof Error ? error.message : String(error);
        disconnect('error', reconnectMs);
      }
    }
  }

  function dynamicPorts(shipsForAggregates) {
    return PORTS.map((port) => {
      let nearbyCount = 0;
      let waitingCount = 0;
      for (const ship of shipsForAggregates) {
        if (Math.abs(port.lat - ship.lat) > 0.6 || Math.abs(port.lng - ship.lng) > 0.8) continue;
        if (getDistanceKm(port.lat, port.lng, ship.lat, ship.lng) < 50) {
          nearbyCount += 1;
          if (ship.speed < 0.5 && ship.type !== 'military') waitingCount += 1;
        }
      }
      const congestionRatio = nearbyCount > 0 ? waitingCount / nearbyCount : 0;
      let congestion = 'NORMAL';
      let dwellTime = '1-2 Days';
      if (congestionRatio > 0.6 || waitingCount > 30) {
        congestion = 'SEVERE';
        dwellTime = '7+ Days';
      } else if (congestionRatio > 0.4 || waitingCount > 15) {
        congestion = 'CONGESTED';
        dwellTime = '3-5 Days';
      }
      return {
        ...port,
        volume: `${port.volume} | LIVE: ${nearbyCount} (WAITING: ${waitingCount})`,
        congestion,
        dwell_time: dwellTime,
      };
    });
  }

  function dynamicChokepoints(shipsForAggregates) {
    return CHOKEPOINTS.map((choke) => {
      let nearbyCount = 0;
      for (const ship of shipsForAggregates) {
        if (Math.abs(choke.lat - ship.lat) > 1.2 || Math.abs(choke.lng - ship.lng) > 1.5) continue;
        if (getDistanceKm(choke.lat, choke.lng, ship.lat, ship.lng) < 100) nearbyCount += 1;
      }
      let risk = choke.risk;
      if (nearbyCount > 50) risk = 'CRITICAL';
      else if (nearbyCount > 20 && risk !== 'CRITICAL') risk = 'HIGH';
      else if (nearbyCount > 5 && risk === 'LOW') risk = 'ELEVATED';
      return {
        ...choke,
        traffic: `${choke.traffic} | LIVE SHIPS: ${nearbyCount}`,
        risk,
      };
    });
  }

  function maritimeSnapshot(viewport) {
    pruneStaleShips();
    const sortedShips = [...ships.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const missingKey = !apiKey();
    const usableShips = missingKey ? [] : sortedShips;
    // Aggregates (port congestion / chokepoint traffic) always use the full cache;
    // only the returned vessel list narrows to the requested viewport.
    const shipsForAggregates = usableShips.slice(0, MAX_SHIPS_FOR_AGGREGATES);
    const viewportShips = viewport
      ? usableShips.filter((s) => s.lat >= viewport.south && s.lat <= viewport.north
        && s.lng >= viewport.west && s.lng <= viewport.east)
      : usableShips;
    const returnedShips = viewportShips.slice(0, MAX_SHIPS_RESPONSE);
    const status = missingKey ? 'missing_key' : state.maritime.status;
    return {
      ports: dynamicPorts(shipsForAggregates),
      chokepoints: dynamicChokepoints(shipsForAggregates),
      ships: returnedShips,
      total_ports: PORTS.length,
      total_chokepoints: CHOKEPOINTS.length,
      total_ships: usableShips.length,
      returned_ships: returnedShips.length,
      status,
      active: isMaritimeActive(),
      streaming: state.maritime.streaming,
      source: 'aisstream',
      ship_ttl_ms: shipTtlMs,
      connected_at: nowIso(state.maritime.connectedAt),
      last_message_at: nowIso(state.maritime.lastMessageAt),
      error: state.maritime.lastError,
      timestamp: nowIso(now()),
    };
  }

  app.get('/health', (_req, res) => {
    pruneStaleShips();
    res.json({
      status: 'ok',
      service: 'horus-live-feed',
      memory_only: true,
      active: { maritime: isMaritimeActive() },
      maritime: {
        status: !apiKey() ? 'missing_key' : state.maritime.status,
        ships: ships.size,
        streaming: state.maritime.streaming,
        connected_at: nowIso(state.maritime.connectedAt),
        last_message_at: nowIso(state.maritime.lastMessageAt),
      },
      uptime_s: Math.round(process.uptime()),
      timestamp: nowIso(now()),
    });
  });

  app.post('/v1/activity', (req, res) => {
    const body = req.body || {};
    const feed = cleanString(body.feed);
    if (feed !== 'maritime') return res.status(400).json({ error: 'unsupported feed' });
    const active = body.active === true;
    if (active) activateMaritime(normalizeViewport(body.viewport));
    else stopMaritime();
    return res.json({
      active: { maritime: isMaritimeActive() },
      expires_at: nowIso(state.maritime.expiresAt),
      status: !apiKey() ? 'missing_key' : state.maritime.status,
      timestamp: nowIso(now()),
    });
  });

  app.get('/v1/feeds/maritime/snapshot', (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Optional ?south&west&north&east narrows the returned vessel list to the
    // renderer viewport. Out-of-range/oversized boxes fall back to unfiltered.
    res.json(maritimeSnapshot(normalizeViewport(req.query)));
  });

  app.get('/', (_req, res) => {
    res.json({
      service: 'horus-live-feed',
      endpoints: ['/health', '/v1/activity', '/v1/feeds/maritime/snapshot'],
      feeds: ['maritime'],
      memory_only: true,
    });
  });

  return {
    app,
    close: stopMaritime,
    getState: () => ({
      active: { maritime: isMaritimeActive() },
      maritime: {
        status: state.maritime.status,
        ships: ships.size,
        streaming: state.maritime.streaming,
        expiresAt: state.maritime.expiresAt,
      },
    }),
  };
}

if (require.main === module) {
  const service = createService();
  const server = service.app.listen(PORT, HOST, () => {
    console.log(`[live-feed] listening on ${HOST}:${PORT}`);
    if (!process.env.AIS_API_KEY) console.warn('[live-feed] AIS_API_KEY not set; maritime ships will be empty');
  });

  const shutdown = (signal) => {
    console.log(`[live-feed] ${signal} received; shutting down`);
    service.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[live-feed] unhandled rejection:', err);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[live-feed] uncaught exception:', err);
    shutdown('uncaughtException');
  });
}

module.exports = {
  CHOKEPOINTS,
  PORTS,
  createService,
  normalizeViewport,
  subscriptionBoxes,
};
