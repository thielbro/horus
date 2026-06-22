import type { CctvCamera } from './types';
import { fetchWithRetry, withFallback } from './resilient';

/**
 * VICTORIA — VicRoads Transport Open Data (official, token-gated).
 *
 * Victoria does NOT publish a key-free live-camera feed: the public VicTraffic
 * site is disruptions-only, and the ~1,600 traffic cameras sit behind the
 * VicRoads WFS API, which needs a free token (email traffic_requests@vicroads.vic.gov.au).
 *
 * This fetcher is a no-op until VICROADS_API_TOKEN is set, so it costs nothing
 * in region=all until configured. Once the token is in place it pulls the camera
 * layer via WFS GetFeature (GeoJSON) and maps it to CctvCamera.
 *
 * Config (env):
 *   VICROADS_API_TOKEN       required — the AUTH token from VicRoads
 *   VICROADS_WFS_URL         optional — default below
 *   VICROADS_CAMERA_TYPENAME optional — WFS layer name (best-guess default;
 *                            adjust once verified against the live API)
 *
 * NOTE: field names below (image URL, camera name) and the exact typename are
 * provisional — they need one verification pass against a real token, since the
 * WFS schema can't be inspected without auth.
 */

const WFS_URL = process.env.VICROADS_WFS_URL || 'https://api.vicroads.vic.gov.au/vicroads/wfs';
const TYPENAME = process.env.VICROADS_CAMERA_TYPENAME || 'vicroads:traffic_camera';

interface WfsFeature {
  geometry?: { coordinates?: number[] };
  properties?: Record<string, unknown>;
}

/** Pick the first defined string from a set of candidate property keys. */
function pick(props: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = props[k] ?? props[k.toUpperCase()] ?? props[k.toLowerCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Normalize a coordinate pair to [lng, lat] regardless of WFS axis order.
 * VIC sits at lat ~ -34..-39, lng ~ 140..150, so we can tell them apart.
 */
function toLngLat(coords: number[]): [number, number] | null {
  if (!coords || coords.length < 2) return null;
  const [a, b] = coords;
  const isLat = (v: number) => v >= -44 && v <= -10;
  const isLng = (v: number) => v >= 110 && v <= 155;
  if (isLng(a) && isLat(b)) return [a, b];
  if (isLat(a) && isLng(b)) return [b, a];
  return null;
}

export async function fetchVictoriaCameras(): Promise<CctvCamera[]> {
  const token = process.env.VICROADS_API_TOKEN;
  if (!token) return []; // not configured — silent no-op

  return withFallback('au-vic', async () => {
    const url =
      `${WFS_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
      `&TYPENAMES=${encodeURIComponent(TYPENAME)}` +
      `&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&AUTH=${encodeURIComponent(token)}`;

    const res = await fetchWithRetry(url);
    const data = await res.json();
    const features: WfsFeature[] = data.features || [];

    const cameras: CctvCamera[] = [];
    for (const f of features) {
      const ll = toLngLat(f.geometry?.coordinates || []);
      const p = f.properties || {};
      if (!ll) continue;
      const feed = pick(p, ['image_url', 'imageurl', 'snapshot_url', 'snapshot', 'url', 'href', 'image']);
      if (!feed) continue;
      cameras.push({
        id: `vic-${pick(p, ['id', 'camera_id', 'objectid']) || cameras.length}`,
        lat: ll[1],
        lng: ll[0],
        name: pick(p, ['name', 'title', 'location', 'description', 'site_name']) || 'VIC Traffic Camera',
        city: pick(p, ['region', 'suburb', 'lga']) || 'Victoria',
        country: 'Australia',
        feed_url: feed,
        source: 'VicRoads',
      });
    }
    return cameras;
  });
}
