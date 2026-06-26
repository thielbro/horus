// Route intel provider — surveillance exposure along a driving route.
//
// gather (deterministic, parallel, cited): resolve start/end → OSRM polyline → corridor bbox
// (tiled under the Overpass 25° cap) → one Overpass call per tile for surveillance/ALPR/police
// → keep only devices within W metres of the line (geo.pointToLineMeters), ordered start→end.
// synthesize: one LLM call frames the exposure (counts by type, densest segment, ALPR
// chokepoints). No static DB — the whole corridor is compiled at request time.

import type {
  IntelProvider, GatherResult, SynthResult, EntityRef, ProviderCtx,
  EntityNode, EntityLink, Fact, Signal,
} from '@/lib/intel/types';
import { geocode, type GeoResult } from '@/lib/geocode';
import { haversineMeters, bboxOfPoints, tileBbox, bufferPolygon, projectPointOnLine } from '@/lib/geo';
import type { BBox } from '@/lib/overpass';
import { curatedPoliceInBoxes, isWithinCuratedCoverage } from '@/lib/police/curated';
import { routeBetween, type RoutePoint } from '@/lib/routing';
import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const CORRIDOR_W_M = 150;         // keep devices within this distance of the route line
const CORRIDOR_PAD_M = 200;       // bbox padding around the route before tiling
const MAX_BBOX_AREA_DEG = 24;     // just under the Overpass 25° cap
const MAX_TILES = 16;
const MAX_NEARBY = 80;
const MAX_GRAPH_NEARBY = 12;
const SEGMENT_BUCKET_M = 1000;    // bucket size for "densest segment" detection
const OVERPASS_TIMEOUT_MS = 25_000;

type SurveilKind = 'camera' | 'alpr' | 'speed' | 'police';
interface SurveilItem {
  id: string;
  kind: SurveilKind;
  name: string;
  lat: number;
  lng: number;
  /** Perpendicular distance from the route line, metres. */
  offsetM: number;
  /** Distance travelled along the route to the nearest projection, metres. */
  alongM: number;
  operator?: string;
  osmUrl: string;
}

