import type { RegistryGroup, RegistryLayer, ThemeMode } from './types';

// Theme-dependent flight accents (ghost mode recolors commercial/private/jets).
const PHANTOM_PURPLE = '#B388FF';
const GHOST_PRIV = '#CE93D8';
const GHOST_GOV = '#D500F9';
const flightCom = (t: ThemeMode) => (t === 'ghost' ? PHANTOM_PURPLE : '#00E5FF');
const flightPriv = (t: ThemeMode) => (t === 'ghost' ? GHOST_PRIV : '#FFD700');
const flightGov = (t: ThemeMode) => (t === 'ghost' ? GHOST_GOV : '#FF9500');

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
  { id: 'sdk_sea', label: 'Maritime Lines', group: 'SDK', icon: 'Anchor', color: '#4FC3F7', countBuckets: ['sdk_entities'] },
  { id: 'sdk_ransomware', label: 'Ransomware Feed', group: 'SDK', icon: 'AlertTriangle', color: '#D32F2F', countBuckets: ['sdk_entities'], comingSoon: true },
  // ── AVIATION ──
  { id: 'flights', label: 'Commercial', group: 'AVIATION', icon: 'Plane', color: flightCom, countBuckets: ['commercial_flights'] },
  { id: 'private', label: 'Private', group: 'AVIATION', icon: 'Plane', color: flightPriv, countBuckets: ['private_flights'] },
  { id: 'jets', label: 'Private Jets', group: 'AVIATION', icon: 'Plane', color: flightGov, countBuckets: ['private_jets'] },
  { id: 'military', label: 'Military', group: 'AVIATION', icon: 'Shield', color: '#FF0000', countBuckets: ['military_flights'] },
  // ── MARITIME ──
  { id: 'maritime', label: 'Maritime / Naval', group: 'MARITIME', icon: 'Ship', color: '#26C6DA', countBuckets: ['maritime_ships', 'maritime_ports', 'maritime_chokepoints'] },
  { id: 'satellites', label: 'Satellites', group: 'MARITIME', icon: 'Satellite', color: '#D4AF37', countBuckets: ['satellites'] },
  // ── SURVEIL ──
  { id: 'cctv', label: 'CCTV Cameras', group: 'SURVEIL', icon: 'Camera', color: '#7E57C2', countBuckets: ['cameras'] },
  { id: 'surveillance', label: 'Surveillance (OSM)', group: 'SURVEIL', icon: 'Eye', color: '#FFAB00', countBuckets: ['surveillance'] },
  { id: 'live_news', label: 'Live News Feeds', group: 'SURVEIL', icon: 'Tv', color: '#EC407A', countBuckets: ['live_feeds'] },
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
  { id: 'weather', label: 'Severe Weather', group: 'HAZARD', icon: 'CloudLightning', color: '#7E57C2', countBuckets: ['weather_events'] },
  // ── THREAT ──
  { id: 'infrastructure', label: 'Nuclear Facilities', group: 'THREAT', icon: 'Radiation', color: '#26A69A', countBuckets: ['infrastructure'] },
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
  { id: 'malware', label: 'Live Malware', group: 'NETWORK', icon: 'AlertTriangle', color: '#D32F2F', countBuckets: ['malware_threats'] },
  // ── DISPLAY ──
  { id: 'day_night', label: 'Day / Night Cycle', group: 'DISPLAY', icon: 'Sun', color: '#448AFF', countBuckets: [] },
];
