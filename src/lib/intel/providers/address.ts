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
import type { BBox } from '@/lib/overpass';
import { curatedPoliceInBoxes, isWithinCuratedCoverage } from '@/lib/police/curated';
import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';
import { findPanorama } from '@/lib/streetview/scrape';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DEFAULT_RADIUS_M = 400;
// Police stations are sparse — scan them further out than cameras so the nearest
// station (curated or OSM) reliably surfaces in the dossier.
const POLICE_RADIUS_M = 2000;
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

function isAlprTag(value?: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'alpr';
}

function classify(tags: Record<string, string>): NearbyKind {
  if (tags.amenity === 'police') return 'police';
  if (tags.highway === 'speed_camera') return 'speed';
  if (isAlprTag(tags['surveillance:type']) || isAlprTag(tags['camera:type'])) return 'alpr';
  return 'camera';
}

const KIND_LABEL: Record<NearbyKind, string> = { camera: 'CCTV camera', alpr: 'ALPR camera', speed: 'speed camera', police: 'police station' };

async function fetchNearby(lat: number, lng: number, radiusM: number, signal?: AbortSignal): Promise<NearbyItem[]> {
  // Query the larger of the two radii so police out to POLICE_RADIUS_M are captured;
  // cameras are filtered back to `radiusM` below.
  const queryRadiusM = Math.max(radiusM, POLICE_RADIUS_M);
  const [s, w, n, e] = pointBbox(lat, lng, queryRadiusM);
  const box: BBox = [s, w, n, e];
  const bbox = `${s},${w},${n},${e}`;

  // Curated police stations physically within the bbox — computed independently of
  // Overpass so owned/manually-added stations still surface when Overpass is slow,
  // rate-limited, or down (radius-filtered below).
  const curated: NearbyItem[] = curatedPoliceInBoxes([box]).map((st) => ({
    id: st.id,
    kind: 'police',
    name: st.name,
    lat: st.lat,
    lng: st.lng,
    distanceM: Math.round(haversineMeters(lat, lng, st.lat, st.lng)),
    operator: st.operator || undefined,
    osmUrl: st.osm_url || '',
  }));

  // Live OSM cameras/ALPR/police — tolerate failure (Overpass may be throttled);
  // a miss just means curated-only results this call, never an empty dossier.
  let osm: NearbyItem[] = [];
  try {
    const query =
      `[out:json][timeout:25];\n(\n` +
      `  node["man_made"="surveillance"](${bbox});\n` +
      `  node["highway"="speed_camera"](${bbox});\n` +
      `  node["amenity"="police"](${bbox});\n` +
      `);\nout body 400;`;
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'HORUS-map/1.0 (address intel; OpenStreetMap data)' },
      body: 'data=' + encodeURIComponent(query),
      signal: safeAbortAny([signal, safeAbortTimeout(OVERPASS_TIMEOUT_MS)]),
    });
    if (res.ok) {
      const data = await res.json();
      const nodes: OverpassNode[] = Array.isArray(data?.elements) ? data.elements : [];
      osm = nodes
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
        // Curated police is authoritative inside its coverage — drop the OSM police there.
        .filter((it) => !(it.kind === 'police' && isWithinCuratedCoverage(it.lat, it.lng)));
    } else {
      await releaseResponseBody(res);
    }
  } catch {
    /* Overpass unavailable — curated police still ship. */
  }

  return [...osm, ...curated]
    .filter((it) => it.distanceM <= (it.kind === 'police' ? POLICE_RADIUS_M : radiusM))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_NEARBY);
}

const COMMONS_RADIUS_M = 500;
const COMMONS_TIMEOUT_MS = 8_000;

