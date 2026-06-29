import { stealthFetch } from '@/lib/stealthFetch';
import { releaseResponseBody, safeAbortTimeout, safeAbortAny } from '@/lib/http-utils';
import { fetchAsfinagCameras } from '@/app/api/cctv/asfinag';
import { fetchBulgariaCameras } from '@/app/api/cctv/bulgaria';
import { fetchGreeceCameras } from '@/app/api/cctv/greece';
import { fetchSerbiaCameras } from '@/app/api/cctv/serbia';
import { fetchMacedoniaCameras } from '@/app/api/cctv/macedonia';
import { fetchTurkeyCameras } from '@/app/api/cctv/turkey';
import { fetchRomaniaCameras } from '@/app/api/cctv/romania';
import { fetchAustraliaCameras } from '@/app/api/cctv/australia';
import { fetchItalyCameras } from '@/app/api/cctv/italy';
import { fetchCzechiaCameras } from '@/app/api/cctv/czechia';
import { fetchSlovakiaCameras } from '@/app/api/cctv/slovakia';
import { fetchGermanyCameras } from '@/app/api/cctv/germany';
import { fetchFranceCameras } from '@/app/api/cctv/france';
import { fetchSpainCameras } from '@/app/api/cctv/spain';
import { fetchPolandCameras } from '@/app/api/cctv/poland';
import { fetchJapanCameras } from '@/app/api/cctv/japan';
import { fetchSwitzerlandCameras } from '@/app/api/cctv/switzerland';
import { fetchNewZealandCameras } from '@/app/api/cctv/newzealand';
import { fetchQueenslandCameras } from '@/app/api/cctv/queensland';
import { fetchVictoriaCameras } from '@/app/api/cctv/victoria';
import { fetchSurveillanceMapFoundationCameras } from '@/app/api/cctv/surveillance-map-foundation';
import { settleCameraFetchers } from '@/app/api/cctv/fanout';

/**
 * HORUS — reusable worldwide CCTV camera sources.
 *
 * The /api/cctv route and route-exposure intel provider both use this module so the map
 * layer and dossier analysis agree on which fixed CCTV cameras are known near a route.
 */

// ═══ CAMERA SOURCE DEFINITIONS ═══

export const MAX_CAMERAS = 5000;
export const DEFAULT_CCTV_REGIONS = ['uk'];
// Batched fanout: each batch runs concurrently with a per-batch deadline (below). These are
// tuned so even the widest query (region=all, ~27 sources) finishes well under maxDuration:
// ceil(27/8) = 4 batches × 12s ≈ 48s worst case (was 5-wide × 25s ≈ 150s, which timed out).
export const MAX_REGION_ALL_CONCURRENCY = 8;
export const REGION_BATCH_TIMEOUT_MS = 12_000;

