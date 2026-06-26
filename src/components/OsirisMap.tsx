'use client';

import { useEffect, useRef, useState, useCallback, memo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  addRegistryLayer,
  renderRegistryLayer,
  getLayers,
  useRegistryVersion,
  updateRegistryLayerTheme,
  getRenderBindingSource,
  getStyleLayerSource,
} from '@/lib/registry';
import { setHostServices, getHost } from '@/lib/plugins';
import { circlePolygon } from '@/lib/geo';

interface OsirisMapProps {
  data: any;
  activeLayers: Record<string, boolean>;
  onEntityClick?: (entity: any) => void;
  onMouseCoords?: (coords: { lat: number; lng: number }) => void;
  onRightClick?: (coords: { lat: number; lng: number }) => void;
  onViewStateChange?: (vs: { zoom: number; latitude: number; longitude: number }) => void;
  flyToLocation?: { lat: number; lng: number; ts: number; zoom?: number } | null;
  projection?: 'mercator' | 'globe';
  mapStyle?: string;
  sweepData?: any;
  scanTargets?: any[];
  dossierOverlay?: {
    center: { lat: number; lng: number } | null;
    radiusM: number;
    nearby: Array<{ lat: number; lng: number; kind: string; name: string; distanceM: number; osmUrl?: string }>;
  } | null;
  userPosition?: { lat: number; lng: number; accuracy?: number } | null;
  routeOverlay?: {
    line: Array<[number, number]>;
    corridor: Array<[number, number]> | null;
    surveil: Array<{ lat: number; lng: number; kind: string; name: string; distanceM: number; osmUrl?: string }>;
  } | null;
  demoMode?: boolean;
  theme?: 'core' | 'ghost';
}

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };
const DOSSIER_KIND_COLOR: Record<string, string> = {
  alpr: '#FF7043',
  police: '#42A5F5',
  speed: '#FFD54F',
  camera: '#00E676',
};
const DOSSIER_KIND_RGB: Record<string, string> = {
  alpr: '255,112,67',
  police: '66,165,245',
  speed: '255,213,79',
  camera: '0,230,118',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function OsirisMap({ data, activeLayers, onEntityClick, onMouseCoords, onRightClick, onViewStateChange, flyToLocation, projection = 'globe', mapStyle = 'dark', sweepData, scanTargets = [], dossierOverlay = null, userPosition = null, routeOverlay = null, demoMode = false, theme = 'core' }: OsirisMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const onEntityClickRef = useRef(onEntityClick);
  const themeRef = useRef(theme);
  const dossierOverlayFrameRef = useRef<number | null>(null);
  const geoBatchUpdatesRef = useRef<Record<string, any[]>>({});
  const [mapReady, setMapReady] = useState(false);
  const prevStyleRef = useRef(mapStyle);

  useEffect(() => { onEntityClickRef.current = onEntityClick; }, [onEntityClick]);
  useEffect(() => { themeRef.current = theme; }, [theme]);

  // Create aircraft icon on canvas (for WebGL symbol layer)
  const createIcon = useCallback((map: maplibregl.Map, id: string, color: string, size: number) => {
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cx = size / 2, cy = size / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size * 0.4);
    ctx.lineTo(cx - size * 0.12, cy + size * 0.1);
    ctx.lineTo(cx - size * 0.4, cy + size * 0.2);
    ctx.lineTo(cx - size * 0.4, cy + size * 0.3);
    ctx.lineTo(cx - size * 0.12, cy + size * 0.15);
    ctx.lineTo(cx, cy + size * 0.35);
    ctx.lineTo(cx + size * 0.12, cy + size * 0.15);
    ctx.lineTo(cx + size * 0.4, cy + size * 0.3);
    ctx.lineTo(cx + size * 0.4, cy + size * 0.2);
    ctx.lineTo(cx + size * 0.12, cy + size * 0.1);
    ctx.closePath();
    ctx.fill();
    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  const createDot = useCallback((map: maplibregl.Map, id: string, color: string, size: number) => {
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 1, 0, Math.PI * 2);
    ctx.fill();
    map.addImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    // ── DEMO MODE SPINNING ──
    let spinReq: number | undefined = undefined;
    let isSpinning = false;
    
    const startSpinning = () => {
      if (!map) return;
      isSpinning = true;
      let lastTime = performance.now();
      
      const frame = (time: number) => {
        if (!isSpinning) return;
        
        // Only spin if the user is not actively dragging or zooming the map
        if (!map.isMoving() && !map.isZooming()) {
          const dt = time - lastTime;
          const center = map.getCenter();
          // Adjust spin speed: 0.5 degrees per second
          center.lng += (0.5 * dt) / 1000;
          map.setCenter(center);
        }
        
        lastTime = time;
        spinReq = requestAnimationFrame(frame);
      };
      
      spinReq = requestAnimationFrame(frame);
    };

    if (demoMode) {
      startSpinning();
    } else {
      isSpinning = false;
      if (spinReq) cancelAnimationFrame(spinReq);
    }

    return () => {
      isSpinning = false;
      if (spinReq) cancelAnimationFrame(spinReq);
      if (typeof window !== 'undefined' && (window as any)._globeSpinTimer) {
        clearInterval((window as any)._globeSpinTimer);
      }
    };
  }, [mapReady, demoMode]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let isMounted = true;

    // Select basemap style
    const styleUrl = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl,
        center: [25.48, 42.70], zoom: 6.5, minZoom: 1.5, maxZoom: 18,
        attributionControl: false,
        maxPitch: 85,
        transformRequest: (url: string) => {
          // Route all CARTO CDN requests through the internal Next.js proxy API
          if (url.includes('cartocdn.com')) {
            const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
            return { url: `${baseUrl}/api/proxy-tiles?url=${encodeURIComponent(url)}` };
          }
          return { url };
        },
      });
    } catch (error) {
      console.error('[OSIRIS] Map init failed:', error);
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(containerRef.current);

    map.on('load', () => {
      if (!isMounted) return;
      try {
      mapRef.current = map;
      
      // Theme colors
      const isGhost = theme === 'ghost';
      const themeMode = isGhost ? 'ghost' : 'core';
      const phantomPurple = '#B388FF';
      const phantomDark = '#1A0040';
      const cameraColor = isGhost ? '#B388FF' : '#00E676';
      const flightCom = isGhost ? phantomPurple : '#00E5FF';
      const flightPriv = isGhost ? phantomPurple : '#FFD700';
      const flightGov = isGhost ? phantomPurple : '#FF9500';
      const flightMil = isGhost ? phantomPurple : '#FF3D3D';

      // Create icons — OSIRIS Unified Palette
      createIcon(map, 'plane-cyan', flightCom, 24);   
      createIcon(map, 'plane-green', flightPriv, 24);   
      createIcon(map, 'plane-pink', flightGov, 24);    
      createIcon(map, 'plane-red', flightMil, 24);     
      createIcon(map, 'plane-grey', isGhost ? phantomPurple : '#546E7A', 24);    
      createDot(map, 'dot-gold', isGhost ? phantomPurple : '#D4AF37', 8);
      createDot(map, 'dot-red', isGhost ? phantomPurple : '#D32F2F', 10);
      createDot(map, 'dot-orange', isGhost ? phantomPurple : '#E65100', 10);
      createDot(map, 'dot-green', isGhost ? phantomPurple : '#26A69A', 10);
      createDot(map, 'dot-fire', isGhost ? phantomPurple : '#E65100', 10);
      createDot(map, 'dot-cctv', cameraColor, 10);

      const sources = ['war-alerts-targets', 'war-alerts-lines', 'balloons', 'radiation'];
      sources.forEach(s => map.addSource(s, { type: 'geojson', data: EMPTY_FC }));

      // Warning icon generator (parameterized — eliminates 3x copy-paste)
      const createWarningIcon = (id: string, color: string) => {
        const s = 20;
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(s/2, 1);
        ctx.lineTo(s - 1, s - 1);
        ctx.lineTo(1, s - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', s/2, s - 4);
        map.addImage(id, { width: s, height: s, data: new Uint8Array(ctx.getImageData(0, 0, s, s).data) });
      };
      createWarningIcon('warn-icon', '#D32F2F');
      createWarningIcon('warn-orange', '#E65100');
      createWarningIcon('warn-yellow', '#F9A825');

      // Conflict zones — always-on warning markers (registry-driven, headless; uses warn-icon* above)
      addRegistryLayer(map, 'conflict_zones');

      // Day/Night terminator fill — registry-driven (theme-static; recolored live by theme effect)
      addRegistryLayer(map, 'day_night', themeMode);

      // Earthquakes — amber threat spectrum (registry-driven: eq-circles + eq-label)
      addRegistryLayer(map, 'earthquakes');

      // Fires — burnt sienna (registry-driven)
      addRegistryLayer(map, 'fires');

      // CCTV — glow + dot + label (registry-driven; dots/label recolored live by theme effect)
      addRegistryLayer(map, 'cctv', themeMode);

      // SURVEILLANCE (OSM camera locations — no live feed) — registry-driven, ghost-recolored
      addRegistryLayer(map, 'surveillance', themeMode);

      // Counter-surveillance point layers (OSM/Overpass; positions only) — registry-driven
      addRegistryLayer(map, 'police');
      addRegistryLayer(map, 'flock');
      addRegistryLayer(map, 'mass_surveil');

      // GDELT



      // ══ NETWORK INTEL — Live Malware (abuse.ch) + botnet mesh — registry-driven ══
      // (malware-* dots/labels + network-mesh-* lines, in that z-order)
      addRegistryLayer(map, 'malware');

      addRegistryLayer(map, 'global_incidents');

      // GPS Jamming — crimson (registry-driven: jam-fill + jam-label)
      addRegistryLayer(map, 'gps_jamming');

      // Weather Events (NASA EONET) — deep violet (registry-driven)
      addRegistryLayer(map, 'weather');

      // Nuclear Infrastructure — teal / amber risk (registry-driven)
      addRegistryLayer(map, 'infrastructure');

      // Satellites (registry-driven)
      addRegistryLayer(map, 'satellites');

      // Maritime — ports & naval bases + chokepoints (registry-driven).
      // ship-dots / ship-label are added later (after the SDK mesh lines) to keep z-order.
      addRegistryLayer(map, 'maritime');

      // Live News — muted rose (registry-driven)
      addRegistryLayer(map, 'live_news');

      // SIGINT RSS news — gold markers (registry-driven, headless)
      addRegistryLayer(map, 'news_intel');

      // ══ IP SWEEP — Neighborhood device visualization (registry style; imperative render) ══
      addRegistryLayer(map, 'ip_sweep');

      // ══ SCAN TARGETS — Geolocated individual scans (registry style; imperative render) ══
      addRegistryLayer(map, 'scan_targets');

      // Address-intel overlay (pin / radius / nearby surveillance / sightlines) — top of z-order
      addRegistryLayer(map, 'dossier');

      // Live user position (GPS) — above everything
      addRegistryLayer(map, 'user_position');

      // Flight layers (WebGL symbol — GPU rendered, handles 50K+ smooth) — registry-driven.
      // Icons (plane-cyan/green/pink/red) are created above and recolored live by the theme effect.
      addRegistryLayer(map, 'flights');
      addRegistryLayer(map, 'private');
      addRegistryLayer(map, 'jets');
      addRegistryLayer(map, 'military');

      // Balloons (moving entities)
      map.addLayer({ id: 'balloon-dots', type: 'circle', source: 'balloons', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,3, 5,5, 10,7],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.8,
        'circle-stroke-width': 1, 'circle-stroke-color': '#fff', 'circle-stroke-opacity': 0.5,
      }});
      map.addLayer({ id: 'balloon-label', type: 'symbol', source: 'balloons', minzoom: 4, layout: {
        'text-field': ['get','callsign'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.2], 'text-max-width': 12, 'text-allow-overlap': false,
      }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // Radiation — violet base, threat spectrum for danger/warning
      map.addLayer({ id: 'rad-glow', type: 'circle', source: 'radiation', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,10, 5,20, 10,40],
        'circle-color': ['match', ['get','status'], 'DANGER','#D32F2F', 'WARNING','#E65100', '#7E57C2'],
        'circle-opacity': 0.12, 'circle-blur': 1,
      }});
      map.addLayer({ id: 'rad-dots', type: 'circle', source: 'radiation', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,4, 5,6, 10,8],
        'circle-color': ['match', ['get','status'], 'DANGER','#D32F2F', 'WARNING','#E65100', '#7E57C2'],
        'circle-opacity': 0.85,
        'circle-stroke-width': 1.5, 'circle-stroke-color': ['match', ['get','status'], 'DANGER','#D32F2F', 'WARNING','#E65100', '#7E57C2'], 'circle-stroke-opacity': 0.35,
      }});
      map.addLayer({ id: 'rad-label', type: 'symbol', source: 'radiation', minzoom: 5, layout: {
        'text-field': ['concat', ['to-string', ['get','reading']], ' nSv/h'], 'text-size': 9, 'text-font': ['Open Sans Bold'],
        'text-offset': [0, 1.5], 'text-allow-overlap': false,
      }, paint: { 'text-color': ['match', ['get','status'], 'DANGER','#D32F2F', 'WARNING','#E65100', '#7E57C2'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      // ══ OSIRIS SDK — Lattice Intelligence Mesh (sea/air/intel lines) — registry-driven ══
      // Polybolos Style: Delicate, translucent, steel-blue splined mesh
      addRegistryLayer(map, 'sdk_sea');

      // Maritime Ships (moving entities) — ocean teal family
      map.addLayer({ id: 'ship-dots', type: 'circle', source: 'maritime-ships', paint: {
        'circle-radius': ['interpolate',['linear'],['zoom'], 1,2, 5,4, 10,6],
        'circle-color': ['match', ['get','type'], 'military','#D32F2F', 'tanker','#E65100', 'cargo','#26C6DA', '#B0BEC5'],
        'circle-opacity': 0.75,
      }});
      map.addLayer({ id: 'ship-label', type: 'symbol', source: 'maritime-ships', minzoom: 5, layout: {
        'text-field': ['get','name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
        'text-offset': [0, 1.2], 'text-allow-overlap': false,
      }, paint: { 'text-color': ['match', ['get','type'], 'military','#D32F2F', 'tanker','#E65100', 'cargo','#26C6DA', '#B0BEC5'], 'text-halo-color': '#000', 'text-halo-width': 1 }});

      setMapReady(true);
      } catch (error) {
        console.error('[OSIRIS] Map init failed:', error);
      }
    });

    // Events
    let lastMove = 0;
    map.on('mousemove', e => {
      const now = Date.now();
      if (now - lastMove > 100) {
        lastMove = now;
        onMouseCoords?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
    });
    map.on('contextmenu', e => { e.preventDefault(); onRightClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
    map.on('moveend', () => { const c = map.getCenter(); onViewStateChange?.({ zoom: map.getZoom(), latitude: c.lat, longitude: c.lng }); });

    // ── POPUP HELPER ──
    const popup = (coords: any, html: string) => {
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '420px', offset: 14 }).setLngLat(coords).setHTML(html).addTo(map);
    };
    const pStyle = `background:rgba(12,14,26,0.95);backdrop-filter:blur(16px);border-radius:10px;padding:16px;font-family:'JetBrains Mono',monospace;`;
    const linkStyle = `display:inline-block;margin-top:8px;padding:5px 12px;font-size:10px;letter-spacing:0.12em;text-decoration:none;border-radius:5px;font-family:'JetBrains Mono',monospace;`;

    // ── Flights (with FlightAware + ADS-B Exchange links) ──
    ['fl-commercial','fl-private','fl-jets','fl-military'].forEach(layer => {
      map.on('click', layer, e => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as any;
        const coords = (e.features[0].geometry as any).coordinates;
        const cs = (p.callsign||'').trim();
        const aircraftId = cs || p.icao24;
        if (aircraftId) {
          onEntityClick?.({
            type: 'aircraft',
            id: aircraftId,
            label: aircraftId,
            callsign: cs,
            icao24: p.icao24,
            model: p.model,
            registration: p.registration,
          });
        }
        popup(coords, `<div style="${pStyle}border:1px solid rgba(212,175,55,0.3);">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <span style="color:#D4AF37;font-size:16px;font-weight:700;letter-spacing:0.1em;">${cs}</span>
            <span style="color:#5C5A54;font-size:10px;">${p.icao24||''}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:11px;">
            <div><span style="color:#5C5A54;font-size:9px;">MODEL</span><br/><span style="color:#E8E6E0;">${p.model||'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">ALT</span><br/><span style="color:#00E5FF;">${p.alt?Math.round(p.alt)+'m':'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">SPEED</span><br/><span style="color:#E8E6E0;">${p.speed_knots||'—'}kt</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">HDG</span><br/><span style="color:#E8E6E0;">${Math.round(p.heading||0)}°</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">REG</span><br/><span style="color:#E8E6E0;">${p.registration||'—'}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">POS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(2)},${coords[0].toFixed(2)}</span></div>
          </div>
          <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
            <a href="https://www.flightaware.com/live/flight/${cs}" target="_blank" style="${linkStyle}color:#D4AF37;border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.1);">⚡ FLIGHTAWARE</a>
            <a href="https://globe.adsbexchange.com/?icao=${p.icao24||''}" target="_blank" style="${linkStyle}color:#00E5FF;border:1px solid rgba(0,229,255,0.4);background:rgba(0,229,255,0.1);">📡 ADS-B</a>
            <a href="https://www.radarbox.com/data/flights/${cs}" target="_blank" style="${linkStyle}color:#FF69B4;border:1px solid rgba(255,105,180,0.4);background:rgba(255,105,180,0.1);">📍 RADARBOX</a>
          </div>
          <button onclick="window.openOsirisIntel({ callsign: '${cs}', icao24: '${p.icao24||''}', model: '${p.model||''}', registration: '${p.registration||''}' })" style="width:100%;margin-top:8px;padding:6px 12px;background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.5);color:#D4AF37;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ DEEP DIVE INTEL ]</button>
        </div>`);
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });

    // ── CCTV (opens CameraViewer panel) ──
    map.on('click', 'cctv-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      // Emit the camera data so the CameraViewer opens
      onEntityClick?.({
        type: 'cctv',
        id: p.id,
        name: p.name,
        city: p.city,
        country: p.country,
        source: p.source,
        feed_url: p.feed_url,
        stream_url: p.stream_url,
        stream_type: p.stream_type,
        external_url: p.external_url,
        lat: coords[1],
        lng: coords[0],
      });
      // Also fly to the camera
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 13), duration: 1000 });
    });

    // ── Surveillance (OSM location only — info popup, no live feed) ──
    map.on('click', 'surv-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const rows = [
        ['TYPE', p.surveillance_type || p.camera_type || 'camera'],
        ['ZONE', p.zone || '—'],
        ['OPERATOR', p.operator || '—'],
      ].map(([k, v]) => `<div><span style="color:#5C5A54;">${k}</span><br/><span style="color:#E8E6E0;">${v}</span></div>`).join('');
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,171,0,0.35);">
        <div style="color:#FFAB00;font-size:13px;font-weight:700;margin-bottom:2px;">📹 ${p.name || 'Surveillance Camera'}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${p.country || ''} · location only — no live feed</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">${rows}</div>
        <a href="${p.osm_url || '#'}" target="_blank" rel="noopener" style="${linkStyle}color:#FFAB00;border:1px solid rgba(255,171,0,0.4);background:rgba(255,171,0,0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Police stations (OSM location only) ──
    map.on('click', 'police-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(66,165,245,0.35);">
        <div style="color:#42A5F5;font-size:13px;font-weight:700;margin-bottom:2px;">🚔 ${p.name || 'Police Station'}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${p.operator || 'Police'} · location only</div>
        <a href="${p.osm_url || '#'}" target="_blank" rel="noopener" style="${linkStyle}color:#42A5F5;border:1px solid rgba(66,165,245,0.4);background:rgba(66,165,245,0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Flock / ALPR cameras (OSM location only) ──
    map.on('click', 'flock-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,112,67,0.35);">
        <div style="color:#FF7043;font-size:13px;font-weight:700;margin-bottom:2px;">🎥 ${p.name || 'ALPR Camera'}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${p.surveillance_type || 'ALPR'}${p.operator ? ' · ' + p.operator : ''} · location only</div>
        <a href="${p.osm_url || '#'}" target="_blank" rel="noopener" style="${linkStyle}color:#FF7043;border:1px solid rgba(255,112,67,0.4);background:rgba(255,112,67,0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Mass surveillance (OSM location only) ──
    map.on('click', 'mass-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(239,83,80,0.35);">
        <div style="color:#EF5350;font-size:13px;font-weight:700;margin-bottom:2px;">👁 ${p.name || 'Surveillance'}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${p.zone || p.surveillance_type || 'public area'}${p.operator ? ' · ' + p.operator : ''} · location only</div>
        <a href="${p.osm_url || '#'}" target="_blank" rel="noopener" style="${linkStyle}color:#EF5350;border:1px solid rgba(239,83,80,0.4);background:rgba(239,83,80,0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Dossier nearby surveillance (address-intel overlay) ──
    map.on('click', 'dossier-nearby-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const kind = String(p.kind || 'camera').toLowerCase();
      const c = DOSSIER_KIND_COLOR[kind] || DOSSIER_KIND_COLOR.camera;
      const rgb = DOSSIER_KIND_RGB[kind] || DOSSIER_KIND_RGB.camera;
      const name = escapeHtml(String(p.name || 'Surveillance'));
      const distanceM = escapeHtml(String(p.distanceM ?? ''));
      const label = escapeHtml(kind.toUpperCase());
      const href = escapeHtml(String(p.osmUrl || '#'));
      popup(coords, `<div style="${pStyle}border:1px solid rgba(${rgb},0.35);">
        <div style="color:${c};font-size:13px;font-weight:700;margin-bottom:2px;">${name}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${label} · ${distanceM}m away · can observe this location</div>
        <a href="${href}" target="_blank" rel="noopener" style="${linkStyle}color:${c};border:1px solid rgba(${rgb},0.4);background:rgba(${rgb},0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Route exposure surveillance (route-intel overlay) ──
    map.on('click', 'route-surveil-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const kind = String(p.kind || 'camera').toLowerCase();
      const c = DOSSIER_KIND_COLOR[kind] || DOSSIER_KIND_COLOR.camera;
      const rgb = DOSSIER_KIND_RGB[kind] || DOSSIER_KIND_RGB.camera;
      const name = escapeHtml(String(p.name || 'Surveillance'));
      const distanceM = escapeHtml(String(p.distanceM ?? ''));
      const label = escapeHtml(kind.toUpperCase());
      const href = escapeHtml(String(p.osmUrl || '#'));
      popup(coords, `<div style="${pStyle}border:1px solid rgba(${rgb},0.35);">
        <div style="color:${c};font-size:13px;font-weight:700;margin-bottom:2px;">${name}</div>
        <div style="font-size:9px;color:#8A8780;margin-bottom:8px;">${label} · ${distanceM}m from route · can observe the route</div>
        <a href="${href}" target="_blank" rel="noopener" style="${linkStyle}color:${c};border:1px solid rgba(${rgb},0.4);background:rgba(${rgb},0.1);">🗺 VIEW ON OSM</a>
      </div>`);
    });

    // ── Earthquakes (with USGS link) ──
    map.on('click', 'eq-circles', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,149,0,0.3);">
        <div style="color:#FF9500;font-size:14px;font-weight:700;margin-bottom:4px;">M${p.magnitude} EARTHQUAKE</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${p.place||'Unknown location'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">DEPTH</span><br/><span style="color:#E8E6E0;">${p.depth||'—'}km</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}, ${coords[0].toFixed(3)}</span></div>
        </div>
        <a href="${p.source === 'NIGGG-BAS' ? 'https://ndc.niggg.bas.bg/' : `https://earthquake.usgs.gov/earthquakes/eventpage/${p.id||''}`}" target="_blank" style="${linkStyle}color:#FF9500;border:1px solid rgba(255,149,0,0.4);background:rgba(255,149,0,0.1);">📊 ${p.source === 'NIGGG-BAS' ? 'NIGGG-BAS' : 'USGS DETAILS'}</a>
      </div>`);
    });

    // ── Satellites (SatNOGS powered) ──
    map.on('click', 'sat-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(212,175,55,0.3);">
        <div style="color:#D4AF37;font-size:12px;font-weight:700;letter-spacing:0.1em;margin-bottom:4px;">🛰️ ${p.name}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">MISSION</span><br/><span style="color:${p.color||'#aaa'};">${p.mission||'Unknown'}</span></div>
          <div><span style="color:#5C5A54;">ALT</span><br/><span style="color:#00E5FF;">${p.alt ? p.alt+' km' : '—'}</span></div>
          <div><span style="color:#5C5A54;">POS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(2)}°, ${coords[0].toFixed(2)}°</span></div>
        </div>
        ${p.noradId ? `<a href="https://db.satnogs.org/satellite/${p.noradId}/" target="_blank" style="display:block;text-align:center;padding:4px;margin-top:6px;font-size:8px;font-family:monospace;letter-spacing:0.1em;text-decoration:none;color:#00E5FF;border:1px solid rgba(0,229,255,0.4);background:rgba(0,229,255,0.1);border-radius:2px;cursor:pointer;">🔭 SOURCE: SATNOGS</a>` : ''}
      </div>`);
    });

    // ── Fires (with NASA FIRMS link) ──
    map.on('click', 'fires-heat', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,107,0,0.3);">
        <div style="color:#FF6B00;font-size:12px;font-weight:700;margin-bottom:6px;">🔥 ACTIVE FIRE DETECTED</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">BRIGHTNESS</span><br/><span style="color:#FF6B00;">${p.brightness||'—'}K</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <a href="https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;l:noaa20-viirs,viirs,modis_a,modis_t;@${coords[0]},${coords[1]},10z" target="_blank" style="${linkStyle}color:#FF6B00;border:1px solid rgba(255,107,0,0.4);background:rgba(255,107,0,0.1);">🛰️ NASA FIRMS MAP</a>
      </div>`);
    });

    // ── Malware Threats (Abuse.ch) ──
    map.on('click', 'malware-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const tType = (p.threat_type || 'MALWARE').toUpperCase();
      const statusColor = p.status === 'online' ? '#39FF14' : '#FF1744';
      
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,23,68,0.4);box-shadow:inset 0 0 12px rgba(255,23,68,0.1);">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,23,68,0.3);padding-bottom:6px;margin-bottom:8px;">
          <div style="color:#FF1744;font-size:12px;font-weight:700;letter-spacing:0.1em;text-shadow:0 0 4px rgba(255,23,68,0.5);">[ ${tType} ]</div>
          <div style="color:#5C5A54;font-size:9px;">${p.country || 'UNKNOWN'}</div>
        </div>
        <div style="color:#E8E6E0;font-size:11px;font-weight:bold;margin-bottom:10px;">${p.malware || 'Unidentified Threat Payload'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:12px;background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;">
          <div><span style="color:#5C5A54;">TARGET IP</span><br/><span style="color:#00E5FF;font-family:monospace;">${p.ip}</span></div>
          <div><span style="color:#5C5A54;">STATUS</span><br/><span style="color:${statusColor};">${(p.status||'UNKNOWN').toUpperCase()}</span></div>
        </div>
        <div style="display:flex;gap:6px;">
          <a href="https://feodotracker.abuse.ch/browse/" target="_blank" style="${linkStyle}flex:1;text-align:center;color:#E8E6E0;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);">THREAT INTEL ↗</a>
        </div>
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${p.ip}', threat_type: '${p.malware || p.threat_type || ''}', status: '${p.status || ''}' })" style="width:100%;margin-top:8px;padding:8px 12px;background:linear-gradient(90deg, rgba(255,23,68,0.1) 0%, rgba(255,23,68,0.2) 100%);border:1px solid rgba(255,23,68,0.6);color:#FF1744;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.15em;border-radius:4px;cursor:pointer;transition:all 0.2s;">DEEP DIVE ANALYTICS</button>
      </div>`);
    });


    // ── GDELT Conflicts (with source article) ──
    map.on('click', 'gdelt-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      
      // Map coordinates to Liveuamap regions
      let sourceUrl = p.url || '';
      if (!sourceUrl || sourceUrl.includes('google.com')) {
        const [lng, lat] = coords;
        if (lat > 44 && lat < 53 && lng > 22 && lng < 40) sourceUrl = 'https://liveuamap.com/'; // Ukraine
        else if (lat > 30 && lat < 33 && lng > 34 && lng < 36) sourceUrl = 'https://israelpalestine.liveuamap.com/'; // Gaza
        else if (lat > 33 && lat < 34.5 && lng > 35 && lng < 36.5) sourceUrl = 'https://lebanon.liveuamap.com/'; // Lebanon
        else if (lat > 32 && lat < 37 && lng > 35 && lng < 42) sourceUrl = 'https://syria.liveuamap.com/'; // Syria
        else if (lat > 10 && lat < 22 && lng > 22 && lng < 38) sourceUrl = 'https://sudan.liveuamap.com/'; // Sudan
        else if (lat > 12 && lat < 20 && lng > 42 && lng < 55) sourceUrl = 'https://yemen.liveuamap.com/'; // Yemen
        else sourceUrl = 'https://liveuamap.com/'; // Global fallback
      }

      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,61,61,0.3);">
        <div style="color:#FF3D3D;font-size:12px;font-weight:700;margin-bottom:6px;">⚠️ CONFLICT EVENT</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;line-height:1.4;">${p.name||'Unclassified incident'}</div>
        <a href="${sourceUrl}" target="_blank" style="${linkStyle}flex:1;text-align:center;color:#FF3D3D;border:1px solid rgba(255,61,61,0.4);background:rgba(255,61,61,0.15);display:inline-block;width:100%;box-sizing:border-box;margin-top:4px;">[ OPEN SOURCE ↗ ]</a>
      </div>`);
    });

    // ── Global Event / Conflict Markers ──
    map.on('click', 'conflict-icons', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.severity === 'war' ? '#FF1744' : p.severity === 'high' ? '#FF9500' : '#FFD500';
      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:6px;">⚠️ ${p.label || 'WARNING EVENT'}</div>
        <div style="font-size:10px;color:#E8E6E0;margin-bottom:8px;line-height:1.4;">${p.description || 'Global event detected at this location.'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:${color};">${(p.severity||'unknown').toUpperCase()}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        ${p.sourceUrl ? `<a href="${p.sourceUrl}" target="_blank" style="${linkStyle}flex:1;text-align:center;color:${color};border:1px solid ${color}40;background:${color}15;display:inline-block;width:100%;box-sizing:border-box;margin-top:4px;">[ OPEN SOURCE ↗ ]</a>` : ''}
      </div>`);
    });


    // ── OSIRIS SDK link click ──
    const SDK_SOURCE_URLS: Record<string, string> = {
      'AIS Maritime': 'https://www.marinetraffic.com',
      'AIS Stream': 'https://aisstream.io',
      'AIS → Lattice': 'https://aisstream.io',
      'ADS-B / OpenSky': 'https://opensky-network.org',
      'ADS-B → Lattice': 'https://opensky-network.org',
      'Naval Intelligence': 'https://www.odni.gov',
    };
    ['sdk-sea','sdk-sea-glow','sdk-air','sdk-air-glow','sdk-intel','sdk-intel-glow'].forEach(layer => {
      map.on('click', layer, e => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as any;
        const coords = e.lngLat;
        const srcUrl = p.url || SDK_SOURCE_URLS[p.source] || 'https://osirisai.live';
        const domainLabel = p.domain === 'SEA' ? '⚓ MARITIME' : p.domain === 'AIR' ? '✈ AIR CORRIDOR' : '🛡 NAVAL INTEL';
        const domainColor = p.domain === 'SEA' ? '#4FC3F7' : p.domain === 'AIR' ? '#B3E5FC' : '#81D4FA';
        const linkStyle = 'text-decoration:none;padding:3px 8px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:0.05em;';
        popup([coords.lng, coords.lat], `<div style="${pStyle}border:1px solid ${domainColor}40;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
            <div style="width:8px;height:8px;border-radius:50%;background:${domainColor};box-shadow:0 0 8px ${domainColor};"></div>
            <span style="color:${domainColor};font-size:11px;font-weight:700;letter-spacing:0.1em;">${domainLabel}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:8px;">
            <div><span style="color:#5C5A54;">FROM</span><br/><span style="color:#E8E6E0;">${p.fromName || 'Origin'}</span></div>
            <div><span style="color:#5C5A54;">TO</span><br/><span style="color:#E8E6E0;">${p.toName || 'Destination'}</span></div>
            <div><span style="color:#5C5A54;">DOMAIN</span><br/><span style="color:${domainColor};">${p.domain}</span></div>
            <div><span style="color:#5C5A54;">SOURCE</span><br/><a href="${srcUrl}" target="_blank" style="color:${domainColor};text-decoration:underline;cursor:pointer;">${p.source || 'OSIRIS'}</a></div>
          </div>
          <a href="${srcUrl}" target="_blank" style="${linkStyle}color:${domainColor};border:1px solid ${domainColor}40;background:${domainColor}18;display:inline-block;margin-top:4px;">OPEN SOURCE ↗</a>
        </div>`);
      });
    });

    // ── Generic hover for clickables ──
    ['conflict-icons','cctv-dots','surv-dots','police-dots','flock-dots','mass-dots','dossier-nearby-dots','route-surveil-dots','eq-circles','sat-dots','fires-heat','gdelt-dots','weather-dots','infra-dots','maritime-dots','choke-dots','news-dots','sigint-news-dots','balloon-dots','rad-dots','ship-dots','sweep-device-dots','scan-targets-dots','sdk-sea','sdk-sea-glow','sdk-sea-atmo','sdk-air','sdk-air-glow','sdk-air-atmo','sdk-intel','sdk-intel-glow','sdk-intel-atmo','malware-dots'].forEach(layer => {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });

    // ── Scan Targets click ──
    map.on('click', 'scan-targets-dots', (e: any) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = e.features[0].geometry.coordinates.slice();
      popup(coords, `<div style="${pStyle}border:1px solid rgba(255,61,61,0.5);">
        <div style="color:#FF3D3D;font-size:12px;font-weight:700;margin-bottom:6px;">🎯 TARGET: ${p.id}</div>
        <div style="font-size:9px;color:#E8E6E0;margin-bottom:8px;">${p.city || 'Unknown'}, ${p.country || 'Unknown'} — ${p.isp || 'Unknown ISP'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">TYPE</span><br/><span style="color:#00E5FF;">${(p.type || 'UNKNOWN').toUpperCase()}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${p.id}' })" style="width:100%;margin-top:8px;padding:6px 12px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.5);color:#FF6D00;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ IP INTEL DEEP DIVE ]</button>
      </div>`);
    });

    // ── SCM Suppliers ──
    map.on('click', 'scm-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.risk_level === 'CRITICAL' ? '#FF1744' : p.risk_level === 'HIGH' ? '#FF9500' : '#00BCD4';
      const activeThreats = safeJsonArray<string>(p.active_threats);
      
      let threatsHtml = '';
      if (activeThreats.length > 0) {
        threatsHtml = `<div style="margin-top:8px;padding-top:6px;border-top:1px solid ${color}40;color:${color};font-size:9px;font-weight:bold;">
          ACTIVE THREATS:<br/>${activeThreats.map((t: string) => `⚠ ${t}`).join('<br/>')}
        </div>`;
      }

      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:4px;">🏢 ${p.name}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${p.category} | ${p.city}, ${p.country}</div>
        <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:11px;">
          <div><span style="color:#5C5A54;font-size:9px;">SCM RISK LEVEL</span><br/><span style="color:${color};font-weight:bold;">${p.risk_level}</span></div>
        </div>
        ${threatsHtml}
      </div>`);
    });

    // ── IP Sweep device click ──
    map.on('click', 'sweep-device-dots', (e: any) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = e.features[0].geometry.coordinates.slice();
      const ports = safeJsonArray(p.ports);
      const vulns = safeJsonArray<string>(p.vulns);
      const hostnames = safeJsonArray<string>(p.hostnames);
      const riskColors: Record<string, string> = { CRITICAL: '#FF3D3D', HIGH: '#FF6B00', MEDIUM: '#FFD700', LOW: '#76FF03', INFO: '#5C5A54' };
      popup(coords, `<div style="font-family:monospace;font-size:11px;color:#E8E6E0;">
        <div style="font-size:13px;font-weight:bold;margin-bottom:6px;color:${p.color};">${p.device_type}</div>
        <div style="font-size:12px;margin-bottom:8px;color:#fff;">${p.ip}</div>
        ${hostnames.length > 0 ? `<div style="font-size:9px;color:#8A8880;margin-bottom:6px;">${hostnames.join(', ')}</div>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">PORTS</span><br/><span style="color:#E8E6E0;">${ports.length}</span></div>
          <div><span style="color:#5C5A54;">RISK</span><br/><span style="color:${riskColors[p.risk_level] || '#666'};">${p.risk_level}</span></div>
        </div>
        <div style="font-size:9px;color:#8A8880;margin-bottom:6px;">Open: ${ports.slice(0, 12).join(', ')}${ports.length > 12 ? ' ...' : ''}</div>
        ${vulns.length > 0 ? `<div style="font-size:9px;color:#FF3D3D;margin-bottom:6px;">⚠ CVEs: ${vulns.slice(0, 5).join(', ')}${vulns.length > 5 ? ` +${vulns.length - 5} more` : ''}</div>` : ''}
        <button onclick="window.openOsirisIntel({ type: 'ip', ip: '${p.ip}' })" style="width:100%;margin-top:6px;padding:6px 12px;background:rgba(255,109,0,0.15);border:1px solid rgba(255,109,0,0.5);color:#FF6D00;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:bold;letter-spacing:0.1em;border-radius:4px;cursor:pointer;">[ IP INTEL DEEP DIVE ]</button>
      </div>`);
    });

    // ── Balloons / Sondes ──
    map.on('click', 'balloon-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      popup(coords, `<div style="${pStyle}border:1px solid ${p.color}40;">
        <div style="color:${p.color};font-size:12px;font-weight:700;letter-spacing:0.1em;margin-bottom:4px;">🎈 ${p.callsign}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${p.type.toUpperCase()} / STATUS: ${p.status.toUpperCase()}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;">
          <div><span style="color:#5C5A54;">ALTITUDE</span><br/><span style="color:#E8E6E0;">${p.altitude} m</span></div>
          <div><span style="color:#5C5A54;">SPEED</span><br/><span style="color:#E8E6E0;">${Math.round(p.speed)} km/h</span></div>
          <div><span style="color:#5C5A54;">VERT RATE</span><br/><span style="color:${p.verticalRate > 0 ? '#00E676' : '#FF3D3D'};">${p.verticalRate.toFixed(1)} m/s</span></div>
          <div><span style="color:#5C5A54;">TEMP</span><br/><span style="color:#E8E6E0;">${p.temperature}°C</span></div>
        </div>
      </div>`);
    });

    // ── Radiation ──
    map.on('click', 'rad-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.status === 'DANGER' ? '#FF1744' : p.status === 'WARNING' ? '#FF9500' : '#AB47BC';
      popup(coords, `<div style="${pStyle}border:1px solid ${color}40;">
        <div style="color:${color};font-size:12px;font-weight:700;margin-bottom:4px;">☢️ ${p.name}</div>
        <div style="font-size:9px;color:#aaa;margin-bottom:8px;">${p.city}, ${p.country}</div>
        <div style="display:grid;grid-template-columns:1fr;gap:4px;font-size:11px;">
          <div><span style="color:#5C5A54;font-size:9px;">READING</span><br/><span style="color:${color};font-weight:bold;">${p.reading} nSv/h</span></div>
          <div><span style="color:#5C5A54;font-size:9px;">STATUS</span><br/><span style="color:${color};">${p.status}</span></div>
          <div><span style="color:#5C5A54;font-size:9px;">NETWORK</span><br/><span style="color:#E8E6E0;">${p.network}</span></div>
        </div>
      </div>`);
    });

    // ── Maritime Ships ──
    map.on('click', 'ship-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const color = p.type === 'military' ? '#FF1744' : p.type === 'tanker' ? '#FF9500' : '#00E5FF';
      const icon = p.type === 'military' ? '⚔️' : p.type === 'tanker' ? '🛢️' : '🚢';
      const s = p;
      const vesselId = s.imo || s.mmsi || s.name;
      if (vesselId) {
        onEntityClick?.({
          type: 'vessel',
          id: String(vesselId),
          label: s.name || String(vesselId),
          name: s.name,
          mmsi: s.mmsi,
          imo: s.imo,
          flag: s.flag,
          speed: s.speed,
          destination: s.destination,
        });
      }

      popup(coords, `<div style="${pStyle}border:1px solid ${color}60;box-shadow:inset 0 0 12px ${color}15;">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid ${color}40;padding-bottom:6px;margin-bottom:8px;">
          <div style="color:${color};font-size:12px;font-weight:700;letter-spacing:0.1em;">${icon} [ ${(p.type||'VESSEL').toUpperCase()} ]</div>
          <div style="color:#5C5A54;font-size:9px;">FLAG: ${p.flag||'UNK'}</div>
        </div>
        <div style="color:#E8E6E0;font-size:11px;font-weight:bold;margin-bottom:10px;">${p.name || 'UNIDENTIFIED VESSEL'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:8px;background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;">
          <div><span style="color:#5C5A54;">SPEED</span><br/><span style="color:${color};font-family:monospace;">${Number(p.speed).toFixed(1)} kn</span></div>
          <div><span style="color:#5C5A54;">HEADING</span><br/><span style="color:${color};font-family:monospace;">${Number(p.heading).toFixed(0)}°</span></div>
          <div><span style="color:#5C5A54;">LATITUDE</span><br/><span style="color:#E8E6E0;font-family:monospace;">${coords[1].toFixed(4)}°</span></div>
          <div><span style="color:#5C5A54;">LONGITUDE</span><br/><span style="color:#E8E6E0;font-family:monospace;">${coords[0].toFixed(4)}°</span></div>
        </div>
        <div><span style="color:#5C5A54;font-size:9px;">DESTINATION: </span><span style="color:#E8E6E0;font-size:9px;">${p.destination || 'UNKNOWN'}</span></div>
        <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${p.mmsi}" target="_blank" style="${linkStyle}flex:1;text-align:center;color:${color};border:1px solid ${color}40;background:${color}15;display:inline-block;width:100%;box-sizing:border-box;margin-top:4px;">[ OPEN SOURCE ↗ ]</a>
      </div>`);
    });

    // ── Weather Events (NASA EONET) ──
    map.on('click', 'weather-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const iconEmoji = p.icon === 'cyclone' ? '🌀' : p.icon === 'volcano' ? '🌋' : '⚡';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(224,64,251,0.3);">
        <div style="color:#E040FB;font-size:14px;font-weight:700;margin-bottom:6px;">${iconEmoji} ${p.type || 'Weather Event'}</div>
        <div style="font-size:10px;color:#E8E6E0;margin-bottom:8px;line-height:1.4;">${p.title || 'Unknown event'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">SEVERITY</span><br/><span style="color:${p.severity === 'high' ? '#FF1744' : '#FFD700'};">${(p.severity||'low').toUpperCase()}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <div style="display:flex;gap:6px;">
          ${p.source ? `<a href="${p.source}" target="_blank" style="${linkStyle}color:#E040FB;border:1px solid rgba(224,64,251,0.4);background:rgba(224,64,251,0.1);">📡 SOURCE</a>` : ''}
          <a href="https://eonet.gsfc.nasa.gov/api/v3/events/${p.id || ''}" target="_blank" style="${linkStyle}color:#D4AF37;border:1px solid rgba(212,175,55,0.4);background:rgba(212,175,55,0.1);">🛰️ NASA EONET</a>
        </div>
      </div>`);
    });

    // ── Nuclear Infrastructure ──
    map.on('click', 'infra-dots', e => {
      if (!e.features?.length) return;
      const p = e.features[0].properties as any;
      const coords = (e.features[0].geometry as any).coordinates;
      const statusColor = p.status.includes('SEISMIC RISK') ? '#FF9500' : p.status === 'Active Conflict Zone' ? '#FF1744' : p.status === 'Operational' ? '#76FF03' : '#757575';
      popup(coords, `<div style="${pStyle}border:1px solid rgba(118,255,3,0.3);">
        <div style="color:#76FF03;font-size:14px;font-weight:700;margin-bottom:4px;">☢️ ${p.name || 'Nuclear Facility'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:9px;margin-bottom:8px;">
          <div><span style="color:#5C5A54;">STATUS</span><br/><span style="color:${statusColor};">${p.status || '—'}</span></div>
          <div><span style="color:#5C5A54;">CITY</span><br/><span style="color:#E8E6E0;">${p.city || '—'}, ${p.country || ''}</span></div>
          <div><span style="color:#5C5A54;">REACTORS</span><br/><span style="color:#76FF03;">${p.reactors || '—'}</span></div>
          <div><span style="color:#5C5A54;">CAPACITY</span><br/><span style="color:#E8E6E0;">${p.capacityMW ? p.capacityMW.toLocaleString() + ' MW' : '—'}</span></div>
          <div><span style="color:#5C5A54;">OWNER</span><br/><span style="color:#E8E6E0;">${p.owner || '—'}</span></div>
          <div><span style="color:#5C5A54;">COORDS</span><br/><span style="color:#E8E6E0;">${coords[1].toFixed(3)}°, ${coords[0].toFixed(3)}°</span></div>
        </div>
        <a href="https://www.google.com/maps/@${coords[1]},${coords[0]},14z/data=!3m1!1e3" target="_blank" style="${linkStyle}color:#76FF03;border:1px solid rgba(118,255,3,0.4);background:rgba(118,255,3,0.1);">SATELLITE VIEW</a>
      </div>`);
    });

    // ── Maritime Ports & Naval Bases ──
    map.on('click', 'maritime-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = (e.features![0].geometry as any).coordinates;
      const typeColor = p.type === 'naval' ? '#FF3D3D' : p.type === 'energy' ? '#FF9500' : '#00BCD4';
      const typeLabel = p.type === 'naval' ? 'NAVAL BASE' : p.type === 'energy' ? 'ENERGY PORT' : 'CONTAINER PORT';
      
      const congestionHtml = p.congestion ? `
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1);">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <div><span style="color:#5C5A54;font-size:9px;">CONGESTION</span><br/><span style="color:${p.congestion === 'SEVERE' ? '#FF1744' : p.congestion === 'CONGESTED' ? '#FF9500' : '#00E676'};font-weight:bold;font-size:10px;">${p.congestion}</span></div>
            <div><span style="color:#5C5A54;font-size:9px;">EST. DWELL TIME</span><br/><span style="color:#E8E6E0;font-weight:bold;font-size:10px;">${p.dwell_time || 'Unknown'}</span></div>
          </div>
        </div>` : '';

      popup(coords, `<div style="${pStyle}border:1px solid ${typeColor}40;">
        <div style="color:${typeColor};font-weight:bold;font-size:11px;margin-bottom:4px;">${p.name}</div>
        <div style="color:#999;font-size:9px;margin-bottom:6px;">${typeLabel} — ${p.country}</div>
        ${p.volume ? `<div style="font-size:9px;color:#aaa;">Volume: <span style="color:${typeColor};font-weight:bold;">${p.volume}</span></div>` : ''}
        ${p.fleet ? `<div style="font-size:9px;color:#aaa;">Fleet: <span style="color:${typeColor};font-weight:bold;">${p.fleet}</span></div>` : ''}
        ${p.rank ? `<div style="font-size:9px;color:#aaa;">Global Rank: <span style="color:${typeColor};font-weight:bold;">#${p.rank}</span></div>` : ''}
        ${congestionHtml}
      </div>`);
    });

    // ── Maritime Chokepoints ──
    map.on('click', 'choke-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const coords = (e.features![0].geometry as any).coordinates;
      const riskCol = p.risk === 'CRITICAL' ? '#FF1744' : p.risk === 'HIGH' ? '#FF9500' : p.risk === 'ELEVATED' ? '#FFD700' : '#00E676';
      popup(coords, `<div style="${pStyle}border:1px solid ${riskCol}40;">
        <div style="color:#FF9500;font-weight:bold;font-size:11px;margin-bottom:4px;">${p.name}</div>
        <div style="font-size:9px;color:#aaa;">Traffic: <span style="color:#fff;">${p.traffic}</span></div>
        <div style="font-size:9px;color:#aaa;">Risk: <span style="color:${riskCol};font-weight:bold;">${p.risk}</span></div>
      </div>`);
    });

    // ── Live News (opens feed viewer) ──
    map.on('click', 'news-dots', e => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      onEntityClick?.({
        type: 'live_news',
        name: p.name,
        city: p.city,
        country: p.country,
        url: p.url,
        category: p.category,
        embed_allowed: p.embed_allowed !== false && p.embed_allowed !== 'false',
      });
    });

    return () => {
      isMounted = false;
      resizeObserver.disconnect();
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Helper to set GeoJSON
  const setGeo = useCallback((source: string, features: any[]) => {
    const src = mapRef.current?.getSource(source) as any;
    if (src) src.setData({ type: 'FeatureCollection', features });
  }, []);

  const setGeoBatch = useCallback((updates: Record<string, any[]>) => {
    geoBatchUpdatesRef.current = { ...geoBatchUpdatesRef.current, ...updates };
    if (dossierOverlayFrameRef.current != null) return;
    dossierOverlayFrameRef.current = requestAnimationFrame(() => {
      const pending = geoBatchUpdatesRef.current;
      geoBatchUpdatesRef.current = {};
      dossierOverlayFrameRef.current = null;
      for (const [source, features] of Object.entries(pending)) {
        setGeo(source, features);
      }
    });
  }, [setGeo]);

  const setDossierGeoBatch = setGeoBatch;

  useEffect(() => () => {
    if (dossierOverlayFrameRef.current != null) cancelAnimationFrame(dossierOverlayFrameRef.current);
    geoBatchUpdatesRef.current = {};
  }, []);

  // Day/Night — registry-driven; the binding recomputes the terminator polygon, re-run here
  // on a 5-min interval (shadow barely moves) so the registry needs no timed-source concept.
  useEffect(() => {
    if (!mapReady) return;
    // day_night's binding ignores `data`, so it isn't a dep — avoids resetting the interval on polls.
    const update = () => renderRegistryLayer(setGeo, 'day_night', data, activeLayers);
    update();
    const iv = setInterval(update, 300000);
    return () => clearInterval(iv);
  }, [mapReady, activeLayers.day_night, setGeo]);

  const setVis = useCallback((ids: string[], visible: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); });
  }, []);

  // ── Dynamic layers (custom sources + plugins) ──
  // Publish the live map to the plugin host so plugin ctx.map/flyTo work.
  const registryVersion = useRegistryVersion();
  useEffect(() => { if (mapReady && mapRef.current) setHostServices({ map: mapRef.current }); }, [mapReady]);

  // Add/remove dynamic layers and wire their declarative interactions as the registry changes.
  // `ref` is the registry layer object — when a plugin/source is replaced (same id, new def),
  // the reference changes, so we tear the old one down and re-add rather than skipping it.
  const dynState = useRef<Map<string, { ref: any; styleIds: string[]; sources: string[]; offs: Array<() => void> }>>(new Map());
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const themeMode = themeRef.current === 'ghost' ? 'ghost' : 'core';
    const dyn = getLayers().filter(l => l.origin === 'custom' || l.origin === 'plugin');
    const live = new Map(dyn.map(l => [l.id, l]));

    const teardownEntry = (st: { styleIds: string[]; sources: string[]; offs: Array<() => void> }) => {
      st.offs.forEach(o => { try { o(); } catch { /* ignore */ } });
      for (const sid of st.styleIds) { try { if (map.getLayer(sid)) map.removeLayer(sid); } catch { /* ignore */ } }
      for (const src of st.sources) { try { if (map.getSource(src)) map.removeSource(src); } catch { /* ignore */ } }
    };

    for (const l of dyn) {
      const prev = dynState.current.get(l.id);
      if (prev && prev.ref === l) continue; // unchanged
      if (prev) { teardownEntry(prev); dynState.current.delete(l.id); } // replaced → refresh

      addRegistryLayer(map, l.id, themeMode);
      const styleIds = (l.styleLayers ?? []).map(s => s.id);
      const sources = [...new Set([
        ...(l.styleLayers ?? []).map(getStyleLayerSource),
        ...(l.render ?? []).map(getRenderBindingSource),
      ])];
      const offs: Array<() => void> = [];
      const inter = l.interaction;
      if (inter) {
        for (const sid of styleIds) {
          const onClick = (e: any) => {
            const props = e.features?.[0]?.properties ?? {};
            if (inter.kind === 'popup') {
              popupRef.current?.remove();
              popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '420px', offset: 14 }).setLngLat(e.lngLat).setHTML(inter.html(props)).addTo(map);
            } else if (inter.kind === 'custom') {
              inter.onClick({ lng: e.lngLat.lng, lat: e.lngLat.lat, layerId: l.id, props });
            } else if (inter.kind === 'entityGraph') {
              const ref = inter.map(props);
              (onEntityClickRef.current ?? getHost().openEntityGraph)(ref);
            } else if (inter.kind === 'camera') {
              getHost().openCamera(inter.toCamera ? inter.toCamera(props) : props);
            } else if (inter.kind === 'liveFeed') {
              getHost().openLiveFeed(inter.url(props), inter.name?.(props));
            }
          };
          const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
          const onLeave = () => { map.getCanvas().style.cursor = ''; };
          map.on('click', sid, onClick); map.on('mouseenter', sid, onEnter); map.on('mouseleave', sid, onLeave);
          offs.push(() => { map.off('click', sid, onClick); map.off('mouseenter', sid, onEnter); map.off('mouseleave', sid, onLeave); });
        }
      }
      dynState.current.set(l.id, { ref: l, styleIds, sources, offs });
    }

    // Tear down any dynamic layer no longer in the registry.
    for (const [id, st] of [...dynState.current]) {
      if (live.has(id)) continue;
      teardownEntry(st);
      dynState.current.delete(id);
    }
  }, [mapReady, registryVersion]);

  useEffect(() => () => {
    const map = mapRef.current;
    if (!map) {
      dynState.current.clear();
      return;
    }
    const teardownEntry = (st: { styleIds: string[]; sources: string[]; offs: Array<() => void> }) => {
      st.offs.forEach(o => { try { o(); } catch { /* ignore */ } });
      for (const sid of st.styleIds) { try { if (map.getLayer(sid)) map.removeLayer(sid); } catch { /* ignore */ } }
      for (const src of st.sources) { try { if (map.getSource(src)) map.removeSource(src); } catch { /* ignore */ } }
    };
    for (const [id, st] of [...dynState.current]) {
      teardownEntry(st);
      dynState.current.delete(id);
    }
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const themeMode = theme === 'ghost' ? 'ghost' : 'core';
    for (const id of dynState.current.keys()) updateRegistryLayerTheme(mapRef.current, id, themeMode);
  }, [mapReady, theme]);

  // Render dynamic layers' data on data/active/registry change.
  useEffect(() => {
    if (!mapReady) return;
    for (const l of getLayers()) {
      if (l.origin === 'custom' || l.origin === 'plugin') renderRegistryLayer(setGeo, l.id, data, activeLayers);
    }
  }, [mapReady, registryVersion, data, activeLayers, setGeo]);

  // Flight data → GeoJSON (GPU rendered, registry-driven with per-layer decimation)
  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'flights', data, activeLayers);
    renderRegistryLayer(setGeo, 'private', data, activeLayers);
    renderRegistryLayer(setGeo, 'jets', data, activeLayers);
    renderRegistryLayer(setGeo, 'military', data, activeLayers);
  }, [mapReady, data.commercial_flights, data.private_flights, data.private_jets, data.military_flights, activeLayers.flights, activeLayers.private, activeLayers.jets, activeLayers.military, setGeo]);

    // Update aircraft icon colors dynamically on theme switch
    useEffect(() => {
      if (!mapReady || !mapRef.current) return;
      const map = mapRef.current;
      
      const isGhost = theme === 'ghost';
      const phantomPurple = '#B388FF';
      const ghostPriv = '#CE93D8';
      const ghostGov = '#D500F9';

      const flightCom = isGhost ? phantomPurple : '#00E5FF';
      const flightPriv = isGhost ? ghostPriv : '#FFD700';
      const flightGov = isGhost ? ghostGov : '#FF9500';
      const flightMil = '#FF0000';
      const cameraColor = isGhost ? '#B388FF' : '#00E676';
      const surveillanceColor = isGhost ? '#FF80AB' : '#FFAB00';
      const dayNightColor = isGhost ? '#0D0030' : '#000022';

      const updateMapIcon = (id: string, color: string, size: number) => {
        if (!map.hasImage(id)) return;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const cx = size / 2, cy = size / 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx, cy - size * 0.4);
        ctx.lineTo(cx - size * 0.12, cy + size * 0.1);
        ctx.lineTo(cx - size * 0.4, cy + size * 0.2);
        ctx.lineTo(cx - size * 0.4, cy + size * 0.3);
        ctx.lineTo(cx - size * 0.12, cy + size * 0.15);
        ctx.lineTo(cx, cy + size * 0.35);
        ctx.lineTo(cx + size * 0.12, cy + size * 0.15);
        ctx.lineTo(cx + size * 0.4, cy + size * 0.3);
        ctx.lineTo(cx + size * 0.4, cy + size * 0.2);
        ctx.lineTo(cx + size * 0.12, cy + size * 0.1);
        ctx.closePath();
        ctx.fill();
        map.updateImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
      };

      const updateDotIcon = (id: string, color: string, size: number) => {
        if (!map.hasImage(id)) return;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        map.updateImage(id, { width: size, height: size, data: new Uint8Array(ctx.getImageData(0, 0, size, size).data) });
      };

      const setPaint = (layer: string, property: string, value: unknown) => {
        if (map.getLayer(layer)) map.setPaintProperty(layer, property, value);
      };

      updateMapIcon('plane-cyan', flightCom, 24);
      updateMapIcon('plane-green', flightPriv, 24);
      updateMapIcon('plane-pink', flightGov, 24);
      updateMapIcon('plane-red', flightMil, 24);
      updateMapIcon('plane-grey', isGhost ? phantomPurple : '#546E7A', 24);
      updateDotIcon('dot-cctv', cameraColor, 10);
      setPaint('day-night-fill', 'fill-color', dayNightColor);
      setPaint('cctv-dots', 'circle-color', cameraColor);
      setPaint('cctv-label', 'text-color', cameraColor);
      setPaint('surv-glow', 'circle-color', surveillanceColor);
      setPaint('surv-dots', 'circle-color', surveillanceColor);
      setPaint('surv-label', 'text-color', surveillanceColor);
    }, [mapReady, theme]);

  // ── DECOUPLED LAYER RENDERERS (Performance Optimized) ──

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'earthquakes', data, activeLayers);
  }, [mapReady, data.earthquakes, activeLayers.earthquakes, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'satellites', data, activeLayers);
  }, [mapReady, data.satellites, activeLayers.satellites, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'global_incidents', data, activeLayers);
  }, [mapReady, data.gdelt, activeLayers.global_incidents, setGeo]);

  // Malware Threats + computed botnet mesh (both render bindings on the 'malware' layer)
  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'malware', data, activeLayers);
  }, [mapReady, data.malware_threats, activeLayers.malware, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'gps_jamming', data, activeLayers);
  }, [mapReady, data.gps_jamming, activeLayers.gps_jamming, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'cctv', data, activeLayers);
  }, [mapReady, data.cameras_europe, data.cameras_north_america, data.cameras_asia, data.cameras_oceania,
      activeLayers.cctv_europe, activeLayers.cctv_north_america, activeLayers.cctv_asia, activeLayers.cctv_oceania, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'surveillance', data, activeLayers);
  }, [mapReady, data.surveillance, activeLayers.surveillance, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'police', data, activeLayers);
  }, [mapReady, data.police, activeLayers.police, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'flock', data, activeLayers);
  }, [mapReady, data.flock, activeLayers.flock, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'mass_surveil', data, activeLayers);
  }, [mapReady, data.mass_surveil, activeLayers.mass_surveil, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'fires', data, activeLayers);
  }, [mapReady, data.fires, activeLayers.fires, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'weather', data, activeLayers);
  }, [mapReady, data.weather_events, activeLayers.weather, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'infrastructure', data, activeLayers);
  }, [mapReady, data.infrastructure, activeLayers.infrastructure, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'maritime', data, activeLayers);
  }, [mapReady, data.maritime_ports, data.maritime_chokepoints, data.maritime_ships, activeLayers.maritime, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('balloons', activeLayers.balloons && data.balloons ? data.balloons.map((b: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lng, b.lat] }, properties: { callsign: b.callsign, type: b.type, status: b.status, altitude: b.altitude, speed: b.speed, verticalRate: b.verticalRate, temperature: b.temperature, color: b.color } })) : []);
  }, [mapReady, data.balloons, activeLayers.balloons, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    setGeo('radiation', activeLayers.radiation && data.radiation ? data.radiation.map((r: any) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lng, r.lat] }, properties: { name: r.name, city: r.city, country: r.country, reading: r.reading, status: r.status, network: r.network } })) : []);
  }, [mapReady, data.radiation, activeLayers.radiation, setGeo]);

  // ══ OSIRIS SDK — Lattice Sensor Mesh (registry-driven: sdk-entities + sdk-links bindings) ══
  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'sdk_sea', data, activeLayers);
  }, [mapReady, activeLayers.sdk_sea, activeLayers.sdk_air, activeLayers.sdk_naval, data.submarine_cables, data.sdk_entities, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'live_news', data, activeLayers);
  }, [mapReady, data.live_feeds, activeLayers.live_news, setGeo]);

  // SIGINT news (headless news_intel layer) + always-on conflict zones — registry-driven
  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'news_intel', data, activeLayers);
  }, [mapReady, data.news, activeLayers.news_intel, setGeo]);

  useEffect(() => {
    if (!mapReady) return;
    renderRegistryLayer(setGeo, 'conflict_zones', data, activeLayers);
  }, [mapReady, data.conflict_zones, data.gdelt, setGeo]);


  // Visibility
  useEffect(() => {
    if (!mapReady) return;
    setVis(['eq-circles','eq-label'], activeLayers.earthquakes);
    setVis(['sat-dots'], activeLayers.satellites);
    setVis(['gdelt-dots'], activeLayers.global_incidents);

    setVis(['malware-glow','malware-dots','malware-label'], activeLayers.malware);
    setVis(['network-mesh-atmo', 'network-mesh-glow', 'network-mesh-core'], activeLayers.internet_outages || activeLayers.malware);
    setVis(['jam-fill','jam-label'], activeLayers.gps_jamming);
    setVis(['day-night-fill'], activeLayers.day_night);
    setVis(['fl-commercial'], activeLayers.flights);
    setVis(['fl-private'], activeLayers.private);
    setVis(['fl-jets'], activeLayers.jets);
    setVis(['fl-military'], activeLayers.military);
    setVis(['cctv-glow','cctv-dots','cctv-label'], activeLayers.cctv_europe || activeLayers.cctv_north_america || activeLayers.cctv_asia || activeLayers.cctv_oceania);
    setVis(['surv-glow','surv-dots','surv-label'], activeLayers.surveillance);
    setVis(['police-glow','police-dots','police-label'], activeLayers.police);
    setVis(['flock-glow','flock-dots','flock-label'], activeLayers.flock);
    setVis(['mass-glow','mass-dots','mass-label'], activeLayers.mass_surveil);
    setVis(['fires-heat'], activeLayers.fires);
    setVis(['weather-glow','weather-dots','weather-label'], activeLayers.weather);
    setVis(['infra-glow','infra-dots','infra-label'], activeLayers.infrastructure);
    setVis(['maritime-glow','maritime-dots','maritime-label'], activeLayers.maritime);
    setVis(['choke-glow','choke-dots','choke-label'], activeLayers.maritime);
    setVis(['ship-dots','ship-label'], activeLayers.maritime);
    setVis(['news-glow','news-dots','news-label'], activeLayers.live_news);
    setVis(['sigint-news-glow','sigint-news-dots','sigint-news-label'], activeLayers.news_intel);
    setVis(['conflict-icons'], activeLayers.conflict_zones !== false);

    setVis(['balloon-dots','balloon-label'], activeLayers.balloons);
    setVis(['rad-glow','rad-dots','rad-label'], activeLayers.radiation);
    setVis(['sdk-sea','sdk-sea-glow','sdk-sea-atmo'], activeLayers.sdk_sea !== false);
    setVis(['sdk-air','sdk-air-glow','sdk-air-atmo'], activeLayers.sdk_air !== false);
    setVis(['sdk-intel','sdk-intel-glow','sdk-intel-atmo'], activeLayers.sdk_naval !== false);
    setVis(['dossier-radius-fill','dossier-radius-line','dossier-sightlines','dossier-nearby-glow','dossier-nearby-dots','dossier-pin-glow','dossier-pin-dot'], Boolean(dossierOverlay?.center));
    setVis(['route-corridor-fill','route-corridor-line','route-line-glow','route-line-core','route-surveil-glow','route-surveil-dots'], Boolean(routeOverlay?.line?.length));
    // Sweep layers always visible when data is present (controlled by useEffect)
    setVis(['sweep-connections','sweep-pulse-ring','sweep-device-glow','sweep-device-dots','sweep-device-labels'], true);
  }, [mapReady, activeLayers, dossierOverlay?.center, routeOverlay?.line?.length, setVis]);

  // IP Sweep visualization
  useEffect(() => {
    if (!mapReady) return;
    if (!sweepData?.devices?.length) {
      setGeo('ip-sweep-devices', []);
      setGeo('ip-sweep-pulse', []);
      setGeo('ip-sweep-connections', []);
      return;
    }

    const map = mapRef.current;
    if (!map) return;

    const { center, devices } = sweepData;
    const centerCoord: [number, number] = [center.lng, center.lat];

    // Switch to globe and fly to the sweep location
    try {
      (map as any).setProjection({ type: 'globe' });
      map.setSky({ 'sky-color': '#0A0A0F', 'sky-horizon-blend': 0.02, 'horizon-color': '#0A0A0F', 'horizon-fog-blend': 0.02 });
    } catch { /* projection may not be supported */ }

    map.flyTo({ center: centerCoord, zoom: 14, pitch: 50, bearing: -20, duration: 3000, essential: true });

    // Set center pulse
    setGeo('ip-sweep-pulse', [{
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: centerCoord },
      properties: { ip: sweepData.target_ip },
    }]);

    // Build device features spread in a circle around center
    const allDeviceFeatures = devices.map((d: any, i: number) => {
      const angle = (i / devices.length) * Math.PI * 2;
      const radius = 0.001 + ((i % 7 + 1) * 0.0004);
      const dLng = centerCoord[0] + Math.cos(angle) * radius * (1 / Math.cos(center.lat * Math.PI / 180));
      const dLat = centerCoord[1] + Math.sin(angle) * radius;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [dLng, dLat] },
        properties: {
          ip: d.ip, device_type: d.device_type, device_icon: d.device_icon,
          color: d.device_color, risk_level: d.risk_level,
          ports: JSON.stringify(d.ports), hostnames: JSON.stringify(d.hostnames),
          vulns: JSON.stringify(d.vulns), cpes: JSON.stringify(d.cpes), tags: JSON.stringify(d.tags),
        },
      };
    });

    // Connection lines from center to each device
    const connectionFeatures = allDeviceFeatures.map((f: any) => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [centerCoord, f.geometry.coordinates] },
      properties: { color: f.properties.color },
    }));

    // Stagger the appearance after 3s flyTo completes
    const batchTimers: ReturnType<typeof setTimeout>[] = [];
    const timer = setTimeout(() => {
      setGeo('ip-sweep-connections', connectionFeatures);
      const batchSize = 5;
      const batches = Math.ceil(allDeviceFeatures.length / batchSize);
      for (let b = 0; b < batches; b++) {
        batchTimers.push(setTimeout(() => {
          setGeo('ip-sweep-devices', allDeviceFeatures.slice(0, (b + 1) * batchSize));
        }, b * 100));
      }
    }, 3000);

    return () => {
      clearTimeout(timer);
      batchTimers.forEach(clearTimeout);
    };
  }, [mapReady, sweepData, setGeo]);

  // Scan Targets visualization
  useEffect(() => {
    if (!mapReady || !mapRef.current || !scanTargets) return;
    const map = mapRef.current;
    
    const features = scanTargets.map(t => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [t.lng, t.lat] },
      properties: { ...t }
    }));
    
    const src = map.getSource('scan-targets') as maplibregl.GeoJSONSource;
    if (src) src.setData({ type: 'FeatureCollection', features });
  }, [scanTargets, mapReady]);

  // Address-intel overlay — pin, radius ring, nearby surveillance markers, and sightlines from
  // each camera/ALPR/speed device to the pin ("what can see this spot"). Empty when no dossier.
  useEffect(() => {
    if (!mapReady) return;
    const o = dossierOverlay;
    const center = o?.center;
    if (!center) {
      setDossierGeoBatch({ 'dossier-pin': [], 'dossier-radius': [], 'dossier-nearby': [], 'dossier-sightlines': [] });
      return;
    }
    const { lat, lng } = center;
    const nearby = o?.nearby ?? [];
    setDossierGeoBatch({
      'dossier-pin': [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { role: 'pin' } }],
      'dossier-radius': o.radiusM > 0
        ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePolygon(lat, lng, o.radiusM)] }, properties: {} }]
        : [],
      'dossier-nearby': nearby.map((nbr) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [nbr.lng, nbr.lat] },
        properties: { kind: nbr.kind, name: nbr.name, distanceM: nbr.distanceM, osmUrl: nbr.osmUrl },
      })),
      'dossier-sightlines': nearby.filter((nbr) => nbr.kind !== 'police').map((nbr) => ({
        type: 'Feature', geometry: { type: 'LineString', coordinates: [[nbr.lng, nbr.lat], [lng, lat]] }, properties: { kind: nbr.kind },
      })),
    });
  }, [mapReady, dossierOverlay, setDossierGeoBatch]);

  // Live user position (GPS) — dot + accuracy ring. Empty sources when tracking is off.
  useEffect(() => {
    if (!mapReady) return;
    if (!userPosition) {
      setGeoBatch({ 'user-position': [], 'user-accuracy': [] });
      return;
    }
    const { lat, lng, accuracy } = userPosition;
    setGeoBatch({
      'user-position': [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
      'user-accuracy': accuracy && accuracy > 0
        ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circlePolygon(lat, lng, Math.min(accuracy, 5000))] }, properties: {} }]
        : [],
    });
  }, [mapReady, userPosition, setGeoBatch]);

  // Route-exposure overlay — route line, surveillance corridor fill, and the cameras/ALPR/police
  // along it. Empty sources when no route dossier is active.
  useEffect(() => {
    if (!mapReady) return;
    const o = routeOverlay;
    const line = o?.line ?? [];
    if (line.length < 2) {
      setGeoBatch({ 'route-line': [], 'route-corridor': [], 'route-surveil': [] });
      return;
    }
    setGeoBatch({
      'route-line': [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }],
      'route-corridor': o?.corridor && o.corridor.length >= 4
        ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [o.corridor] }, properties: {} }]
        : [],
      'route-surveil': (o?.surveil ?? []).map((it) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
        properties: { kind: it.kind, name: it.name, distanceM: it.distanceM, osmUrl: it.osmUrl },
      })),
    });
  }, [mapReady, routeOverlay, setGeoBatch]);

  // Fly-to. `zoom` is honored when provided (workspace restore / view presets); otherwise
  // we default to 8 for a generic "fly here" nudge. Gated on mapReady so workspace restore
  // that fires mid-load still lands once the map is interactive.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !flyToLocation) return;
    mapRef.current.flyTo({
      center: [flyToLocation.lng, flyToLocation.lat],
      zoom: flyToLocation.zoom ?? 8,
      duration: 2000,
    });
  }, [mapReady, flyToLocation]);

  // Dynamic projection switching (lightweight — no terrain DEM)
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    try {
      (map as any).setProjection({ type: projection });
      if (projection === 'globe') {
        map.easeTo({ pitch: 20, duration: 1200 });
        try {
          (map as any).setSky({
            'sky-color': '#04040A',
            'sky-horizon-blend': 0.5,
            'horizon-color': '#0a0a1a',
            'horizon-fog-blend': 0.3,
            'fog-color': '#04040A',
            'fog-ground-blend': 0.9,
          });
        } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); }
      } else {
        map.easeTo({ pitch: 0, duration: 800 });
      }
    } catch (e) {
      console.warn('Projection switch failed:', e);
    }
  }, [mapReady, projection]);

  // Satellite / Dark style switching
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (mapStyle === prevStyleRef.current) return;
    prevStyleRef.current = mapStyle;
    const map = mapRef.current;

    try {
      if (mapStyle !== 'dark') {
        // Add satellite raster tiles
        if (!map.getSource('satellite-tiles')) {
          map.addSource('satellite-tiles', {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 18,
          });
          map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite-tiles', paint: { 'raster-opacity': 0.85 } }, 'day-night-fill');
        } else {
          map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
      } else {
        if (map.getLayer('satellite-layer')) {
          map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
      }
    } catch (e) {
      console.warn('Style switch failed:', e);
    }
  }, [mapReady, mapStyle]);

  return <div ref={containerRef} className="absolute inset-0 w-full h-full" />;
}

export default memo(OsirisMap);