// Keyless street/place imagery: geotagged photos from Wikimedia Commons (File namespace) near
// the point. Used when no MAPILLARY_TOKEN is configured, so address dossiers show real photos
// out of the box. Strong for landmarks/public buildings; intentionally sparse for pure-residential.
async function fetchCommonsPhotos(lat: number, lng: number, signal?: AbortSignal): Promise<MediaItem[]> {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggsnamespace=6&ggscoord=${lat}%7C${lng}&ggsradius=${COMMONS_RADIUS_M}&ggslimit=${MAX_PHOTOS * 2}` +
    `&prop=imageinfo&iiprop=url%7Cthumburl%7Ctimestamp%7Ccoordinates&iiurlwidth=1024`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HORUS-map/1.0 (address intel; Wikimedia Commons)', Accept: 'application/json' },
      signal: safeAbortAny([signal, safeAbortTimeout(COMMONS_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    const pages: any[] = data?.query?.pages ? Object.values(data.query.pages) : [];
    return pages
      .map((p): (MediaItem & { _d: number }) | null => {
        const info = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
        if (!info) return null;
        const thumb = info.thumburl as string | undefined;
        const full = info.url as string | undefined;
        if (!thumb && !full) return null;
        const c = info.coordinates?.[0];
        const pLat = typeof c?.lat === 'number' ? c.lat : undefined;
        const pLng = typeof c?.lon === 'number' ? c.lon : undefined;
        return {
          type: 'image',
          url: full || thumb!,
          thumbUrl: thumb,
          lat: pLat,
          lng: pLng,
          capturedAt: typeof info.timestamp === 'string' ? info.timestamp : undefined,
          source: 'Wikimedia Commons',
          sourceUrl: typeof p.title === 'string' ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}` : undefined,
          _d: pLat != null && pLng != null ? haversineMeters(lat, lng, pLat, pLng) : 1e9,
        };
      })
      .filter((m): m is MediaItem & { _d: number } => m !== null)
      .sort((a, b) => a._d - b._d)
      .slice(0, MAX_PHOTOS)
      .map(({ _d, ...m }) => m);
  } catch {
    return [];
  }
}

const WIKI_TIMEOUT_MS = 8_000;
const WIKI_RADIUS_M = 800;

interface WebLead { title: string; url: string; snippet: string; source: string; }

// Reliable keyless leads: notable places near the point from Wikipedia geosearch (+ intro
// extracts). Unlike scraped SERPs (which bot-challenge datacenter/undici clients), this is a
// stable public API and gives real, sourced context about what's at/around a location.
async function fetchWikiNearby(lat: number, lng: number, signal?: AbortSignal): Promise<WebLead[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=${WIKI_RADIUS_M}&ggslimit=6` +
    `&prop=extracts%7Cinfo&exintro&explaintext&exchars=400&inprop=url`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HORUS-map/1.0 (address intel; Wikipedia)', Accept: 'application/json' },
      signal: safeAbortAny([signal, safeAbortTimeout(WIKI_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    const pages: any[] = data?.query?.pages ? Object.values(data.query.pages) : [];
    return pages
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((p): WebLead => ({
        title: p.title,
        url: p.fullurl || `https://en.wikipedia.org/?curid=${p.pageid}`,
        snippet: typeof p.extract === 'string' ? p.extract.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
        source: 'wikipedia',
      }))
      .filter((h) => h.title && h.url);
  } catch {
    return [];
  }
}

// Initial great-circle bearing (degrees, 0=N) from point A to point B — used to aim the Street
// View camera from the nearest panorama AT the building.
function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const d2r = Math.PI / 180;
  const φ1 = aLat * d2r, φ2 = bLat * d2r, Δλ = (bLng - aLng) * d2r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Building-facing street-level imagery scraped KEYLESS from Google Street View: resolve the
// nearest panorama, aim the camera FROM that panorama AT the requested building (so shots show
// the building itself, not just the general area), and return a few views. Image URLs point at
// /api/streetview, which fetches the actual thumbnails. Returns [] when there's no coverage.
async function fetchStreetViewPhotos(lat: number, lng: number, signal?: AbortSignal): Promise<MediaItem[]> {
  const pano = await findPanorama(lat, lng, 60, signal).catch(() => null);
  if (!pano) return [];

  // Face the building from the panorama; if the pano sits on the point, sweep from due north.
  const facing = haversineMeters(lat, lng, pano.lat, pano.lng) > 2
    ? bearingDeg(pano.lat, pano.lng, lat, lng)
    : 0;
  const panoUrl = `https://www.google.com/maps?q=&layer=c&cbll=${pano.lat},${pano.lng}&cbp=12,${Math.round(facing)},0,0,0`;

  // A frontal view, a zoomed/tilted-up view (tall buildings), and two oblique angles.
  const shots = [
    { heading: facing, fov: 75, pitch: 6 },
    { heading: facing, fov: 45, pitch: 18 },
    { heading: (facing - 32 + 360) % 360, fov: 80, pitch: 6 },
    { heading: (facing + 32) % 360, fov: 80, pitch: 6 },
  ].slice(0, MAX_PHOTOS);

  return shots.map((s): MediaItem => {
    const q = (w: number, h: number) =>
      `/api/streetview?panoid=${encodeURIComponent(pano.panoid)}&yaw=${Math.round(s.heading)}&fov=${s.fov}&pitch=${s.pitch}&w=${w}&h=${h}`;
    return {
      type: 'image',
      url: q(640, 480),
      thumbUrl: q(400, 300),
      lat: pano.lat,
      lng: pano.lng,
      heading: s.heading,
      capturedAt: pano.date,
      source: 'Google Street View',
      sourceUrl: panoUrl,
    };
  });
}

