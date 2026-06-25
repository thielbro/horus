import type { CctvCamera } from './types';
import { fetchWithRetry, withFallback } from './resilient';
import { fetchSurveillanceMapFoundationCameras } from './surveillance-map-foundation';

interface NswFeature {
  id?: string;
  geometry?: { coordinates?: number[] };
  properties?: { title?: string; region?: string; view?: string; href?: string };
}

/** Tidy NSW region codes like "SYD_SOUTH" into "Syd South". */
function prettyRegion(region?: string): string {
  if (!region) return 'Australia';
  return region
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Transport for NSW — Live Traffic webcams (Sydney + regional NSW).
 * Public GeoJSON feed, no key. Each liveCams feature carries a JPG snapshot href.
 */
export async function fetchAustraliaCameras(): Promise<CctvCamera[]> {
  // Retries on cold/slow loads; falls back to last-good data so NSW never blanks.
  const cameras = await withFallback('au-nsw', async () => {
    const res = await fetchWithRetry('https://www.livetraffic.com/datajson/all-feeds-web.json');
    const data: NswFeature[] = await res.json();

    return (data || [])
      .filter((f) => (f as { eventType?: string }).eventType === 'liveCams' || f.properties?.href)
      .map((cam, i): CctvCamera => {
        const [lng, lat] = cam.geometry?.coordinates || [];
        return {
          id: `nsw-${cam.id || i}`,
          lat: lat as number,
          lng: lng as number,
          name: cam.properties?.title || 'NSW Traffic Camera',
          city: prettyRegion(cam.properties?.region),
          country: 'Australia',
          feed_url: cam.properties?.href || '',
          source: 'Transport for NSW',
        };
      })
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && Boolean(c.feed_url));
  });
  return [
    ...cameras,
    ...fetchSurveillanceMapFoundationCameras('australia'),
  ];
}
