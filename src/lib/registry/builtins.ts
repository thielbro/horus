import type { RegistryGroup, RegistryLayer, ThemeMode } from './types';

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
  { id: 'sdk_sea', label: 'Maritime Lines', group: 'SDK', icon: 'Anchor', color: '#4FC3F7', countBuckets: ['sdk_entities'] },
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
      { source: 'maritime-ships', toFeatures: (data, active) => (active.maritime && data.maritime_ships) ? data.maritime_ships.map((s: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { name: s.name || s.mmsi?.toString(), type: s.type || 'cargo', speed: s.speed, heading: s.heading, destination: s.destination, flag: s.flag, mmsi: s.mmsi, imo: s.imo } })) : [] },
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
    id: 'cctv', label: 'CCTV Cameras', group: 'SURVEIL', icon: 'Camera', color: '#7E57C2', countBuckets: ['cameras'],
    styleLayers: [
      { id: 'cctv-glow', source: 'cctv', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,5, 5,8, 10,14, 14,20], 'circle-color': '#000000', 'circle-opacity': 0.35, 'circle-blur': 1 } },
      { id: 'cctv-dots', source: 'cctv', type: 'circle', paint: (t) => ({ 'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,8, 14,12], 'circle-color': cameraColor(t), 'circle-opacity': 0.9, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.9 }) },
      { id: 'cctv-label', source: 'cctv', type: 'symbol', minzoom: 10, layout: { 'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'], 'text-offset': [0, 1.8], 'text-max-width': 12, 'text-allow-overlap': false }, paint: (t) => ({ 'text-color': cameraColor(t), 'text-halo-color': '#000000', 'text-halo-width': 1.5, 'text-opacity': 0.8 }) },
    ],
    render: [
      { source: 'cctv', toFeatures: (data, active) => (active.cctv && data.cameras) ? data.cameras.map((c: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { id: c.id, name: c.name, city: c.city, country: c.country, source: c.source, feed_url: c.feed_url, stream_url: c.stream_url, stream_type: c.stream_type, external_url: c.external_url } })) : [] },
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
    // The computed network-mesh effect (derived from malware nodes) stays raw — deferred to Step 4z.
    styleLayers: [
      { id: 'malware-glow', source: 'malware-nodes', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,6, 5,12, 10,20], 'circle-color': '#D32F2F', 'circle-opacity': 0.06, 'circle-blur': 0.5 } },
      { id: 'malware-dots', source: 'malware-nodes', type: 'circle', paint: { 'circle-radius': ['interpolate',['linear'],['zoom'], 1,2, 5,4, 10,6], 'circle-color': '#D32F2F', 'circle-opacity': 0.9, 'circle-stroke-width': 1, 'circle-stroke-color': '#000000', 'circle-stroke-opacity': 0.8 } },
      { id: 'malware-label', source: 'malware-nodes', type: 'symbol', minzoom: 5, layout: { 'text-field': ['get','malware'], 'text-size': 8, 'text-font': ['JetBrains Mono Bold', 'Open Sans Bold'], 'text-offset': [0, 1.5], 'text-max-width': 10, 'text-allow-overlap': false }, paint: { 'text-color': '#D32F2F', 'text-halo-color': '#111', 'text-halo-width': 1.5, 'text-opacity': 0.85 } },
    ],
    render: [
      { source: 'malware-nodes', toFeatures: (data, active) => (active.malware && data.malware_threats) ? data.malware_threats.map((t: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lng, t.lat] }, properties: { ip: t.ip, malware: t.malware, status: t.status, threat_type: t.threat_type, country: t.country } })) : [] },
    ],
  },
  // ── DISPLAY ──
  { id: 'day_night', label: 'Day / Night Cycle', group: 'DISPLAY', icon: 'Sun', color: '#448AFF', countBuckets: [] },
];
