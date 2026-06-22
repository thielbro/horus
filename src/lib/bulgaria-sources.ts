/**
 * Balkans-focused data sources for OSIRIS.
 * NIGGG-BAS (seismic), GDACS (EU civil protection), BG news feeds.
 */

export const BALKANS_BBOX = {
  minLat: 39.5,
  maxLat: 46.5,
  minLng: 19.5,
  maxLng: 30.5,
};

export const BULGARIA_BBOX = {
  minLat: 41.2,
  maxLat: 44.5,
  minLng: 22.0,
  maxLng: 29.0,
};

export const DEFAULT_MAP_CENTER: [number, number] = [25.484, 42.698]; // Sofia - Balkans startup view
export const DEFAULT_MAP_ZOOM = 6.5;

export function inBbox(
  lat: number,
  lng: number,
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } = BALKANS_BBOX,
): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
}

export interface NigggEarthquake {
  id: string;
  lat: number;
  lng: number;
  depth: number;
  magnitude: number;
  place: string;
  time: number;
  url: string;
  source: 'NIGGG-BAS';
}

const MARKER_REGEX = /<marker\b([^>]*)\/>/gi;
const MARKER_ATTR_REGEX = /([\w:-]+)="([^"]*)"/g;

export function parseNigggXml(xml: string): NigggEarthquake[] {
  const events: NigggEarthquake[] = [];
  let match: RegExpExecArray | null;

  MARKER_REGEX.lastIndex = 0;
  while ((match = MARKER_REGEX.exec(xml)) !== null) {
    const attrs = match[1];
    const attrMap = new Map<string, string>();
    let attrMatch: RegExpExecArray | null;
    MARKER_ATTR_REGEX.lastIndex = 0;
    while ((attrMatch = MARKER_ATTR_REGEX.exec(attrs)) !== null) {
      attrMap.set(attrMatch[1], attrMatch[2]);
    }
    const get = (name: string) => attrMap.get(name) ?? '';

    const lat = parseFloat(get('lat'));
    const lng = parseFloat(get('lng'));
    const mag = parseFloat(get('mag') || get('magnitude') || '0');
    const depth = parseFloat(get('depth') || '0');
    const time = get('time') || get('date') || '';
    const place = get('title') || get('place') || 'Bulgaria region';

    if (isNaN(lat) || isNaN(lng)) continue;
    const parsedTime = time ? Date.parse(time) : NaN;
    const eventTime = Number.isFinite(parsedTime) ? parsedTime : Date.now();
    const id = get('id') || `niggg-${lat.toFixed(4)}-${lng.toFixed(4)}-${match.index}`;

    events.push({
      id,
      lat,
      lng,
      depth,
      magnitude: mag,
      place,
      time: eventTime,
      url: 'https://ndc.niggg.bas.bg/',
      source: 'NIGGG-BAS',
    });
  }

  return events;
}

export const BG_NEWS_FEEDS = [
  { name: 'Dnevnik', url: 'https://www.dnevnik.bg/rss/' },
  { name: 'Actualno', url: 'https://www.actualno.com/rss/actualno.xml' },
  { name: 'Mediapool', url: 'https://www.mediapool.bg/rss/' },
  { name: 'BBCEurope', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml' },
];
