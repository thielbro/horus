import type { RegistryGroup, RegistryLayer, StyleLayerSpec, ThemeMode } from './types';

// Theme-dependent flight accents (ghost mode recolors commercial/private/jets).
const PHANTOM_PURPLE = '#B388FF';
const GHOST_PRIV = '#CE93D8';
const GHOST_GOV = '#D500F9';
const flightCom = (t: ThemeMode) => (t === 'ghost' ? PHANTOM_PURPLE : '#00E5FF');
const flightPriv = (t: ThemeMode) => (t === 'ghost' ? GHOST_PRIV : '#FFD700');
const flightGov = (t: ThemeMode) => (t === 'ghost' ? GHOST_GOV : '#FF9500');

// Ghost-mode recolors for surveillance layers (in-place recolor handled live by OsirisMap).
const cameraColor = (t: ThemeMode) => (t === 'ghost' ? '#B388FF' : '#00E676');
const surveillanceColor = (t: ThemeMode) => (t === 'ghost' ? '#FF80AB' : '#FFAB00');

// CCTV continents: [activeLayers key, data bucket]. The cameras are loaded one continent at a
// time (separate feeds/buckets) but plotted through a SINGLE map source ('cctv'), so the
// existing cctv style layers + click handler are reused unchanged. The render binding below
// unions whichever continents are toggled on. Continent toggles are virtual keys (driven by
// the Surveillance panel), like cables/sdk_air.
const CCTV_CONTINENTS: ReadonlyArray<readonly [string, string]> = [
  ['cctv_europe', 'cameras_europe'],
  ['cctv_north_america', 'cameras_north_america'],
  ['cctv_asia', 'cameras_asia'],
  ['cctv_oceania', 'cameras_oceania'],
];
const cctvFeature = (c: any) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
  properties: { id: c.id, name: c.name, city: c.city, country: c.country, source: c.source, feed_url: c.feed_url, stream_url: c.stream_url, stream_type: c.stream_type, external_url: c.external_url },
});

// Generic OSM point-layer style (glow + dot + label) for the police / Flock / mass-surveillance
// layers. Static color (not theme-recolored) — mirrors the surveillance layer's shape.
const osmPointStyle = (prefix: string, source: string, color: string): StyleLayerSpec[] => ([
  { id: `${prefix}-glow`, source, type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 8, 7, 12, 11, 16, 16], 'circle-color': color, 'circle-opacity': 0.18, 'circle-blur': 1 } },
  { id: `${prefix}-dots`, source, type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2, 8, 3.5, 12, 6, 16, 9], 'circle-color': color, 'circle-opacity': 0.85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.8 } },
  { id: `${prefix}-label`, source, type: 'symbol', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.4], 'text-max-width': 12, 'text-allow-overlap': false }, paint: { 'text-color': color, 'text-halo-color': '#000000', 'text-halo-width': 1.5, 'text-opacity': 0.75 } },
]);

// Cap on malware nodes woven into the botnet mesh (stability — mirrors OsirisMap's constant).
const MAX_MESH_NODES = 750;
const SOLAR_TERMINATOR_TTL_MS = 60_000;
let solarTerminatorCache: { at: number; points: [number, number][] } | null = null;

// SEA-domain submarine-cable background arcs to drop (light blue noise from the source map).
const SDK_IGNORED_CABLE_COLORS = new Set(['#9BB5CC', '#A0B8CD', '#8EABC2', '#9bb5cc', '#a0b8cd', '#8eabc2']);

// Day/night terminator polygon (current UTC time). Re-run on OsirisMap's 5-min interval.
function computeSolarTerminatorRaw(): [number, number][] {
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const declination = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const decRad = declination * Math.PI / 180;
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const subsolarLng = (12 - utcHours) * 15;
  const points: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    const lngRad = (lng - subsolarLng) * Math.PI / 180;
    const lat = Math.atan(-Math.cos(lngRad) / Math.tan(decRad)) * 180 / Math.PI;
    points.push([lng, lat]);
  }
  const darkSide = declination >= 0 ? -90 : 90;
  points.push([180, darkSide]);
  points.push([-180, darkSide]);
  points.push(points[0]);
  return points;
}

function computeSolarTerminator(): [number, number][] {
  const now = Date.now();
  if (solarTerminatorCache && now - solarTerminatorCache.at < SOLAR_TERMINATOR_TTL_MS) {
    return solarTerminatorCache.points;
  }
  const points = computeSolarTerminatorRaw();
  solarTerminatorCache = { at: now, points };
  return points;
}