// ── UK: Transport for London JamCams (~900) ──
async function fetchTfLCameras(): Promise<any[]> {
  try {
    const res = await stealthFetch('https://api.tfl.gov.uk/Place/Type/JamCam', { signal: safeAbortTimeout(12000) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    return (data || []).map((cam: any) => {
      const imgProp = cam.additionalProperties?.find((p: any) => p.key === 'imageUrl');
      const camId = cam.id?.replace('JamCams_', '') || '';
      return {
        id: `tfl-${cam.id}`, lat: cam.lat, lng: cam.lon,
        name: cam.commonName || 'London JamCam', city: 'London', country: 'UK',
        feed_url: imgProp?.value || `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${camId}.jpg`,
        source: 'TfL',
      };
    }).filter((c: any) => c.lat && c.lng);
  } catch { return []; }
}

// ── US-WEST: WSDOT Washington State (~500) ──
async function fetchWSDOTCameras(): Promise<any[]> {
  try {
    const res = await stealthFetch('https://data.wsdot.wa.gov/log/public/cameras.json', { signal: safeAbortTimeout(10000) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return [];
    }
    const data = await res.json();
    return (data || []).map((cam: any) => ({
      id: `wsdot-${cam.CameraID}`, lat: cam.CameraLocation?.Latitude, lng: cam.CameraLocation?.Longitude,
      name: cam.Title || 'WSDOT Camera', city: 'Washington', country: 'US',
      feed_url: cam.ImageURL || '', source: 'WSDOT',
    })).filter((c: any) => c.lat && c.lng && c.feed_url);
  } catch { return []; }
}

// ── US-WEST: Caltrans California Districts ──
const CALTRANS_DISTRICTS = ['d03', 'd04', 'd05', 'd06', 'd07', 'd08', 'd10', 'd11', 'd12'];

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = safeAbortTimeout(timeoutMs);
  return signal ? safeAbortAny([signal, timeout]) : timeout;
}

async function fetchCaltransDistrict(dist: string, signal?: AbortSignal): Promise<any[]> {
  const cams: any[] = [];
  try {
    const res = await stealthFetch(
      `https://cwwp2.dot.ca.gov/data/${dist}/cctv/cctvStatus${dist.toUpperCase()}.json`,
      { signal: signalWithTimeout(signal, 8000) },
    );
    if (!res.ok) {
      await releaseResponseBody(res);
      return cams;
    }
    const data = await res.json();
    for (const [index, cam] of (data?.data || []).entries()) {
      const lat = parseFloat(cam.location?.latitude);
      const lng = parseFloat(cam.location?.longitude);
      const url = cam.cctv?.imageData?.static?.currentImageURL;
      if (!lat || !lng || !url) continue;
      cams.push({
        id: `cal-${dist}-${cam.cctv?.locationId || index}`,
        lat,
        lng,
        name: cam.location?.locationName || 'Caltrans',
        city: 'California',
        country: 'US',
        feed_url: url,
        source: 'Caltrans',
      });
    }
  } catch { /* silent */ }
  return cams;
}

async function fetchCaltransCameras(signal?: AbortSignal): Promise<any[]> {
  const results = await Promise.allSettled(
    CALTRANS_DISTRICTS.map((dist) => fetchCaltransDistrict(dist, signal)),
  );
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

// ── CANADA: Ottawa, Toronto, Montreal, Quebec ──
async function fetchCanadaSource(source: () => Promise<any[]>): Promise<any[]> {
  try {
    return await source();
  } catch {
    return [];
  }
}

const CANADA_CURATED_CAMERAS = [
  { id: 'tor-1', lat: 43.6532, lng: -79.3832, name: 'Yonge / Dundas Square', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
  { id: 'tor-2', lat: 43.6426, lng: -79.3871, name: 'CN Tower / Lakeshore', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
  { id: 'tor-3', lat: 43.6711, lng: -79.3868, name: 'Bloor / Yonge', city: 'Toronto', country: 'Canada', feed_url: 'https://511on.ca/api/v2/get/cameras', source: '511 Ontario' },
];

async function fetchCanadaCameras(signal?: AbortSignal): Promise<any[]> {
  const sourceResults = await Promise.allSettled([
    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://traffic.ottawa.ca/beta/camera_list', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `ottawa-muni-${cam.id}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || 'Ottawa Traffic Camera', city: 'Ottawa', country: 'Canada',
          feed_url: `https://traffic.ottawa.ca/map/camera?id=${cam.number || cam.id}`, source: 'City of Ottawa',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:infos_cameras&outfile=Camera&srsname=EPSG:4326&outputformat=geojson', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const feature of (data.features || [])) {
        const coords = feature.geometry?.coordinates;
        const p = feature.properties;
        if (!coords || !p || !p.IDEcamera) continue;
        cams.push({
          id: `quebec511-${p.IDEcamera}`, lat: coords[1], lng: coords[0],
          name: p.DescriptionLocalisationEn || p.DescriptionLocalisationFr || 'Quebec 511 Camera', city: p.NomRegionDiffusion || 'Quebec', country: 'Canada',
          stream_url: p.URL_FLUX_DONNEE ? p.URL_FLUX_DONNEE.replace('FenetreVideo.html', 'camera.ashx') + '&format=mp4' : `https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=${p.IDEcamera}&format=mp4`,
          stream_type: 'mp4',
          source: 'Quebec 511',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://511on.ca/api/v2/get/cameras', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.latitude || !cam.longitude) continue;
        cams.push({
          id: `on-${cam.id || cams.length}`, lat: cam.latitude, lng: cam.longitude,
          name: cam.description || cam.name || 'Ontario Camera', city: 'Ontario', country: 'Canada',
          feed_url: cam.imageUrl || cam.url || '', source: '511 Ontario',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://ville.montreal.qc.ca/circulation/sites/ville.montreal.qc.ca.circulation/files/cameras.json', { signal: signalWithTimeout(signal, 8000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const cam of (data || [])) {
        cams.push({
          id: `mtl-muni-${cams.length}`, lat: cam.latitude || cam.lat, lng: cam.longitude || cam.lng,
          name: cam.description || cam.name || 'Montréal Camera', city: 'Montréal', country: 'Canada',
          feed_url: cam.url || cam.imageUrl || '', source: 'Ville MTL',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://511.alberta.ca/api/v2/get/cameras', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.Latitude || !cam.Longitude || !cam.Views?.[0]?.Url) continue;
        cams.push({
          id: `ab-${cam.Id || cams.length}`, lat: cam.Latitude, lng: cam.Longitude,
          name: cam.Location || 'Alberta Camera', city: 'Alberta', country: 'Canada',
          feed_url: cam.Views[0].Url, source: 'Alberta 511',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/a3309088-5fd4-4d34-8297-77c8301840ac/resource/4a568300-c7f8-496d-b150-dff6f5dc6d4f/download/traffic-camera-list-4326.geojson', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const feature of (data.features || [])) {
        let coords = feature.geometry?.coordinates;
        if (Array.isArray(coords) && Array.isArray(coords[0])) coords = coords[0];
        const p = feature.properties;
        if (!coords || !p || !p.IMAGEURL) continue;
        cams.push({
          id: `tor-open-${p.REC_ID}`, lat: coords[1], lng: coords[0],
          name: `${p.MAINROAD} / ${p.CROSSROAD}`, city: 'Toronto', country: 'Canada',
          feed_url: p.IMAGEURL, source: 'City of Toronto',
        });
      }
      return cams;
    }),

    fetchCanadaSource(async () => {
      const cams: any[] = [];
      const res = await stealthFetch('https://drivebc.ca/api/webcams', { signal: signalWithTimeout(signal, 10000) });
      if (!res.ok) {
        await releaseResponseBody(res);
        return cams;
      }
      const data = await res.json();
      for (const cam of (data || [])) {
        if (!cam.location?.coordinates || !cam.links?.imageDisplay) continue;
        const [lng, lat] = cam.location.coordinates;
        cams.push({
          id: `bc-cam-${cam.id}`, lat, lng,
          name: cam.name || cam.caption || 'BC Highway Camera', city: 'British Columbia', country: 'Canada',
          feed_url: `https://drivebc.ca${cam.links.imageDisplay}`, source: 'DriveBC',
        });
      }
      return cams;
    }),
  ]);

  const cams = sourceResults.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  cams.push(...CANADA_CURATED_CAMERAS);
  return cams.filter((c: any) => c.lat && c.lng);
}

// ── US-CENTRAL: Chicago, Houston, Dallas, Denver ──
async function fetchUSCentralCameras(): Promise<any[]> {
  const cams: any[] = [];
  // Illinois DOT
  try {
    const res = await stealthFetch('https://www.travelmidwest.com/lmiga/cameraReport.json', { signal: safeAbortTimeout(8000) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return cams.filter((c: any) => c.lat && c.lng);
    }
    const data = await res.json();
    for (const cam of (data?.cameraReports || data || []).slice(0, 800)) {
      if (!cam.latitude || !cam.longitude) continue;
      cams.push({
        id: `ildot-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
        name: cam.cameraName || cam.description || 'IDOT Camera', city: 'Illinois', country: 'US',
        feed_url: cam.imageUrl || cam.url || '', source: 'IDOT',
      });
    }
  } catch { /* silent */ }

  return cams.filter((c: any) => c.lat && c.lng);
}

// ── US-EAST: OH, DC, Florida, Georgia ──
async function fetchUSEastCameras(): Promise<any[]> {
  const cams: any[] = [];

  // Butler County, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'butler-oh-hamilton', lat: 39.3988617, lng: -84.5595353,
      name: 'Hamilton, OH', city: 'Hamilton', country: 'US',
      feed_url: 'https://gsccam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://gsccam.butlersheriff.org/camera/index.html#/video',
      source: 'Butler County, OH',
    },
    {
      id: 'butler-oh-129-747', lat: 39.381435, lng: -84.438423,
      name: 'OH-129 at 747', city: 'Butler County', country: 'US',
      feed_url: 'https://towercam.butlersheriff.org/axis-cgi/jpg/image.cgi',
      external_url: 'https://towercam.butlersheriff.org/aca/index.html#view',
      source: 'Butler County, OH',
    },
  );

  // Cincinnati, OH (from redhunt45 fork)
  cams.push(
    {
      id: 'cincinnati-cincyvision-yt', lat: 39.089101, lng: -84.527943,
      name: 'CincyVision YT', city: 'Cincinnati', country: 'US',
      external_url: 'https://www.youtube.com/@AaronPreslin/live',
      source: 'Cincinnati, OH',
    },
    {
      id: 'cincinnati-covington-earthcam', lat: 39.090510, lng: -84.510413,
      name: 'Cincinnati-Covington EarthCam', city: 'Covington', country: 'US',
      external_url: 'https://www.earthcam.com/usa/kentucky/covington/?cam=covington',
      source: 'Cincinnati, OH',
    },
  );

  cams.push(...fetchSurveillanceMapFoundationCameras('us-east'));

  // Florida 511
  try {
    const res = await stealthFetch('https://fl511.com/api/v2/cameras', { signal: safeAbortTimeout(8000) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return cams.filter((c: any) => c.lat && c.lng);
    }
    const data = await res.json();
    for (const cam of (data || []).slice(0, 800)) {
      if (!cam.latitude || !cam.longitude) continue;
      cams.push({
        id: `fl-${cams.length}`, lat: cam.latitude, lng: cam.longitude,
        name: cam.description || 'FL-511 Camera', city: 'Florida', country: 'US',
        feed_url: cam.imageUrl || '', source: 'FL-511',
      });
    }
  } catch { /* silent */ }


  return cams.filter((c: any) => c.lat && c.lng);
}

// ── EUROPE: Netherlands, Germany, France ──
async function fetchEuropeCameras(): Promise<any[]> {
  const cams: any[] = [];

  // Netherlands Rijkswaterstaat
  try {
    const res = await stealthFetch('https://opendata.ndw.nu/cameras.json', { signal: safeAbortTimeout(8000) });
    if (!res.ok) {
      await releaseResponseBody(res);
    } else {
      const data = await res.json();
      for (const cam of (data || []).slice(0, 1000)) {
        if (!cam.lat || !cam.lng) continue;
        cams.push({
          id: `nl-${cams.length}`, lat: cam.lat, lng: cam.lng,
          name: cam.name || 'NL Camera', city: 'Netherlands', country: 'NL',
          feed_url: cam.imageUrl || '', source: 'RWS',
        });
      }
    }
  } catch { /* silent */ }

  cams.push(...await fetchAsfinagCameras());
  cams.push(...fetchSurveillanceMapFoundationCameras('europe'));

  return cams.filter((c: any) => c.lat && c.lng);
}

// ── ASIA/PACIFIC ──
async function fetchAsiaCameras(): Promise<any[]> {
  const cams: any[] = [];

  // Singapore Live Traffic Images
  try {
    const res = await stealthFetch('https://api.data.gov.sg/v1/transport/traffic-images', { signal: safeAbortTimeout(10000) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return cams;
    }
    const data = await res.json();
    const items = data.items?.[0]?.cameras || [];
    for (const cam of items) {
      if (!cam.location?.latitude || !cam.location?.longitude || !cam.image) continue;
      cams.push({
        id: `sin-${cam.camera_id}`,
        lat: cam.location.latitude,
        lng: cam.location.longitude,
        name: `Camera ${cam.camera_id}`,
        city: 'Singapore',
        country: 'Singapore',
        feed_url: cam.image,
        source: 'LTA Singapore'
      });
    }
  } catch { /* silent */ }

  return cams;
}


// ── MIDDLE EAST: Israel, Lebanon ──
async function fetchMiddleEastCameras(): Promise<any[]> {
  const cams: any[] = [];
  
  // Israel Curated (Embedded)
  cams.push(
    {
      id: 'il-israel-multicam', lat: 32.0853, lng: 34.7818,
      name: 'Israel Multi-Cam (Live)', city: 'Tel Aviv', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/gmtlJ_m2r5A?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'il-jerusalem-live', lat: 31.7767, lng: 35.2345,
      name: 'Jerusalem Western Wall', city: 'Jerusalem', country: 'Israel',
      stream_url: 'https://www.youtube.com/embed/77akujLn4k8?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  // Lebanon Curated (Embedded)
  cams.push(
    {
      id: 'lb-beirut-skyline', lat: 33.8938, lng: 35.5018,
      name: 'Beirut Skyline Live', city: 'Beirut', country: 'Lebanon',
      stream_url: 'https://www.youtube.com/embed/qJf4NqPKLjI?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    },
    {
      id: 'lb-me-multicam', lat: 33.2721, lng: 35.2033,
      name: 'Middle East Multi-Cam (Live)', city: 'Regional', country: 'Middle East',
      stream_url: 'https://www.youtube.com/embed/oxT5R6I0N6E?autoplay=1&mute=1',
      stream_type: 'iframe',
      source: 'YouTube Live',
    }
  );

  return cams;
}

// ═══ REGION MAPPING ═══
const REGION_FETCHERS: Record<string, () => Promise<any[]>> = {
  'middle-east': fetchMiddleEastCameras,
  'uk': async () => [...await fetchTfLCameras(), ...fetchSurveillanceMapFoundationCameras('uk')],
  'us-west': async () => [...await fetchWSDOTCameras(), ...await fetchCaltransCameras(), ...fetchSurveillanceMapFoundationCameras('us-west')],
  'us-east': fetchUSEastCameras,
  'us-central': fetchUSCentralCameras,
  'canada': fetchCanadaCameras,
  'europe': fetchEuropeCameras,
  'asia': fetchAsiaCameras,
  'bulgaria': fetchBulgariaCameras,
  'greece': fetchGreeceCameras,
  'serbia': fetchSerbiaCameras,
  'macedonia': fetchMacedoniaCameras,
  'turkey': fetchTurkeyCameras,
  'romania': fetchRomaniaCameras,
  'australia': fetchAustraliaCameras,
  'queensland': fetchQueenslandCameras,
  'victoria': fetchVictoriaCameras,
  'newzealand': fetchNewZealandCameras,
  'italy': fetchItalyCameras,
  'czechia': fetchCzechiaCameras,
  'slovakia': fetchSlovakiaCameras,
  'germany': fetchGermanyCameras,
  'france': fetchFranceCameras,
  'spain': fetchSpainCameras,
  'poland': fetchPolandCameras,
  'japan': fetchJapanCameras,
  'switzerland': fetchSwitzerlandCameras,
};

// ═══ CONTINENT MAPPING ═══
// Groups the region fetchers above into continents. The frontend loads cameras one
// continent at a time (?continent=…) so each request stays well under MAX_CAMERAS — this
// is what prevents the old "region=all" cap from starving late regions like Oceania.
// Continents without sources yet (Africa, South America, Antarctica) are intentionally absent.
const CONTINENTS: Record<string, string[]> = {
  europe: ['uk', 'europe', 'bulgaria', 'greece', 'serbia', 'macedonia', 'turkey', 'romania', 'italy', 'czechia', 'slovakia', 'germany', 'france', 'spain', 'poland', 'switzerland'],
  'north-america': ['us-west', 'us-east', 'us-central', 'canada'],
  asia: ['asia', 'japan', 'middle-east'],
  oceania: ['australia', 'queensland', 'victoria', 'newzealand'],
};

// Merge per-region results fairly: round-robin across regions so a shared cap can never
// drain the first regions and starve later ones (the AU/NZ "region=all" bug). De-dupes by id.
export function mergeCamerasFairly(results: PromiseSettledResult<any[]>[], max: number): { cameras: any[]; sources: Record<string, number> } {
  const lists = results.filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled').map((r) => r.value || []);
  const cameras: any[] = [];
  const seen = new Set<string>();
  const sources: Record<string, number> = {};
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen && cameras.length < max; i++) {
    for (const list of lists) {
      if (i >= list.length) continue;
      if (cameras.length >= max) break;
      const cam = list[i];
      const cameraId = String(cam.id || `${cam.source}:${cam.lat}:${cam.lng}`);
      if (seen.has(cameraId)) continue;
      seen.add(cameraId);
      cameras.push(cam);
      sources[cam.source] = (sources[cam.source] || 0) + 1;
    }
  }
  return { cameras, sources };
}

export async function runRegionFetchers(regionsToFetch: string[]): Promise<PromiseSettledResult<any[]>[]> {
  const results: PromiseSettledResult<any[]>[] = [];
  for (let i = 0; i < regionsToFetch.length; i += MAX_REGION_ALL_CONCURRENCY) {
    const batch = regionsToFetch.slice(i, i + MAX_REGION_ALL_CONCURRENCY);
    results.push(...await settleCameraFetchers<any>(
      batch.map(r => REGION_FETCHERS[r]),
      REGION_BATCH_TIMEOUT_MS,
    ));
  }
  return results;
}

// Determine which regions to fetch based on viewport bounds
export function getRegionsForBounds(lat: number, lng: number): string[] {
  const regions: string[] = [];
  // UK
  if (lat > 49 && lat < 61 && lng > -8 && lng < 2) regions.push('uk');
  // US-East
  if (lat > 24 && lat < 49 && lng > -85 && lng < -66) regions.push('us-east');
  // US-West
  if (lat > 24 && lat < 49 && lng > -125 && lng < -100) regions.push('us-west');
  // US-Central
  if (lat > 24 && lat < 49 && lng > -105 && lng < -80) regions.push('us-central');
  // Canada
  if (lat > 42 && lat < 70 && lng > -141 && lng < -52) regions.push('canada');
  // Europe
  const inBulgaria = lat > 41 && lat < 44.5 && lng > 22 && lng < 29.5;
  const inGreece = lat > 34.5 && lat < 41.8 && lng > 19 && lng < 30;
  const inSerbia = lat > 42 && lat < 46.5 && lng > 18.8 && lng < 23.3;
  const inMacedonia = lat > 40.8 && lat < 42.8 && lng > 20.4 && lng < 23.2;
  const inRomania = lat > 43.5 && lat < 48.5 && lng > 20 && lng < 29.8;
  const inTurkey = lat > 35.5 && lat < 42.5 && lng > 25.5 && lng < 45;
  const inSwitzerland = lat > 45.7 && lat < 47.9 && lng > 5.8 && lng < 10.7;
  const inItaly = lat > 36 && lat < 47.5 && lng > 6.5 && lng < 18.5 && !inSwitzerland;
  const inCzechia = lat > 48.5 && lat < 51.1 && lng > 12 && lng < 18.9;
  const inSlovakia = lat > 47.7 && lat < 49.6 && lng > 16.8 && lng < 22.6;
  const inGermany = lat > 47 && lat < 55.1 && lng > 5.8 && lng < 15.1 && !inSwitzerland;
  const inFrance = lat > 42.3 && lat < 51.1 && lng > -5 && lng < 8.3 && !inSwitzerland;
  const inSpain = lat > 27 && lat < 43.8 && lng > -18.2 && lng < 4.4;
  const inPoland = lat > 49.0 && lat < 54.8 && lng > 14.1 && lng < 24.1;
  const inIceland = lat > 63 && lat < 67.5 && lng > -25 && lng < -13;
  const inBalkans = inBulgaria || inGreece || inSerbia || inMacedonia || inRomania || inTurkey;
  const inWesternEurope = inItaly || inCzechia || inSlovakia || inGermany || inFrance || inSpain || inPoland || inSwitzerland;

  if (lat > 35 && lat < 72 && lng > -11 && lng < 40 && !inBalkans && !inWesternEurope) {
    regions.push('europe');
  }
  if (inIceland) regions.push('europe');
  if (inBulgaria) regions.push('bulgaria');
  if (inGreece) regions.push('greece');
  if (inSerbia) regions.push('serbia');
  if (inMacedonia) regions.push('macedonia');
  if (inRomania) regions.push('romania');
  if (inTurkey) regions.push('turkey');
  if (inItaly) regions.push('italy');
  if (inCzechia) regions.push('czechia');
  if (inSlovakia) regions.push('slovakia');
  if (inGermany) regions.push('germany');
  if (inFrance) regions.push('france');
  if (inSpain) regions.push('spain');
  if (inPoland) regions.push('poland');
  if (inSwitzerland) regions.push('switzerland');

  // Middle East
  const inMiddleEast = lat > 29 && lat < 34.5 && lng > 34 && lng < 36.5;
  if (inMiddleEast) regions.push('middle-east');

  // Japan
  if (lat > 24 && lat < 46 && lng > 122 && lng < 154) regions.push('japan');

  // Asia (includes Middle East, SE Asia, overriding parts of china but that's ok they can both load)
  if ((lat > -10 && lat < 60 && lng > 60 && lng < 150)) regions.push('asia');
  // Australia explicitly
  if (lat > -45 && lat < -10 && lng > 110 && lng < 155) { regions.push('australia'); regions.push('queensland'); regions.push('victoria'); }
  // New Zealand
  if (lat > -47.5 && lat < -34 && lng > 166 && lng < 179.5) regions.push('newzealand');

  return regions.length > 0 ? regions : ['uk', 'us-east']; // Default fallback
}

export interface CctvSourceRequest {
  continent?: string | null;
  region?: string | null;
  hasCoordinateQuery?: boolean;
  lat?: number;
  lng?: number;
  radius?: number;
  maxCameras?: number;
}

export interface CctvSourceResult {
  cameras: any[];
  total: number;
  sources: Record<string, number>;
  regions: string[];
  timestamp: string;
}

export function resolveCctvRegions(req: CctvSourceRequest): string[] {
  if (req.continent) {
    return (CONTINENTS[req.continent] ?? []).filter(r => r in REGION_FETCHERS);
  }
  if (req.region === 'all') {
    return Object.keys(REGION_FETCHERS);
  }
  if (req.region) {
    return req.region.split(',').filter(r => r in REGION_FETCHERS);
  }
  if (req.hasCoordinateQuery) {
    return getRegionsForBounds(Number(req.lat ?? 0), Number(req.lng ?? 0));
  }
  return DEFAULT_CCTV_REGIONS;
}

export async function fetchCctvCamerasForRequest(req: CctvSourceRequest): Promise<CctvSourceResult> {
  const regionsToFetch = resolveCctvRegions(req);
  const results = await runRegionFetchers(regionsToFetch);
  const { cameras, sources } = mergeCamerasFairly(results, req.maxCameras ?? MAX_CAMERAS);

  return {
    cameras,
    total: cameras.length,
    sources,
    regions: regionsToFetch,
    timestamp: new Date().toISOString(),
  };
}

export async function fetchCctvCamerasForPoint(lat: number, lng: number, radius = 10, maxCameras = MAX_CAMERAS): Promise<CctvSourceResult> {
  return fetchCctvCamerasForRequest({
    hasCoordinateQuery: true,
    lat,
    lng,
    radius,
    maxCameras,
  });
}
