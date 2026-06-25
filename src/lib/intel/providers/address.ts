// Address intel provider — the first real on-the-go provider.
//
// gather (deterministic, parallel, cited): geocode → nearby surveillance/ALPR/police within a
// radius (one Overpass call, distance-filtered) → occupant/business via Firecrawl search →
// nearest Mapillary street-level photos. synthesize: one LLM call frames the location's
// surveillance exposure. No static DB — everything is compiled at request time.

import type {
  IntelProvider, GatherResult, SynthResult, EntityRef, ProviderCtx,
  EntityNode, EntityLink, Citation, Fact, Signal, MediaItem, Privacy,
} from '@/lib/intel/types';
import { geocode, reverseGeocode, formatAddress, type GeoResult } from '@/lib/geocode';
import { haversineMeters, pointBbox } from '@/lib/geo';
import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DEFAULT_RADIUS_M = 400;
const MAX_NEARBY = 40;
const MAX_GRAPH_NEARBY = 12;
const MAX_PHOTOS = 8;
const PHOTO_BBOX_M = 150;
const OVERPASS_TIMEOUT_MS = 25_000;
const MAPILLARY_TIMEOUT_MS = 8_000;
const SEARCH_COUNT = 4;

type NearbyKind = 'camera' | 'alpr' | 'speed' | 'police';
interface NearbyItem {
  id: string;
  kind: NearbyKind;
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
  operator?: string;
  osmUrl: string;
}

interface OverpassNode {
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

function classify(tags: Record<string, string>): NearbyKind {
  if (tags.amenity === 'police') return 'police';
  if (tags.highway === 'speed_camera') return 'speed';
  if (tags['surveillance:type'] === 'ALPR' || tags['camera:type'] === 'ALPR') return 'alpr';
  return 'camera';
}

const KIND_LABEL: Record<NearbyKind, string> = { camera: 'CCTV camera', alpr: 'ALPR camera', speed: 'speed camera', police: 'police station' };

async function fetchNearby(lat: number, lng: number, radiusM: number, signal?: AbortSignal): Promise<NearbyItem[]> {
  const [s, w, n, e] = pointBbox(lat, lng, radiusM);
  const bbox = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:25];\n(\n` +
    `  node["man_made"="surveillance"](${bbox});\n` +
    `  node["highway"="speed_camera"](${bbox});\n` +
    `  node["amenity"="police"](${bbox});\n` +
    `);\nout body 400;`;
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'OSIRIS-map/1.0 (address intel; OpenStreetMap data)' },
    body: 'data=' + encodeURIComponent(query),
    signal: safeAbortAny([signal, safeAbortTimeout(OVERPASS_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    await releaseResponseBody(res);
    throw new Error(`Overpass ${res.status}`);
  }
  const data = await res.json();
  const nodes: OverpassNode[] = Array.isArray(data?.elements) ? data.elements : [];
  return nodes
    .filter((el) => typeof el.lat === 'number' && typeof el.lon === 'number')
    .map((el): NearbyItem => {
      const tags = el.tags || {};
      const kind = classify(tags);
      return {
        id: `osm-${el.id}`,
        kind,
        name: tags.name || tags.operator || KIND_LABEL[kind],
        lat: el.lat as number,
        lng: el.lon as number,
        distanceM: Math.round(haversineMeters(lat, lng, el.lat as number, el.lon as number)),
        operator: tags.operator || undefined,
        osmUrl: `https://www.openstreetmap.org/node/${el.id}`,
      };
    })
    .filter((it) => it.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_NEARBY);
}