// Always-on conflict-zone warning markers (verbatim from OsirisMap; no data source / no toggle).
const CONFLICT_ZONES = [
  { label: 'UKRAINE WAR', severity: 'war', lat: 48.5, lng: 31.2, description: 'Live reporting: Ongoing Russian invasion of Ukraine and active frontlines.', sourceUrl: 'https://liveuamap.com/' },
  { label: 'GAZA CONFLICT', severity: 'war', lat: 31.35, lng: 34.35, description: 'Live reporting: Active military operations and humanitarian crisis in Gaza.', sourceUrl: 'https://israelpalestine.liveuamap.com/' },
  { label: 'LEBANON BORDER', severity: 'high', lat: 33.377, lng: 35.483, description: 'Live reporting: An airstrike targeted the city of Nabatieh.', sourceUrl: 'https://lebanon.liveuamap.com/en/2026/6-june-11-an-airstrike-targeted-the-city-of-nabatieh' },
  { label: 'SUDAN CIVIL WAR', severity: 'war', lat: 15.0, lng: 30.0, description: 'Live reporting: Armed conflict between SAF and RSF factions across Sudan.', sourceUrl: 'https://sudan.liveuamap.com/' },
  { label: 'MYANMAR CONFLICT', severity: 'war', lat: 19.5, lng: 96.5, description: 'Live reporting: Internal conflict and military junta opposition operations.', sourceUrl: 'https://myanmar.liveuamap.com/' },
  { label: 'DRC EASTERN CONFLICT', severity: 'war', lat: -1.0, lng: 28.5, description: 'M23 rebel offensive and regional instability.' },
  { label: 'YEMEN WAR', severity: 'war', lat: 15.5, lng: 48.0, description: 'Houthi militant operations and Red Sea maritime threats.', sourceUrl: 'https://yemen.liveuamap.com/' },
  { label: 'SYRIA', severity: 'high', lat: 35.0, lng: 38.5, description: 'Live reporting: Ongoing civil war and localized insurgencies.', sourceUrl: 'https://syria.liveuamap.com/' },
  { label: 'TAIWAN STRAIT', severity: 'elevated', lat: 24.0, lng: 119.5, description: 'Elevated military drills and regional tension.' },
  { label: 'KOREAN DMZ', severity: 'elevated', lat: 38.3, lng: 127.0, description: 'Ongoing cross-border tension and military posturing.' },
  { label: 'SAHEL INSTABILITY', severity: 'high', lat: 14.0, lng: 5.0, description: 'Insurgencies and military coups across the Sahel region.' },
  { label: 'SOMALIA', severity: 'high', lat: 5.0, lng: 46.0, description: 'Al-Shabaab insurgency and counter-terrorism operations.' },
  { label: 'RED SEA THREAT', severity: 'high', lat: 16.0, lng: 40.0, description: 'Houthi anti-ship missile and drone attacks on maritime traffic.', sourceUrl: 'https://yemen.liveuamap.com/' },
];

// Flight features with optional decimation (verbatim from OsirisMap's toFeatures helper).
function flightFeatures(arr: any[], decimate = 1) {
  let filtered = arr || [];
  if (decimate > 1) filtered = filtered.filter((_: any, i: number) => i % decimate === 0);
  return filtered.map((f: any) => ({
    type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [f.lng, f.lat] },
    properties: { callsign: f.callsign, heading: f.heading || 0, alt: f.alt, model: f.model, speed_knots: f.speed_knots, registration: f.registration, icao24: f.icao24 },
  }));
}