async function fetchMapillaryPhotos(lat: number, lng: number, token: string, signal?: AbortSignal): Promise<MediaItem[]> {
  const [s, w, n, e] = pointBbox(lat, lng, PHOTO_BBOX_M); // [south,west,north,east]
  const mapillaryBbox = `${w},${s},${e},${n}`; // Mapillary wants minLng,minLat,maxLng,maxLat
  const url =
    `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}` +
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

// Priority: Google Street View (building-facing, when GOOGLE_MAPS_API_KEY set + coverage) →
// Mapillary (if token) → keyless Wikimedia Commons (general-area landmarks).
async function fetchPhotos(lat: number, lng: number, signal?: AbortSignal): Promise<MediaItem[]> {
  const streetView = await fetchStreetViewPhotos(lat, lng, signal).catch(() => []);
  if (streetView.length) return streetView;

  const token = process.env.MAPILLARY_TOKEN;
  if (token && token.trim()) {
    const mapillary = await fetchMapillaryPhotos(lat, lng, token.trim(), signal).catch(() => []);
    if (mapillary.length) return mapillary;
  }

  return fetchCommonsPhotos(lat, lng, signal);
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

    // Build a lead-oriented query. A quoted full address usually returns nothing; search the
    // occupant/business name + locality when this is a commercial POI, else the plain address.
    const locality = [geo.address.city || geo.address.town || geo.address.village, geo.address.state]
      .filter(Boolean).join(' ');
    const occupantName =
      geo.name && /office|shop|commercial|company|amenity|tourism|leisure|craft|building|industrial/.test(geo.category || '')
        ? geo.name
        : '';
    const searchQuery = occupantName ? `${occupantName} ${locality}`.trim() : formatted;

    // 2. Parallel gather — tolerate partial failure (Overpass / search / imagery may be down).
    // Leads come from Wikipedia geosearch (reliable, keyless) plus a best-effort general web
    // search (DuckDuckGo, which frequently bot-challenges server clients — treated as a bonus).
    const [nearbyR, searchR, wikiR, photosR] = await Promise.allSettled([
      fetchNearby(lat, lng, radiusM, ctx.signal),
      ctx.search.search(searchQuery, { count: SEARCH_COUNT, signal: ctx.signal }).catch(() => []),
      fetchWikiNearby(lat, lng, ctx.signal),
      fetchPhotos(lat, lng, ctx.signal),
    ]);
    const nearby = nearbyR.status === 'fulfilled' ? nearbyR.value : [];
    const webHits = searchR.status === 'fulfilled' ? searchR.value : [];
    const wikiHits = wikiR.status === 'fulfilled' ? wikiR.value : [];
    const photos = photosR.status === 'fulfilled' ? photosR.value : [];

    // Merge leads (Wikipedia first — sourced + reliable), de-duped by URL, capped.
    const hits: Array<{ title: string; url: string; snippet?: string }> = [];
    const seenUrls = new Set<string>();
    for (const h of [...wikiHits, ...webHits]) {
      if (!h.url || seenUrls.has(h.url)) continue;
      seenUrls.add(h.url);
      hits.push(h);
      if (hits.length >= SEARCH_COUNT + 2) break;
    }

    // Pull the top lead's page text so the LLM gets real content (not just a snippet) → less
    // "useless" prose. Best-effort and SSRF-guarded by the search provider's fetchPage.
    let leadExcerpt = '';
    if (hits.length) {
      const page = await ctx.fetchPage(hits[0].url).catch(() => null);
      if (page) leadExcerpt = page.replace(/\s+/g, ' ').trim().slice(0, 1200);
    }

    const counts: Record<NearbyKind, number> = { camera: 0, alpr: 0, speed: 0, police: 0 };
    for (const it of nearby) counts[it.kind]++;
    const nearestCam = nearby.find((it) => it.kind === 'camera' || it.kind === 'alpr' || it.kind === 'speed');
    const nearestPolice = nearby.find((it) => it.kind === 'police');

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
    const webContext = [
      hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.snippet || ''} (${h.url})`).join('\n'),
      leadExcerpt ? `\nTOP RESULT EXCERPT (${hits[0].url}):\n${leadExcerpt}` : '',
    ].join('').trim();

    const signals: Signal[] = [
      { key: 'address', label: 'Address', value: formatted, source: 'nominatim' },
      ...(geo.address.postcode ? [{ key: 'postcode', label: 'Postcode', value: geo.address.postcode, source: 'nominatim' }] : []),
      { key: 'admin', label: 'Area', value: [geo.address.city || geo.address.town || geo.address.village, geo.address.state, geo.address.country].filter(Boolean).join(', '), source: 'nominatim' },
      ...(geo.category ? [{ key: 'category', label: 'OSM category', value: geo.category, source: 'osm' }] : []),
      { key: 'exposure', label: 'Surveillance exposure', value: `${counts.camera} CCTV, ${counts.alpr} ALPR, ${counts.speed} speed within ${radiusM}m · ${counts.police} police within ${POLICE_RADIUS_M}m`, source: 'overpass' },
      ...(nearestCam ? [{ key: 'nearest', label: 'Nearest camera', value: `${nearestCam.name} at ${nearestCam.distanceM}m`, source: 'overpass' }] : []),
      ...(nearestPolice ? [{ key: 'nearestPolice', label: 'Nearest police', value: `${nearestPolice.name} at ${nearestPolice.distanceM}m`, source: 'overpass' }] : []),
      ...(photos.length ? [{ key: 'photos', label: 'Street-level photos', value: `${photos.length} (${photos[0].source})`, source: photos[0].source }] : []),
      ...(webContext ? [{ key: 'web', label: 'Web results', value: webContext, source: 'web' }] : []),
    ];

    const facts: Fact[] = [
      { label: 'Address', value: formatted, confidence: 'high', source: 'OSM/Nominatim' },
      ...(geo.address.postcode ? [{ label: 'Postcode', value: geo.address.postcode, confidence: 'high' as const, source: 'OSM' }] : []),
      { label: `CCTV within ${radiusM}m`, value: String(counts.camera), confidence: 'med', source: 'OSM/Overpass' },
      { label: `ALPR within ${radiusM}m`, value: String(counts.alpr), confidence: 'med', source: 'OSM/Overpass' },
      { label: `Police within ${POLICE_RADIUS_M}m`, value: String(counts.police), confidence: 'med', source: 'Curated + OSM' },
      ...(nearestCam ? [{ label: 'Nearest camera', value: `${nearestCam.distanceM} m`, confidence: 'med' as const, source: 'OSM/Overpass' }] : []),
      ...(nearestPolice ? [{ label: 'Nearest police', value: `${nearestPolice.distanceM} m`, confidence: 'med' as const, source: 'Curated + OSM' }] : []),
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
            'You are HORUS, an OSINT counter-surveillance analyst. You are given structured public facts about a LOCATION (never a person). ' +
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
      sections.push({ id: 'exposure', title: 'Surveillance Exposure', body: exposure, facts: gathered.facts?.filter((f) => /within|Nearest/.test(f.label)) });
    }
    const webCitations = gathered.citations.filter((c) => c.source === 'web');
    if (webCitations.length) {
      sections.push({ id: 'web', title: 'Web Results', body: webCitations.map((c) => `- [${c.title}](${c.url})`).join('\n'), citationIds: webCitations.map((c) => c.id) });
    }

    return { summary, sections, facts: [], privacy: gathered.privacy };
  },
};
