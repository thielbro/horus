import type { CctvCamera } from './types';
import { fetchWithRetry, withFallback } from './resilient';

const NZTA_HOST = 'https://trafficnz.info';

/** Pull the first <tag>value</tag> out of an XML fragment. */
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : undefined;
}

/**
 * NZ Transport Agency (Waka Kotahi) state highway traffic cameras.
 * Public REST feed returns XML (no SOAP envelope, no key) for ~150+ cameras
 * nationwide; JPG snapshots refresh roughly every 30s.
 */
export async function fetchNewZealandCameras(): Promise<CctvCamera[]> {
  // Retries on cold/slow loads; falls back to last-good data so NZ never blanks.
  // NB: plain fetch via fetchWithRetry — NOT stealthFetch (its 10s hard-abort
  // killed the slow cold-start request and dropped NZ from the map).
  return withFallback('nz-nzta', async () => {
    const res = await fetchWithRetry(`${NZTA_HOST}/service/traffic/rest/4/cameras/all`);
    const xml = await res.text();

    const cameras: CctvCamera[] = [];
    for (const block of xml.match(/<camera>[\s\S]*?<\/camera>/gi) || []) {
      // Skip offline / under-maintenance cameras
      if (/<offline>\s*true\s*<\/offline>/i.test(block)) continue;
      if (/<underMaintenance>\s*true\s*<\/underMaintenance>/i.test(block)) continue;

      // region is nested (<region><name>Canterbury</name></region>); grab it
      // before flattening, since the camera's own fields share tag names with
      // nested <journey>/<journeyLeg>/<way> elements.
      const region = tag(block.match(/<region>[\s\S]*?<\/region>/i)?.[0] || '', 'name');

      // Strip nested containers so top-level <name>/<id> resolve to the camera's.
      const flat = block
        .replace(/<journey>[\s\S]*?<\/journey>/gi, '')
        .replace(/<journeyLeg>[\s\S]*?<\/journeyLeg>/gi, '')
        .replace(/<region>[\s\S]*?<\/region>/gi, '')
        .replace(/<way>[\s\S]*?<\/way>/gi, '');

      const id = tag(flat, 'id');
      const lat = parseFloat(tag(flat, 'latitude') || '');
      const lng = parseFloat(tag(flat, 'longitude') || '');
      const imageUrl = tag(flat, 'imageUrl');
      if (!id || !lat || !lng || !imageUrl) continue;

      cameras.push({
        id: `nz-${id}`,
        lat,
        lng,
        name: tag(flat, 'name') || tag(flat, 'description') || 'NZ Highway Camera',
        city: region || 'New Zealand',
        country: 'New Zealand',
        feed_url: imageUrl.startsWith('http') ? imageUrl : `${NZTA_HOST}${imageUrl}`,
        source: 'NZTA Waka Kotahi',
      });
    }
    return cameras;
  });
}