// Shared flight symbol layout (icon colored via createIcon; layer spec itself is theme-independent).
const flightLayout = (icon: string) => ({
  'icon-image': icon, 'icon-size': ['interpolate',['linear'],['zoom'], 1,0.4, 5,0.7, 10,1],
  'icon-rotate': ['get','heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
});

export const BUILTIN_GROUPS: RegistryGroup[] = [
  { id: 'SDK', label: 'SDK', fullLabel: 'OSIRIS SDK', color: '#1565C0', order: 0 },
  { id: 'AVIATION', label: 'AVIATION', fullLabel: 'AVIATION', color: flightCom, order: 1 },
  { id: 'MARITIME', label: 'MARITIME', fullLabel: 'MARITIME & SPACE', color: '#26C6DA', order: 2 },
  { id: 'SURVEIL', label: 'SURVEIL', fullLabel: 'SURVEILLANCE', color: '#7E57C2', order: 3 },
  { id: 'HAZARD', label: 'HAZARD', fullLabel: 'NATURAL HAZARDS', color: '#F9A825', order: 4 },
  { id: 'THREAT', label: 'THREAT', fullLabel: 'THREATS & INFRA', color: '#D32F2F', order: 5 },
  { id: 'NETWORK', label: 'NETWORK', fullLabel: 'NETWORK INTEL', color: '#D32F2F', order: 6 },
  { id: 'DISPLAY', label: 'DISPLAY', fullLabel: 'DISPLAY', color: '#448AFF', order: 7 },
];

export const BUILTIN_LAYERS: RegistryLayer[] = [
  // ── SDK ──
  {
    id: 'sdk_sea', label: 'Maritime Lines', group: 'SDK', icon: 'Anchor', color: '#4FC3F7', countBuckets: ['sdk_entities'],
    // Lattice sensor mesh — SEA uses real submarine-cable data; AIR/INTEL layers exist for
    // curated routes (toggled via sdk_air / sdk_naval) and share the single sdk-links source.
    styleLayers: [
      { id: 'sdk-sea', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'SEA'], paint: { 'line-color': ['coalesce', ['get', 'color'], '#1976D2'], 'line-width': ['interpolate',['linear'],['zoom'], 1, 0.8, 5, 1.5, 10, 2.5], 'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 0.5, 10, 0.7] } },
      { id: 'sdk-air-atmo', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'AIR'], paint: { 'line-color': '#4DD0E1', 'line-width': ['interpolate',['linear'],['zoom'], 1, 1.5, 5, 5, 10, 8], 'line-opacity': 0.04, 'line-blur': 3 } },
      { id: 'sdk-air-glow', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'AIR'], paint: { 'line-color': '#80DEEA', 'line-width': ['interpolate',['linear'],['zoom'], 1, 0.8, 5, 2, 10, 4], 'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.08, 5, 0.12, 10, 0.18], 'line-blur': 1 } },
      { id: 'sdk-air', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'AIR'], paint: { 'line-color': '#B2EBF2', 'line-width': ['interpolate',['linear'],['zoom'], 1, 0.15, 5, 0.6, 10, 1.2], 'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.2, 5, 0.35, 10, 0.5] } },
      { id: 'sdk-intel-atmo', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'INTEL'], paint: { 'line-color': '#7986CB', 'line-width': ['interpolate',['linear'],['zoom'], 1, 2.5, 5, 7, 10, 12], 'line-opacity': 0.06, 'line-blur': 5 } },
      { id: 'sdk-intel-glow', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'INTEL'], paint: { 'line-color': '#9FA8DA', 'line-width': ['interpolate',['linear'],['zoom'], 1, 1.2, 5, 3, 10, 6], 'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.12, 5, 0.18, 10, 0.25], 'line-blur': 2 } },
      { id: 'sdk-intel', source: 'sdk-links', type: 'line', filter: ['==',['get','domain'],'INTEL'], paint: { 'line-color': '#C5CAE9', 'line-width': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 1, 10, 2], 'line-opacity': ['interpolate',['linear'],['zoom'], 1, 0.3, 5, 0.45, 10, 0.7] } },
    ],
    render: [
      { source: 'sdk-entities', toFeatures: () => [] },
      {
        source: 'sdk-links',
        toFeatures: (data, active) => {
          const anySDK = active.sdk_sea || active.sdk_air || active.sdk_naval;
          if (!anySDK) return [];
          const links: any[] = [];
          // SEA domain: real submarine cable data (1-for-1 match)
          if (active.sdk_sea && data.submarine_cables) {
            for (const cable of data.submarine_cables) {
              if (!cable.geometry) continue;
              if (cable.properties?.color && SDK_IGNORED_CABLE_COLORS.has(cable.properties.color)) continue;
              links.push({
                type: 'Feature', geometry: cable.geometry,
                properties: { domain: 'SEA', fromName: cable.properties?.name || 'Submarine Cable', toName: cable.properties?.landing_points || '', source: 'Global Subsea Cable Network', url: 'https://www.submarinecablemap.com/', ...cable.properties, color: '#1976D2' },
              });
            }
          }
          return links;
        },
      },
    ],
  },
  { id: 'sdk_ransomware', label: 'Ransomware Feed', group: 'SDK', icon: 'AlertTriangle', color: '#D32F2F', countBuckets: ['sdk_entities'], comingSoon: true },
  // ── AVIATION ──
  {
    id: 'flights', label: 'Commercial', group: 'AVIATION', icon: 'Plane', color: flightCom, countBuckets: ['commercial_flights'],
    styleLayers: [{ id: 'fl-commercial', source: 'flights', type: 'symbol', layout: flightLayout('plane-cyan'), paint: { 'icon-opacity': 0.85 } }],
    render: [{ source: 'flights', toFeatures: (data, active) => active.flights ? flightFeatures(data.commercial_flights, 10) : [] }],
  },
  {
    id: 'private', label: 'Private', group: 'AVIATION', icon: 'Plane', color: flightPriv, countBuckets: ['private_flights'],
    styleLayers: [{ id: 'fl-private', source: 'private-fl', type: 'symbol', layout: flightLayout('plane-green'), paint: { 'icon-opacity': 0.85 } }],
    render: [{ source: 'private-fl', toFeatures: (data, active) => active.private ? flightFeatures(data.private_flights, 2) : [] }],
  },
  {
    id: 'jets', label: 'Private Jets', group: 'AVIATION', icon: 'Plane', color: flightGov, countBuckets: ['private_jets'],
    styleLayers: [{ id: 'fl-jets', source: 'jets', type: 'symbol', layout: flightLayout('plane-pink'), paint: { 'icon-opacity': 0.85 } }],
    render: [{ source: 'jets', toFeatures: (data, active) => active.jets ? flightFeatures(data.private_jets, 2) : [] }],
  },
  {
    id: 'military', label: 'Military', group: 'AVIATION', icon: 'Shield', color: '#FF0000', countBuckets: ['military_flights'],
    styleLayers: [{ id: 'fl-military', source: 'military', type: 'symbol', layout: flightLayout('plane-red'), paint: { 'icon-opacity': 0.85 } }],
    render: [{ source: 'military', toFeatures: (data, active) => active.military ? flightFeatures(data.military_flights) : [] }],
  },
  // ── MARITIME ──
  {
    id: 'maritime', label: 'Maritime / Naval', group: 'MARITIME', icon: 'Ship', color: '#26C6DA', countBuckets: ['maritime_ships', 'maritime_ports', 'maritime_chokepoints'],
    // ship-dots / ship-label style layers stay raw in OsirisMap init — they sit after the
    // SDK mesh lines in z-order, so they can't be added at the maritime/choke init position.
    styleLayers: [
      { id: 'maritime-glow', source: 'maritime', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,12, 10,20], 'circle-color': ['match', ['get','type'], 'naval','#D32F2F', 'energy','#E65100', '#26C6DA'], 'circle-opacity': 0.08, 'circle-blur': 1 } },
      { id: 'maritime-dots', source: 'maritime', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,9], 'circle-color': ['match', ['get','type'], 'naval','#D32F2F', 'energy','#E65100', '#26C6DA'], 'circle-opacity': 0.8, 'circle-stroke-width': 1.5, 'circle-stroke-color': ['match', ['get','type'], 'naval','#D32F2F', 'energy','#E65100', '#26C6DA'], 'circle-stroke-opacity': 0.35 } },
      { id: 'maritime-label', source: 'maritime', type: 'symbol', minzoom: 4, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false }, paint: { 'text-color': '#26C6DA', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 } },
      { id: 'choke-glow', source: 'maritime-choke', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,18, 10,28], 'circle-color': '#E65100', 'circle-opacity': 0.1, 'circle-blur': 1 } },
      { id: 'choke-dots', source: 'maritime-choke', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,7, 10,12], 'circle-color': ['match', ['get','risk'], 'CRITICAL','#D32F2F', 'HIGH','#E65100', 'ELEVATED','#F9A825', '#26A69A'], 'circle-opacity': 0.85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#E65100', 'circle-stroke-opacity': 0.4 } },
      { id: 'choke-label', source: 'maritime-choke', type: 'symbol', minzoom: 3, layout: { 'text-field': ['get','name'], 'text-size': 10, 'text-font': ['Open Sans Bold'], 'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false }, paint: { 'text-color': '#E65100', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.9 } },
    ],
    render: [
      { source: 'maritime', toFeatures: (data, active) => (active.maritime && data.maritime_ports) ? data.maritime_ports.map((p: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: p.name, country: p.country, type: p.type, volume: p.volume, fleet: p.fleet, rank: p.rank } })) : [] },
      { source: 'maritime-choke', toFeatures: (data, active) => (active.maritime && data.maritime_chokepoints) ? data.maritime_chokepoints.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { name: c.name, traffic: c.traffic, risk: c.risk } })) : [] },
      { source: 'maritime-ships', toFeatures: (data, active) => (active.maritime && data.maritime_ships) ? data.maritime_ships.map((s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { name: s.name || s.mmsi?.toString() || 'Unknown', type: s.type || 'cargo', speed: s.speed, heading: s.heading, destination: s.destination, flag: s.flag, mmsi: s.mmsi, imo: s.imo } })) : [] },
    ],
  },
  {
    id: 'satellites', label: 'Satellites', group: 'MARITIME', icon: 'Satellite', color: '#D4AF37', countBuckets: ['satellites'],
    styleLayers: [
      { id: 'sat-glow', source: 'satellites', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,6], 'circle-color': ['get','color'], 'circle-opacity': 0.3, 'circle-blur': 1 } },
      { id: 'sat-dots', source: 'satellites', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,1.5, 5,3], 'circle-color': ['get','color'], 'circle-opacity': 1.0 } },
    ],
    render: [
      { source: 'satellites', toFeatures: (data, active) => (active.satellites && data.satellites) ? data.satellites.map((s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { name: s.name, color: s.color, mission: s.mission, alt: s.alt, noradId: s.noradId } })) : [] },
    ],
  },
  // ── SURVEIL ──
  {
    // Headless: cameras are toggled per-continent from the Surveillance panel, not the rail.
    // The continent feeds fill cameras_<continent> buckets; this single source unions them.
    id: 'cctv', label: 'CCTV Cameras', group: 'SURVEIL', icon: 'Camera', color: '#7E57C2', headless: true,
    countBuckets: ['cameras_europe', 'cameras_north_america', 'cameras_asia', 'cameras_oceania'],
    styleLayers: [
      { id: 'cctv-glow', source: 'cctv', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,14, 14,20], 'circle-color': '#000000', 'circle-opacity': 0.35, 'circle-blur': 1 } },
      { id: 'cctv-dots', source: 'cctv', type: 'circle', paint: (t) => ({ 'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8, 14,12], 'circle-color': cameraColor(t), 'circle-opacity': 0.9, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.9 }) },
      { id: 'cctv-label', source: 'cctv', type: 'symbol', minzoom: 10, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false }, paint: (t) => ({ 'text-color': cameraColor(t), 'text-halo-color': '#000000', 'text-halo-width': 1.5, 'text-opacity': 0.8 }) },
    ],
    render: [
      { source: 'cctv', toFeatures: (data, active) => {
        const out: any[] = [];
        for (const [key, bucket] of CCTV_CONTINENTS) {
          if (active[key] && Array.isArray(data[bucket])) {
            for (const c of data[bucket]) out.push(cctvFeature(c));
          }
        }
        return out;
      } },
    ],
  },
  {
    id: 'police', label: 'Police Stations', group: 'SURVEIL', icon: 'Shield', color: '#42A5F5', countBuckets: ['police'], headless: true,
    styleLayers: osmPointStyle('police', 'police', '#42A5F5'),
    render: [
      { source: 'police', toFeatures: (data, active) => (active.police && data.police) ? data.police.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, operator: c.operator, source: c.source, osm_url: c.osm_url } })) : [] },
    ],
  },
  {
    id: 'flock', label: 'Flock / ALPR', group: 'SURVEIL', icon: 'Camera', color: '#FF7043', countBuckets: ['flock'], headless: true,
    styleLayers: osmPointStyle('flock', 'flock', '#FF7043'),
    render: [
      { source: 'flock', toFeatures: (data, active) => (active.flock && data.flock) ? data.flock.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, operator: c.operator, surveillance_type: c.surveillance_type, direction: c.direction, source: c.source, osm_url: c.osm_url } })) : [] },
    ],
  },
  {
    id: 'mass_surveil', label: 'Mass Surveillance', group: 'SURVEIL', icon: 'Eye', color: '#EF5350', countBuckets: ['mass_surveil'], headless: true,
    styleLayers: osmPointStyle('mass', 'mass-surveil', '#EF5350'),
    render: [
      { source: 'mass-surveil', toFeatures: (data, active) => (active.mass_surveil && data.mass_surveil) ? data.mass_surveil.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, operator: c.operator, surveillance_type: c.surveillance_type, zone: c.zone, source: c.source, osm_url: c.osm_url } })) : [] },
    ],
  },
  {
    id: 'surveillance', label: 'Surveillance (OSM)', group: 'SURVEIL', icon: 'Eye', color: '#FFAB00', countBuckets: ['surveillance'],
    styleLayers: [
      { id: 'surv-glow', source: 'surveillance', type: 'circle', paint: (t) => ({ 'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 8,7, 12,11, 16,16], 'circle-color': surveillanceColor(t), 'circle-opacity': 0.18, 'circle-blur': 1 }) },
      { id: 'surv-dots', source: 'surveillance', type: 'circle', paint: (t) => ({ 'circle-radius': ['interpolate',['linear'],['zoom'], 1,2, 8,3.5, 12,6, 16,9], 'circle-color': surveillanceColor(t), 'circle-opacity': 0.85, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.8 }) },
      { id: 'surv-label', source: 'surveillance', type: 'symbol', minzoom: 14, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.4], 'text-max-width': 12, 'text-allow-overlap': false }, paint: (t) => ({ 'text-color': surveillanceColor(t), 'text-halo-color': '#000000', 'text-halo-width': 1.5, 'text-opacity': 0.75 }) },
    ],
    render: [
      { source: 'surveillance', toFeatures: (data, active) => (active.surveillance && data.surveillance) ? data.surveillance.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, country: c.country, source: c.source, surveillance_type: c.surveillance_type, camera_type: c.camera_type, zone: c.zone, operator: c.operator, osm_url: c.osm_url } })) : [] },
    ],
  },
  {
    id: 'live_news', label: 'Live News Feeds', group: 'SURVEIL', icon: 'Tv', color: '#EC407A', countBuckets: ['live_feeds'],
    styleLayers: [
      { id: 'news-glow', source: 'live-news', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,8, 5,14, 10,22], 'circle-color': '#EC407A', 'circle-opacity': 0.08, 'circle-blur': 1 } },
      { id: 'news-dots', source: 'live-news', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,10], 'circle-color': '#EC407A', 'circle-opacity': 0.8, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#EC407A', 'circle-stroke-opacity': 0.4 } },
      { id: 'news-label', source: 'live-news', type: 'symbol', minzoom: 4, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false }, paint: { 'text-color': '#EC407A', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.8 } },
    ],
    render: [
      { source: 'live-news', toFeatures: (data, active) => (active.live_news && data.live_feeds) ? data.live_feeds.map((f: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { name: f.name, city: f.city, country: f.country, url: f.url, category: f.category, embed_allowed: f.embed_allowed !== false } })) : [] },
    ],
  },
  // ── HAZARD ──
  {
    id: 'earthquakes', label: 'Earthquakes (24h)', group: 'HAZARD', icon: 'Activity', color: '#F9A825', countBuckets: ['earthquakes'],
    styleLayers: [
      {
        id: 'eq-circles', source: 'earthquakes', type: 'circle', paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'magnitude'], 2.5, 4, 5, 12, 7, 24],
          'circle-color': ['interpolate', ['linear'], ['get', 'magnitude'], 2.5, '#F9A825', 4, '#E65100', 6, '#D32F2F'],
          'circle-opacity': 0.55, 'circle-blur': 0.3, 'circle-stroke-width': 1, 'circle-stroke-color': '#F9A825', 'circle-stroke-opacity': 0.25,
        },
      },
      {
        id: 'eq-label', source: 'earthquakes', type: 'symbol', filter: ['>=', ['get', 'magnitude'], 4.5],
        layout: { 'text-field': ['concat', 'M', ['to-string', ['get', 'magnitude']]], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.5] },
        paint: { 'text-color': '#F9A825', 'text-halo-color': '#000', 'text-halo-width': 1 },
      },
    ],
    render: [
      {
        source: 'earthquakes',
        toFeatures: (data, active) => (active.earthquakes && data.earthquakes)
          ? data.earthquakes.map((eq: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [eq.lng, eq.lat] }, properties: { magnitude: eq.magnitude, place: eq.place } }))
          : [],
      },
    ],
  },
  {
    id: 'fires', label: 'Active Fires', group: 'HAZARD', icon: 'Flame', color: '#E65100', countBuckets: ['fires'],
    styleLayers: [
      { id: 'fires-heat', source: 'fires', type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2, 5, 4, 10, 8], 'circle-color': '#E65100', 'circle-opacity': 0.45, 'circle-blur': 0.5 } },
    ],
    render: [
      { source: 'fires', toFeatures: (data, active) => (active.fires && data.fires) ? data.fires.map((f: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [f.lng, f.lat] }, properties: { brightness: f.brightness } })) : [] },
    ],
  },
  {
    id: 'weather', label: 'Severe Weather', group: 'HAZARD', icon: 'CloudLightning', color: '#7E57C2', countBuckets: ['weather_events'],
    styleLayers: [
      { id: 'weather-glow', source: 'weather', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,12, 5,20, 10,30], 'circle-color': '#7E57C2', 'circle-opacity': 0.08, 'circle-blur': 1 } },
      { id: 'weather-dots', source: 'weather', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,14], 'circle-color': ['match', ['get','icon'], 'cyclone','#7E57C2', 'volcano','#D32F2F', '#7E57C2'], 'circle-opacity': 0.75, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#7E57C2', 'circle-stroke-opacity': 0.35 } },
      { id: 'weather-label', source: 'weather', type: 'symbol', layout: { 'text-field': ['get','title'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false }, paint: { 'text-color': '#7E57C2', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.8 } },
    ],
    render: [
      { source: 'weather', toFeatures: (data, active) => (active.weather && data.weather_events) ? data.weather_events.map((w: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [w.lng, w.lat] }, properties: { title: w.title, type: w.type, icon: w.icon, severity: w.severity, source: w.source, id: w.id } })) : [] },
    ],
  },
  // ── THREAT ──
  {
    id: 'infrastructure', label: 'Nuclear Facilities', group: 'THREAT', icon: 'Radiation', color: '#26A69A', countBuckets: ['infrastructure'],
    styleLayers: [
      { id: 'infra-glow', source: 'infrastructure', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,8, 5,14, 10,22], 'circle-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#E65100', '#26A69A'], 'circle-opacity': 0.08, 'circle-blur': 1 } },
      { id: 'infra-dots', source: 'infrastructure', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,10], 'circle-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#E65100', ['==', ['get','status'], 'Active Conflict Zone'], '#D32F2F', ['==', ['get','status'], 'Destroyed / Decommissioning'], '#546E7A', '#26A69A'], 'circle-opacity': 0.75, 'circle-stroke-width': 1.5, 'circle-stroke-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#E65100', '#26A69A'], 'circle-stroke-opacity': 0.35 } },
      { id: 'infra-label', source: 'infrastructure', type: 'symbol', minzoom: 5, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false }, paint: { 'text-color': ['case', ['in', 'SEISMIC RISK', ['get', 'status']], '#E65100', '#26A69A'], 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.7 } },
    ],
    render: [
      { source: 'infrastructure', toFeatures: (data, active) => (active.infrastructure && data.infrastructure) ? data.infrastructure.map((i: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lng, i.lat] }, properties: { name: i.name, city: i.city, country: i.country, status: i.status, reactors: i.reactors, capacityMW: i.capacityMW, owner: i.owner } })) : [] },
    ],
  },
  {
    id: 'global_incidents', label: 'Global Incidents', group: 'THREAT', icon: 'AlertTriangle', color: '#D32F2F', countBuckets: ['gdelt'],
    styleLayers: [
      { id: 'gdelt-dots', source: 'gdelt', type: 'circle', paint: { 'circle-radius': 4, 'circle-color': '#D32F2F', 'circle-opacity': 0.5, 'circle-stroke-width': 1, 'circle-stroke-color': '#D32F2F', 'circle-stroke-opacity': 0.25 } },
    ],
    render: [
      { source: 'gdelt', toFeatures: (data, active) => (active.global_incidents && data.gdelt) ? data.gdelt.map((e: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lng, e.lat] }, properties: { name: e.name } })) : [] },
    ],
  },
  {
    id: 'gps_jamming', label: 'GPS Jamming', group: 'THREAT', icon: 'Radio', color: '#D32F2F', countBuckets: ['gps_jamming'],
    styleLayers: [
      { id: 'jam-fill', source: 'gps-jamming', type: 'circle', paint: { 'circle-radius': 30, 'circle-color': '#D32F2F', 'circle-opacity': 0.12, 'circle-blur': 1 } },
      { id: 'jam-label', source: 'gps-jamming', type: 'symbol', layout: { 'text-field': ['concat', 'GPS JAM ', ['to-string', ['get', 'severity']], '%'], 'text-size': 10, 'text-font': ['Open Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#D32F2F', 'text-halo-color': '#000', 'text-halo-width': 1 } },
    ],
    render: [
      { source: 'gps-jamming', toFeatures: (data, active) => (active.gps_jamming && data.gps_jamming) ? data.gps_jamming.map((z: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [z.lng, z.lat] }, properties: { severity: z.severity } })) : [] },
    ],
  },
  // ── NETWORK ──
  {
    id: 'malware', label: 'Live Malware', group: 'NETWORK', icon: 'AlertTriangle', color: '#D32F2F', countBuckets: ['malware_threats'],
    // Includes the computed network-mesh (nearest-neighbour botnet lattice derived from the nodes).
    // network-mesh-* style layers come AFTER the malware-* ones to preserve the original z-order.
    styleLayers: [
      { id: 'malware-glow', source: 'malware-nodes', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,12, 10,20], 'circle-color': '#D32F2F', 'circle-opacity': 0.06, 'circle-blur': 0.5 } },
      { id: 'malware-dots', source: 'malware-nodes', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,2, 5,4, 10,6], 'circle-color': '#D32F2F', 'circle-opacity': 0.9, 'circle-stroke-width': 1, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.8 } },
      { id: 'malware-label', source: 'malware-nodes', type: 'symbol', minzoom: 5, layout: { 'text-field': ['get','malware'], 'text-size': 8, 'text-font': ['JetBrains Mono Bold', 'Open Sans Bold'], 'text-offset': [0, 1.5], 'text-max-width': 10, 'text-allow-overlap': false }, paint: { 'text-color': '#D32F2F', 'text-halo-color': '#111', 'text-halo-width': 1.5, 'text-opacity': 0.85 } },
      { id: 'network-mesh-atmo', source: 'network-mesh', type: 'line', paint: { 'line-width': ['interpolate',['linear'],['zoom'], 1, 2, 5, 4, 10, 8], 'line-opacity': 0.08, 'line-blur': 4 } },
      { id: 'network-mesh-glow', source: 'network-mesh', type: 'line', paint: { 'line-width': ['interpolate',['linear'],['zoom'], 1, 1, 5, 2, 10, 4], 'line-opacity': 0.2, 'line-blur': 1.5 } },
      { id: 'network-mesh-core', source: 'network-mesh', type: 'line', paint: { 'line-width': ['interpolate',['linear'],['zoom'], 1, 0.2, 5, 0.5, 10, 1.5], 'line-opacity': 0.4 } },
    ],
    render: [
      { source: 'malware-nodes', toFeatures: (data, active) => (active.malware && data.malware_threats) ? data.malware_threats.map((t: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { ip: t.ip, malware: t.malware, status: t.status, threat_type: t.threat_type, country: t.country } })) : [] },
      {
        source: 'network-mesh',
        toFeatures: (data, active) => {
          const meshLinks: any[] = [];
          if (active.malware && data.malware_threats && data.malware_threats.length > 1) {
            const nodes = data.malware_threats.slice(0, MAX_MESH_NODES);
            for (let i = 0; i < nodes.length; i++) {
              // Connect each to next 2 for a global web
              for (let j = 1; j <= 2; j++) {
                const target = nodes[(i + j) % nodes.length];
                meshLinks.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[nodes[i].lng, nodes[i].lat], [target.lng, target.lat]] }, properties: { threat_type: 'malware' } });
              }
            }
          }
          return meshLinks;
        },
      },
    ],
  },
  // ── DISPLAY ──
  {
    id: 'day_night', label: 'Day / Night Cycle', group: 'DISPLAY', icon: 'Sun', color: '#448AFF', countBuckets: [],
    // day-night-fill is theme-static (recolored live by OsirisMap's setPaint effect); the
    // terminator polygon is recomputed by OsirisMap's 5-min interval re-invoking the binding.
    styleLayers: [
      { id: 'day-night-fill', source: 'day-night', type: 'fill', paint: (t) => ({ 'fill-color': t === 'ghost' ? '#0D0030' : '#000022', 'fill-opacity': 0.35 }) },
    ],
    render: [
      { source: 'day-night', toFeatures: (_data, active) => active.day_night ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [computeSolarTerminator()] }, properties: {} }] : [] },
    ],
  },

  // ── HEADLESS (no sidebar toggle; registered + rendered by the map engine) ──
  {
    id: 'conflict_zones', label: 'Conflict Zones', group: 'THREAT', icon: 'AlertTriangle', color: '#D32F2F', headless: true,
    // Always-on: binding ignores `active`. Uses warn-icon* images created in OsirisMap init.
    styleLayers: [
      {
        id: 'conflict-icons', source: 'conflict-zones', type: 'symbol',
        layout: { 'icon-image': ['match', ['get','severity'], 'war','warn-icon', 'high','warn-orange', 'warn-yellow'], 'icon-size': ['interpolate',['linear'],['zoom'], 1,0.6, 4,0.8, 8,1], 'icon-allow-overlap': true, 'text-field': ['get','label'], 'text-size': ['interpolate',['linear'],['zoom'], 1,7, 4,9, 8,11], 'text-font': ['Open Sans Bold'], 'text-offset': [0, 1.4], 'text-allow-overlap': false },
        paint: { 'text-color': ['match', ['get','severity'], 'war','#D32F2F', 'high','#E65100', '#F9A825'], 'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9 },
      },
    ],
    render: [
      { source: 'conflict-zones', toFeatures: () => CONFLICT_ZONES.map((z) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [z.lng, z.lat] }, properties: { label: z.label, severity: z.severity, description: z.description, sourceUrl: z.sourceUrl } })) },
    ],
  },
  {
    id: 'news_intel', label: 'SIGINT News', group: 'SURVEIL', icon: 'Rss', color: '#D4AF37', headless: true,
    // Toggled by the default-on `news_intel` flag in page.tsx (no sidebar control yet).
    styleLayers: [
      { id: 'sigint-news-glow', source: 'sigint-news', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,10, 10,18], 'circle-color': '#D4AF37', 'circle-opacity': 0.12, 'circle-blur': 1 } },
      { id: 'sigint-news-dots', source: 'sigint-news', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8], 'circle-color': '#D4AF37', 'circle-opacity': 0.9, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFF8DC', 'circle-stroke-opacity': 0.6 } },
      { id: 'sigint-news-label', source: 'sigint-news', type: 'symbol', minzoom: 5, layout: { 'text-field': ['get','source'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.6], 'text-max-width': 10, 'text-allow-overlap': false }, paint: { 'text-color': '#D4AF37', 'text-halo-color': '#000', 'text-halo-width': 1, 'text-opacity': 0.85 } },
    ],
    render: [
      {
        source: 'sigint-news',
        toFeatures: (data, active) => {
          const items = data.news || [];
          return (active.news_intel && items.length > 0)
            // Upstream news coords are [lat, lng]; GeoJSON expects [lng, lat].
            ? items
                .filter((n: any) => Array.isArray(n.coords) && n.coords.length === 2 && n.coords.every((c: any) => Number.isFinite(c)))
                .map((n: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [n.coords[1], n.coords[0]] }, properties: { title: n.title, source: n.source, risk_score: n.risk_score, link: n.link } }))
            : [];
        },
      },
    ],
  },
  {
    id: 'ip_sweep', label: 'IP Sweep', group: 'NETWORK', icon: 'Radar', color: '#FF3D3D', headless: true,
    // Style only — features pushed imperatively (batched reveal animation) by OsirisMap.
    styleLayers: [
      { id: 'sweep-connections', source: 'ip-sweep-connections', type: 'line', paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.3, 'line-dasharray': [2, 4] } },
      { id: 'sweep-pulse-ring', source: 'ip-sweep-pulse', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 8,40, 12,80, 16,160], 'circle-color': 'transparent', 'circle-opacity': 0.6, 'circle-stroke-width': 2, 'circle-stroke-color': '#FF3D3D', 'circle-stroke-opacity': 0.4 } },
      { id: 'sweep-device-glow', source: 'ip-sweep-devices', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 8,8, 12,16, 16,30], 'circle-color': ['get', 'color'], 'circle-opacity': 0.15, 'circle-blur': 1 } },
      { id: 'sweep-device-dots', source: 'ip-sweep-devices', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 8,3, 12,6, 16,10], 'circle-color': ['get', 'color'], 'circle-opacity': 0.95, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-opacity': 0.6 } },
      { id: 'sweep-device-labels', source: 'ip-sweep-devices', type: 'symbol', minzoom: 13, layout: { 'text-field': ['concat', ['get', 'device_type'], '\n', ['get', 'ip']], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 2.2], 'text-max-width': 12, 'text-allow-overlap': false }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9 } },
    ],
  },
  {
    id: 'scan_targets', label: 'Scan Targets', group: 'NETWORK', icon: 'Crosshair', color: '#D32F2F', headless: true,
    // Style only — features pushed imperatively by OsirisMap.
    styleLayers: [
      { id: 'scan-targets-glow', source: 'scan-targets', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,12, 5,25, 10,40], 'circle-color': '#D32F2F', 'circle-opacity': 0.15, 'circle-blur': 1 } },
      { id: 'scan-targets-dots', source: 'scan-targets', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,12], 'circle-color': '#D32F2F', 'circle-opacity': 0.9, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ECEFF1', 'circle-stroke-opacity': 0.7 } },
      { id: 'scan-targets-label', source: 'scan-targets', type: 'symbol', layout: { 'text-field': ['get', 'id'], 'text-size': 11, 'text-font': ['Open Sans Bold'], 'text-offset': [0, 2], 'text-max-width': 14, 'text-allow-overlap': false }, paint: { 'text-color': '#D32F2F', 'text-halo-color': '#000', 'text-halo-width': 1.5, 'text-opacity': 0.9 } },
    ],
  },
  {
    // Address-intel overlay — pin, radius ring, nearby surveillance, and sightlines from each
    // device to the pin. Style only; features pushed imperatively by OsirisMap from the dossier.
    id: 'dossier', label: 'Dossier Overlay', group: 'SURVEIL', icon: 'MapPin', color: '#D4AF37', headless: true,
    styleLayers: [
      { id: 'dossier-radius-fill', source: 'dossier-radius', type: 'fill', paint: { 'fill-color': '#00E676', 'fill-opacity': 0.05 } },
      { id: 'dossier-radius-line', source: 'dossier-radius', type: 'line', paint: { 'line-color': '#00E676', 'line-width': 1.5, 'line-opacity': 0.5, 'line-dasharray': [2, 2] } },
      { id: 'dossier-sightlines', source: 'dossier-sightlines', type: 'line', paint: { 'line-color': ['match', ['get', 'kind'], 'alpr', '#FF7043', 'speed', '#FFD54F', '#00E676'], 'line-width': 1, 'line-opacity': 0.3 } },
      { id: 'dossier-nearby-glow', source: 'dossier-nearby', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,5, 16,12], 'circle-color': ['match', ['get', 'kind'], 'alpr', '#FF7043', 'speed', '#FFD54F', 'police', '#42A5F5', '#00E676'], 'circle-opacity': 0.18, 'circle-blur': 1 } },
      { id: 'dossier-nearby-dots', source: 'dossier-nearby', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,3, 16,7], 'circle-color': ['match', ['get', 'kind'], 'alpr', '#FF7043', 'speed', '#FFD54F', 'police', '#42A5F5', '#00E676'], 'circle-opacity': 0.9, 'circle-stroke-width': 1, 'circle-stroke-color': '#000', 'circle-stroke-opacity': 0.7 } },
      { id: 'dossier-pin-glow', source: 'dossier-pin', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,10, 16,24], 'circle-color': '#D4AF37', 'circle-opacity': 0.2, 'circle-blur': 1 } },
      { id: 'dossier-pin-dot', source: 'dossier-pin', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,5, 16,9], 'circle-color': '#D4AF37', 'circle-opacity': 1, 'circle-stroke-width': 2, 'circle-stroke-color': '#000', 'circle-stroke-opacity': 0.8 } },
    ],
  },
  {
    // Live user position (GPS). Style only; features pushed imperatively by OsirisMap from
    // LocationTracker. Cyan to distinguish from the gold dossier pin.
    id: 'user_position', label: 'My Location', group: 'SURVEIL', icon: 'Navigation', color: '#00E5FF', headless: true,
    styleLayers: [
      { id: 'user-accuracy-fill', source: 'user-accuracy', type: 'fill', paint: { 'fill-color': '#00E5FF', 'fill-opacity': 0.08 } },
      { id: 'user-accuracy-line', source: 'user-accuracy', type: 'line', paint: { 'line-color': '#00E5FF', 'line-width': 1, 'line-opacity': 0.4 } },
      { id: 'user-pos-glow', source: 'user-position', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 3,8, 16,18], 'circle-color': '#00E5FF', 'circle-opacity': 0.25, 'circle-blur': 1 } },
      { id: 'user-pos-dot', source: 'user-position', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 3,4, 16,8], 'circle-color': '#00E5FF', 'circle-opacity': 1, 'circle-stroke-width': 2, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-opacity': 0.9 } },
    ],
  },
  {
    // Route-exposure overlay — the route line, its surveillance corridor (buffer fill), and the
    // cameras/ALPR/police within it. Style only; features pushed imperatively by OsirisMap from
    // the route dossier. Cyan route line distinguishes it from the gold address dossier.
    id: 'route', label: 'Route Exposure', group: 'SURVEIL', icon: 'Navigation', color: '#00E5FF', headless: true,
    styleLayers: [
      { id: 'route-corridor-fill', source: 'route-corridor', type: 'fill', paint: { 'fill-color': '#00E5FF', 'fill-opacity': 0.06 } },
      { id: 'route-corridor-line', source: 'route-corridor', type: 'line', paint: { 'line-color': '#00E5FF', 'line-width': 1, 'line-opacity': 0.25 } },
      { id: 'route-line-glow', source: 'route-line', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00E5FF', 'line-width': ['interpolate',['linear'],['zoom'], 8,4, 16,12], 'line-opacity': 0.25, 'line-blur': 3 } },
      { id: 'route-line-core', source: 'route-line', type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00E5FF', 'line-width': ['interpolate',['linear'],['zoom'], 8,1.5, 16,4], 'line-opacity': 0.9 } },
      { id: 'route-surveil-glow', source: 'route-surveil', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,5, 16,12], 'circle-color': ['match', ['get', 'kind'], 'alpr', '#FF7043', 'speed', '#FFD54F', 'police', '#42A5F5', '#00E676'], 'circle-opacity': 0.18, 'circle-blur': 1 } },
      { id: 'route-surveil-dots', source: 'route-surveil', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 10,3, 16,7], 'circle-color': ['match', ['get', 'kind'], 'alpr', '#FF7043', 'speed', '#FFD54F', 'police', '#42A5F5', '#00E676'], 'circle-opacity': 0.9, 'circle-stroke-width': 1, 'circle-stroke-color': '#000', 'circle-stroke-opacity': 0.7 } },
    ],
  },
];