interface OverpassNode {
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

function isAlprTag(value?: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'alpr';
}

function classify(tags: Record<string, string>): SurveilKind {
  if (tags.amenity === 'police') return 'police';
  if (tags.highway === 'speed_camera') return 'speed';
  if (isAlprTag(tags['surveillance:type']) || isAlprTag(tags['camera:type'])) return 'alpr';
  return 'camera';
}

const KIND_LABEL: Record<SurveilKind, string> = { camera: 'CCTV camera', alpr: 'ALPR camera', speed: 'speed camera', police: 'police station' };

/** One Overpass call for a single bbox tile; returns raw surveillance nodes. */
async function fetchTile(bbox: BBox, signal?: AbortSignal): Promise<OverpassNode[]> {
  const [s, w, n, e] = bbox;
  const b = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:25];\n(\n` +
    `  node["man_made"="surveillance"](${b});\n` +
    `  node["highway"="speed_camera"](${b});\n` +
    `  node["amenity"="police"](${b});\n` +
    `);\nout body 2000;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'HORUS-map/1.0 (route exposure; OpenStreetMap data)' },
    body: 'data=' + encodeURIComponent(query),
    signal: safeAbortAny([signal, safeAbortTimeout(OVERPASS_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    await releaseResponseBody(res);
    throw new Error(`Overpass ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.elements) ? data.elements : [];
}

/** Resolve one endpoint string — either "lat,lng" or a free-text place to geocode. */
async function resolveEndpoint(raw: string, signal?: AbortSignal): Promise<{ point: RoutePoint; label: string } | null> {
  const text = raw.trim();
  if (!text) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { point: { lat, lng }, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
  const geo: GeoResult | null = await geocode(text, signal);
  if (!geo) return null;
  return { point: { lat: geo.lat, lng: geo.lng }, label: geo.displayName ? geo.displayName.split(',').slice(0, 3).join(',') : text };
}

function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
function fmtDur(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const routeProvider: IntelProvider = {
  kind: 'route',
  version: '1',
  canHandle: (ref) => ref.kind === 'route',

  async gather(ref, ctx): Promise<GatherResult> {
    // 1. Parse "<start>|<end>" — each side a "lat,lng" pair or a place to geocode.
    const sep = ref.id.indexOf('|');
    if (sep < 0) throw new Error('Route needs a start and end — use "start|end"');
    const [startR, endR] = await Promise.all([
      resolveEndpoint(ref.id.slice(0, sep), ctx.signal),
      resolveEndpoint(ref.id.slice(sep + 1), ctx.signal),
    ]);
    if (!startR) throw new Error('Could not resolve the start location');
    if (!endR) throw new Error('Could not resolve the end location');
    ctx.emit({ event: 'status', data: { stage: 'routing', from: startR.label, to: endR.label } });

    // 2. Route polyline.
    const route = await routeBetween(startR.point, endR.point, ctx.signal);
    if (!route) throw new Error('No driving route found between those points');
    const line = route.coordinates;
    ctx.emit({ event: 'status', data: { stage: 'corridor', distance: route.distance } });

    // 3. Corridor bbox → tiles under the Overpass area cap → parallel Overpass, tolerate failures.
    const corridorBbox = bboxOfPoints(line, CORRIDOR_PAD_M);
    const tiles = corridorBbox ? tileBbox(corridorBbox, MAX_BBOX_AREA_DEG, MAX_TILES) : [];
    const tileResults = await Promise.allSettled(tiles.map((t) => fetchTile(t, ctx.signal)));
    const seen = new Set<number>();
    const rawNodes: OverpassNode[] = [];
    for (const r of tileResults) {
      if (r.status !== 'fulfilled') continue;
      for (const el of r.value) {
        if (typeof el.id !== 'number' || seen.has(el.id)) continue;
        seen.add(el.id);
        rawNodes.push(el);
      }
    }

    // 4. Keep devices within the corridor, tag with offset/along, order start→end.
    const osmSurveil = rawNodes
      .filter((el) => typeof el.lat === 'number' && typeof el.lon === 'number')
      .map((el): SurveilItem | null => {
        const lat = el.lat as number;
        const lng = el.lon as number;
        const { perpM, alongM } = projectPointOnLine(lat, lng, line);
        if (perpM > CORRIDOR_W_M) return null;
        const tags = el.tags || {};
        const kind = classify(tags);
        // Curated police is authoritative inside its coverage — drop OSM police there.
        if (kind === 'police' && isWithinCuratedCoverage(lat, lng)) return null;
        return {
          id: `osm-${el.id}`, kind,
          name: tags.name || tags.operator || KIND_LABEL[kind],
          lat, lng,
          offsetM: Math.round(perpM),
          alongM: Math.round(alongM),
          operator: tags.operator || undefined,
          osmUrl: `https://www.openstreetmap.org/node/${el.id}`,
        };
      })
      .filter((it): it is SurveilItem => it !== null);

    // Curated police within the corridor tiles, projected onto the route line.
    const curatedSurveil = curatedPoliceInBoxes(tiles)
      .map((st): SurveilItem | null => {
        const { perpM, alongM } = projectPointOnLine(st.lat, st.lng, line);
        if (perpM > CORRIDOR_W_M) return null;
        return {
          id: st.id, kind: 'police',
          name: st.name,
          lat: st.lat, lng: st.lng,
          offsetM: Math.round(perpM),
          alongM: Math.round(alongM),
          operator: st.operator || undefined,
          osmUrl: st.osm_url || '',
        };
      })
      .filter((it): it is SurveilItem => it !== null);

    const surveil: SurveilItem[] = [...osmSurveil, ...curatedSurveil]
      .sort((a, b) => a.alongM - b.alongM)
      .slice(0, MAX_NEARBY);

    const counts: Record<SurveilKind, number> = { camera: 0, alpr: 0, speed: 0, police: 0 };
    for (const it of surveil) counts[it.kind]++;

    // Densest ~1km segment (by count of camera/alpr/speed devices).
    const buckets = new Map<number, number>();
    for (const it of surveil) {
      if (it.kind === 'police') continue;
      const b = Math.floor(it.alongM / SEGMENT_BUCKET_M);
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    let densest: { from: number; count: number } | null = null;
    for (const [b, count] of buckets) {
      if (!densest || count > densest.count) densest = { from: b * SEGMENT_BUCKET_M, count };
    }
    const alprPoints = surveil.filter((it) => it.kind === 'alpr');

    // 5. Graph: route root → start/end → densest surveillance nodes.
    const rootId = `route:${startR.point.lat.toFixed(4)},${startR.point.lng.toFixed(4)}->${endR.point.lat.toFixed(4)},${endR.point.lng.toFixed(4)}`;
    const startId = `place:${startR.point.lat.toFixed(5)},${startR.point.lng.toFixed(5)}`;
    const endId = `place:${endR.point.lat.toFixed(5)},${endR.point.lng.toFixed(5)}`;
    const nodes: EntityNode[] = [
      { id: rootId, label: `${startR.label} → ${endR.label}`, type: 'route', properties: { distanceM: route.distance, durationS: route.duration } },
      { id: startId, label: startR.label, type: 'address', properties: { lat: startR.point.lat, lng: startR.point.lng, role: 'start' } },
      { id: endId, label: endR.label, type: 'address', properties: { lat: endR.point.lat, lng: endR.point.lng, role: 'end' } },
    ];
    const links: EntityLink[] = [
      { source: rootId, target: startId, label: 'STARTS AT' },
      { source: rootId, target: endId, label: 'ENDS AT' },
    ];
    for (const it of surveil.slice(0, MAX_GRAPH_NEARBY)) {
      nodes.push({
        id: it.id, label: `${it.name} (${it.offsetM}m)`, type: it.kind === 'police' ? 'police' : 'camera',
        properties: { lat: it.lat, lng: it.lng, offsetM: it.offsetM, alongM: it.alongM, kind: it.kind, operator: it.operator },
      });
      links.push({ source: rootId, target: it.id, label: 'PASSES' });
    }

    // 6. Signals (the only thing the LLM sees), facts, geometry.
    const densestText = densest
      ? `${densest.count} devices between ${fmtKm(densest.from)} and ${fmtKm(densest.from + SEGMENT_BUCKET_M)} along the route`
      : 'no notable cluster';
    const signals: Signal[] = [
      { key: 'route', label: 'Route', value: `${startR.label} → ${endR.label}`, source: 'osrm' },
      { key: 'distance', label: 'Distance', value: fmtKm(route.distance), source: 'osrm' },
      { key: 'duration', label: 'Est. drive time', value: fmtDur(route.duration), source: 'osrm' },
      { key: 'exposure', label: `Surveillance within ${CORRIDOR_W_M}m of route`, value: `${counts.camera} CCTV, ${counts.alpr} ALPR, ${counts.speed} speed, ${counts.police} police`, source: 'overpass' },
      { key: 'densest', label: 'Densest segment', value: densestText, source: 'overpass' },
      ...(alprPoints.length ? [{ key: 'alpr', label: 'ALPR chokepoints', value: `${alprPoints.length} reader(s); first at ${fmtKm(alprPoints[0].alongM)}`, source: 'overpass' }] : []),
    ];

    const facts: Fact[] = [
      { label: 'Distance', value: fmtKm(route.distance), confidence: 'high', source: 'OSRM' },
      { label: 'Drive time', value: fmtDur(route.duration), confidence: 'med', source: 'OSRM' },
      { label: 'CCTV on route', value: String(counts.camera), confidence: 'med', source: 'OSM/Overpass' },
      { label: 'ALPR on route', value: String(counts.alpr), confidence: 'med', source: 'OSM/Overpass' },
      { label: 'Speed cameras', value: String(counts.speed), confidence: 'med', source: 'OSM/Overpass' },
      { label: 'Police on route', value: String(counts.police), confidence: 'med', source: 'Curated + OSM' },
    ];

    const corridorRing = bufferPolygon(line, CORRIDOR_W_M);
    const geometry = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { role: 'route', distanceM: route.distance, durationS: route.duration } },
        ...(corridorRing ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [corridorRing] }, properties: { role: 'corridor' } }] : []),
        ...surveil.map((it) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
          properties: { role: 'surveil', kind: it.kind, name: it.name, distanceM: it.offsetM, alongM: it.alongM, osmUrl: it.osmUrl },
        })),
      ],
    };

    // Fly to the route midpoint so the whole corridor is roughly framed.
    const mid = line[Math.floor(line.length / 2)];

    return {
      signals,
      citations: [],
      graph: { nodes, links },
      facts,
      geometry,
      privacy: { tier: 'public', notice: 'Public route. Surveillance exposure compiled from public OpenStreetMap data — what cameras, ALPR readers, and police can observe along the way.' },
      actions: [
        { type: 'flyTo', lat: mid[1], lng: mid[0], zoom: route.distance > 20_000 ? 11 : 13 },
        { type: 'drawRoute', geometry },
      ],
    };
  },

  async synthesize(ref, gathered, ctx): Promise<SynthResult> {
    const factsBlock = gathered.signals.map((s) => `- ${s.label}: ${typeof s.value === 'string' ? s.value : JSON.stringify(s.value)}`).join('\n');
    const result = await ctx.llm.chat(
      [
        {
          role: 'system',
          content:
            'You are HORUS, an OSINT counter-surveillance analyst. You are given structured public facts about a driving ROUTE (never a person). ' +
            'Write a concise markdown SURVEILLANCE EXPOSURE briefing (4-7 sentences): the overall camera/ALPR/police load along the route, where the densest cluster is, and any ALPR chokepoints a traveller would pass. ' +
            'Use ONLY the provided facts. Never invent devices, locations, or counts. Frame this as public-infrastructure awareness ("what can observe this route").',
        },
        { role: 'user', content: `ROUTE FACTS:\n${factsBlock}` },
      ],
      { signal: ctx.signal },
    );

    const exposure = gathered.signals.find((s) => s.key === 'exposure')?.value as string | undefined;
    const routeLabel = gathered.signals.find((s) => s.key === 'route')?.value as string | undefined;
    const summary = result.backend === 'deterministic'
      ? `${routeLabel ?? ref.id} — ${exposure ?? 'surveillance data unavailable'}.`
      : result.text;

    const sections: SynthResult['sections'] = [];
    if (result.backend !== 'deterministic') {
      sections.push({ id: 'exposure-brief', title: 'Surveillance Exposure', body: result.text });
    }
    if (exposure) {
      sections.push({ id: 'exposure', title: 'Exposure Breakdown', body: exposure, facts: gathered.facts?.filter((f) => /on route|cameras/i.test(f.label)) });
    }

    return { summary, sections, facts: [], privacy: gathered.privacy };
  },
};