async function fetchPhotos(lat: number, lng: number, signal?: AbortSignal): Promise<MediaItem[]> {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token || !token.trim()) return [];
  const [s, w, n, e] = pointBbox(lat, lng, PHOTO_BBOX_M); // [south,west,north,east]
  const mapillaryBbox = `${w},${s},${e},${n}`; // Mapillary wants minLng,minLat,maxLng,maxLat
  const url =
    `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token.trim())}` +
    `&fields=id,thumb_1024_url,thumb_256_url,captured_at,compass_angle,geometry&bbox=${mapillaryBbox}&limit=20`;
  try {
    const res = await fetch(url, { signal: safeAbortAny([signal, safeAbortTimeout(MAPILLARY_TIMEOUT_MS)]) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    const items: any[] = Array.isArray(data?.data) ? data.data : [];
    return items
      .map((it): MediaItem & { _d: number } => {
        const coords = it?.geometry?.coordinates;
        const pLng = Array.isArray(coords) ? coords[0] : undefined;
        const pLat = Array.isArray(coords) ? coords[1] : undefined;
        return {
          type: 'image',
          url: it.thumb_1024_url || it.thumb_256_url,
          thumbUrl: it.thumb_256_url,
          lat: pLat,
          lng: pLng,
          capturedAt: typeof it.captured_at === 'number' ? new Date(it.captured_at).toISOString() : undefined,
          heading: typeof it.compass_angle === 'number' ? it.compass_angle : undefined,
          source: 'Mapillary',
          sourceUrl: `https://www.mapillary.com/app/?pKey=${it.id}`,
          _d: pLat != null && pLng != null ? haversineMeters(lat, lng, pLat, pLng) : 1e9,
        };
      })
      .filter((m) => typeof m.url === 'string' && m.url)
      .sort((a, b) => a._d - b._d)
      .slice(0, MAX_PHOTOS)
      .map(({ _d, ...m }) => m);
  } catch {
    return [];
  }
}

function classifyPrivacy(geo: GeoResult, occupant?: string): Privacy {
  const cat = geo.category || '';
  const business = /office|shop|commercial|company|industrial|amenity|tourism|leisure|craft/.test(cat) || !!occupant;
  const residential = /house|residential|apartments|dwelling/.test(cat) || (!business && !!geo.address.house_number);
  if (business) {
    return { tier: 'business', notice: 'Business / public-facing location. Compiled from public OSM + web sources.' };
  }
  if (residential) {
    return { tier: 'residential', notice: 'Possible residential address. Showing only public surveillance infrastructure that can observe this location — not occupant personal data.' };
  }
  return { tier: 'public', notice: 'Public location. Surveillance exposure compiled from public OpenStreetMap data.' };
}

export const addressProvider: IntelProvider = {
  kind: 'address',
  version: '1',
  canHandle: (ref) => ref.kind === 'address',

  async gather(ref, ctx): Promise<GatherResult> {
    // 1. Resolve coordinates + address details.
    let geo: GeoResult | null = null;
    if (ref.lat != null && ref.lng != null) {
      geo = (await reverseGeocode(ref.lat, ref.lng, ctx.signal)) ?? {
        lat: ref.lat, lng: ref.lng, displayName: ref.label || `${ref.lat}, ${ref.lng}`, address: {},
      };
    } else {
      geo = await geocode(ref.id, ctx.signal);
    }
    if (!geo) throw new Error('Could not geocode that address');
    const { lat, lng } = geo;
    const formatted = formatAddress(geo);
    const radiusM = DEFAULT_RADIUS_M;
    ctx.emit({ event: 'status', data: { stage: 'nearby', formatted } });

    // 2. Parallel gather — tolerate partial failure (Overpass / Firecrawl / Mapillary may be down).
    const [nearbyR, searchR, photosR] = await Promise.allSettled([
      fetchNearby(lat, lng, radiusM, ctx.signal),
      ctx.search.search(`"${formatted}"`, { count: SEARCH_COUNT, signal: ctx.signal }).catch(() => []),
      fetchPhotos(lat, lng, ctx.signal),
    ]);
    const nearby = nearbyR.status === 'fulfilled' ? nearbyR.value : [];
    const hits = searchR.status === 'fulfilled' ? searchR.value : [];
    const photos = photosR.status === 'fulfilled' ? photosR.value : [];

    const counts: Record<NearbyKind, number> = { camera: 0, alpr: 0, speed: 0, police: 0 };
    for (const it of nearby) counts[it.kind]++;
    const nearestCam = nearby.find((it) => it.kind === 'camera' || it.kind === 'alpr' || it.kind === 'speed');

    // 3. Graph: address root + postcode/country + nearest surveillance nodes (+ optional occupant).
    const rootId = `address:${lat.toFixed(5)},${lng.toFixed(5)}`;
    const nodes: EntityNode[] = [{
      id: rootId, label: formatted, type: 'address',
      properties: { lat, lng, postcode: geo.address.postcode, country: geo.address.country, category: geo.category, name: geo.name },
    }];
    const links: EntityLink[] = [];
    if (geo.address.postcode) {
      const id = `postcode:${geo.address.postcode}`;
      nodes.push({ id, label: geo.address.postcode, type: 'postcode' });
      links.push({ source: rootId, target: id, label: 'IN POSTCODE' });
    }
    if (geo.address.country) {
      const id = `country:${geo.address.country_code || geo.address.country}`;
      nodes.push({ id, label: geo.address.country, type: 'country' });
      links.push({ source: rootId, target: id, label: 'IN COUNTRY' });
    }
    for (const it of nearby.slice(0, MAX_GRAPH_NEARBY)) {
      nodes.push({
        id: it.id, label: `${it.name} (${it.distanceM}m)`, type: it.kind === 'police' ? 'police' : 'camera',
        properties: { lat: it.lat, lng: it.lng, distanceM: it.distanceM, kind: it.kind, operator: it.operator },
      });
      links.push({ source: rootId, target: it.id, label: 'NEAR' });
    }

    // Optional occupant resolution — only for clearly commercial POIs with a name.
    let occupant: string | undefined;
    if (geo.name && /office|shop|commercial|company/.test(geo.category || '')) {
      occupant = geo.name;
      const cid = `company:${occupant}`;
      nodes.push({ id: cid, label: occupant, type: 'company', properties: { source: 'OSM POI name' } });
      links.push({ source: rootId, target: cid, label: 'OCCUPIED BY' });
      const sub = await ctx.resolve('company', occupant).catch(() => null);
      if (sub && sub.nodes.length) {
        nodes.push(...sub.nodes);
        links.push(...sub.links);
      }
    }

    // 4. Signals (the only thing the LLM sees), citations, facts, geometry, actions.
    const citations: Citation[] = hits.map((h, i) => ({
      id: `web-${i + 1}`, title: h.title, url: h.url, source: 'web', fetchedAt: new Date().toISOString(),
    }));
    const webContext = hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.snippet || ''} (${h.url})`).join('\n');

    const signals: Signal[] = [
      { key: 'address', label: 'Address', value: formatted, source: 'nominatim' },
      ...(geo.address.postcode ? [{ key: 'postcode', label: 'Postcode', value: geo.address.postcode, source: 'nominatim' }] : []),
      { key: 'admin', label: 'Area', value: [geo.address.city || geo.address.town || geo.address.village, geo.address.state, geo.address.country].filter(Boolean).join(', '), source: 'nominatim' },
      ...(geo.category ? [{ key: 'category', label: 'OSM category', value: geo.category, source: 'osm' }] : []),
      { key: 'exposure', label: `Surveillance within ${radiusM}m`, value: `${counts.camera} CCTV, ${counts.alpr} ALPR, ${counts.speed} speed, ${counts.police} police`, source: 'overpass' },
      ...(nearestCam ? [{ key: 'nearest', label: 'Nearest camera', value: `${nearestCam.name} at ${nearestCam.distanceM}m`, source: 'overpass' }] : []),
      ...(photos.length ? [{ key: 'photos', label: 'Street-level photos', value: `${photos.length} (Mapillary)`, source: 'mapillary' }] : []),
      ...(webContext ? [{ key: 'web', label: 'Web results', value: webContext, source: 'web' }] : []),
    ];

    const facts: Fact[] = [
      { label: 'Address', value: formatted, confidence: 'high', source: 'OSM/Nominatim' },
      ...(geo.address.postcode ? [{ label: 'Postcode', value: geo.address.postcode, confidence: 'high' as const, source: 'OSM' }] : []),
      { label: 'CCTV within range', value: String(counts.camera), confidence: 'med', source: 'OSM/Overpass' },
      { label: 'ALPR within range', value: String(counts.alpr), confidence: 'med', source: 'OSM/Overpass' },
      { label: 'Police within range', value: String(counts.police), confidence: 'med', source: 'OSM/Overpass' },
      ...(nearestCam ? [{ label: 'Nearest camera', value: `${nearestCam.distanceM} m`, confidence: 'med' as const, source: 'OSM/Overpass' }] : []),
    ];

    const geometry = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { role: 'pin', name: formatted } },
        ...nearby.map((it) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [it.lng, it.lat] },
          properties: { role: 'nearby', kind: it.kind, name: it.name, distanceM: it.distanceM, osmUrl: it.osmUrl },
        })),
      ],
    };

    return {
      signals,
      citations,
      graph: { nodes, links },
      facts,
      media: photos,
      geometry,
      privacy: classifyPrivacy(geo, occupant),
      actions: [
        { type: 'flyTo', lat, lng, zoom: 16 },
        { type: 'drawRadius', lat, lng, radiusM },
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
            'You are OSIRIS, an OSINT counter-surveillance analyst. You are given structured public facts about a LOCATION (never a person). ' +
            'Write a concise markdown assessment (4-8 sentences) covering: what the location is / who occupies it (from web results, clearly hedged), and its SURVEILLANCE EXPOSURE — what cameras, ALPR readers, and police can observe it. ' +
            'Use ONLY the provided facts. Never invent occupants, names, or devices. Frame this as public-infrastructure awareness ("what can observe this spot").',
        },
        { role: 'user', content: `LOCATION FACTS:\n${factsBlock}` },
      ],
      { signal: ctx.signal },
    );

    const exposure = gathered.signals.find((s) => s.key === 'exposure')?.value as string | undefined;
    const summary = result.backend === 'deterministic'
      ? `${gathered.signals.find((s) => s.key === 'address')?.value ?? ref.id} — ${exposure ?? 'surveillance data unavailable'}.`
      : result.text;

    const sections: SynthResult['sections'] = [];
    if (result.backend !== 'deterministic') {
      sections.push({ id: 'assessment', title: 'Assessment', body: result.text });
    }
    if (exposure) {
      sections.push({ id: 'exposure', title: 'Surveillance Exposure', body: exposure, facts: gathered.facts?.filter((f) => /within range|Nearest/.test(f.label)) });
    }
    const webCitations = gathered.citations.filter((c) => c.source === 'web');
    if (webCitations.length) {
      sections.push({ id: 'web', title: 'Web Results', body: webCitations.map((c) => `- [${c.title}](${c.url})`).join('\n'), citationIds: webCitations.map((c) => c.id) });
    }

    return { summary, sections, facts: [], privacy: gathered.privacy };
  },
};
