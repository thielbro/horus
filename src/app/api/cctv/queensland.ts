import type { CctvCamera } from './types';
import { fetchWithRetry, withFallback } from './resilient';

const QLD_BASE =
  'https://queensland.opendatasoft.com/api/explore/v2.1/catalog/datasets/live-traffic-cameras-gold-coast/records';

interface QldRecord {
  id?: string;
  title?: string;
  region?: string;
  href?: string;
  geo_point_2d?: { lon: number; lat: number };
}

/**
 * QLDTraffic live traffic cameras (statewide — Brisbane, Gold Coast, Cairns…).
 * Served via the Queensland OpenDataSoft platform (no API key — unlike the
 * official api.qldtraffic.qld.gov.au endpoint, which requires registration).
 * ~141 cameras with JPG snapshots refreshed hourly.
 */
export async function fetchQueenslandCameras(): Promise<CctvCamera[]> {
  return withFallback('au-qld', async () => {
    const cameras: CctvCamera[] = [];
    // OpenDataSoft caps limit at 100; page until a short/empty result.
    for (let offset = 0; offset < 1000; offset += 100) {
      const res = await fetchWithRetry(`${QLD_BASE}?limit=100&offset=${offset}`);
      const json = await res.json();
      const results: QldRecord[] = json.results || [];
      for (const [index, r] of results.entries()) {
        const lat = r.geo_point_2d?.lat;
        const lng = r.geo_point_2d?.lon;
        if (typeof lat !== 'number' || typeof lng !== 'number' || !r.href) continue;
        cameras.push({
          id: `qld-${r.id || `${offset}-${index}-${lat.toFixed(5)}-${lng.toFixed(5)}`}`,
          lat,
          lng,
          name: r.title || 'QLD Traffic Camera',
          city: r.region || 'Queensland',
          country: 'Australia',
          feed_url: r.href,
          source: 'QLDTraffic',
        });
      }
      if (results.length < 100) break;
    }
    return cameras;
  });
}
