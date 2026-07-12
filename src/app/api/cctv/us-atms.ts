import { stealthFetch } from '@/lib/stealthFetch';
import { safeAbortTimeout, releaseResponseBody } from '@/lib/http-utils';
import type { CctvCamera } from './types';

/**
 * US state DOT cameras on the Castle Rock "ATMS" 511 platform. These sites expose all camera
 * positions in one call — GET /map/mapIcons/Cameras → { item2: [{ itemId, location:[lat,lng],
 * title }] } — and a deterministic still-image URL per camera at /map/Cctv/<itemId> (a live
 * refreshable JPEG/PNG). One adapter therefore covers many states.
 *
 * Verified keyless during implementation (camera counts approximate): NY ~2300, GA ~4000,
 * NC ~1100, PA ~1500, CT ~350, New England (ME/NH/VT) ~400.
 */

const ATMS_TIMEOUT_MS = 12_000;

interface AtmsSite {
  host: string;
  region: string; // shown as `city` on the camera card
  source: string;
}

async function fetchAtmsCameras(site: AtmsSite): Promise<CctvCamera[]> {
  try {
    const res = await stealthFetch(`https://${site.host}/map/mapIcons/Cameras`, {
      signal: safeAbortTimeout(ATMS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    const items: any[] = Array.isArray(data?.item2) ? data.item2 : [];
    const cams: CctvCamera[] = [];
    for (const it of items) {
      const loc = it?.location;
      if (!Array.isArray(loc) || loc.length < 2) continue;
      const lat = Number(loc[0]);
      const lng = Number(loc[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const id = it.itemId ?? `${lat},${lng}`;
      cams.push({
        id: `atms-${site.host}-${id}`,
        lat,
        lng,
        name: (typeof it.title === 'string' && it.title.trim()) || `${site.region} Camera ${id}`,
        city: site.region,
        country: 'US',
        feed_url: `https://${site.host}/map/Cctv/${id}`,
        stream_type: 'snapshot',
        refresh_interval_ms: 30_000,
        source: site.source,
      });
    }
    return cams;
  } catch {
    return [];
  }
}

export const fetchNewYorkCameras = () => fetchAtmsCameras({ host: '511ny.org', region: 'New York', source: '511NY' });
export const fetchGeorgiaCameras = () => fetchAtmsCameras({ host: 'www.511ga.org', region: 'Georgia', source: '511GA' });
export const fetchNorthCarolinaCameras = () => fetchAtmsCameras({ host: 'drivenc.gov', region: 'North Carolina', source: 'DriveNC' });
export const fetchPennsylvaniaCameras = () => fetchAtmsCameras({ host: 'www.511pa.com', region: 'Pennsylvania', source: '511PA' });
export const fetchConnecticutCameras = () => fetchAtmsCameras({ host: 'cttravelsmart.org', region: 'Connecticut', source: 'CT Travel Smart' });
export const fetchNewEnglandCameras = () => fetchAtmsCameras({ host: 'newengland511.org', region: 'New England', source: 'New England 511' });
export const fetchArizonaCameras = () => fetchAtmsCameras({ host: 'www.az511.gov', region: 'Arizona', source: 'AZ 511' });
export const fetchIdahoCameras = () => fetchAtmsCameras({ host: '511.idaho.gov', region: 'Idaho', source: 'Idaho 511' });
export const fetchNevadaCameras = () => fetchAtmsCameras({ host: 'www.nvroads.com', region: 'Nevada', source: 'NV Roads' });
export const fetchLouisianaCameras = () => fetchAtmsCameras({ host: 'www.511la.org', region: 'Louisiana', source: 'Louisiana 511' });
export const fetchAlaskaCameras = () => fetchAtmsCameras({ host: '511.alaska.gov', region: 'Alaska', source: 'Alaska 511' });
