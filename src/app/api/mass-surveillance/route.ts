import { proxySurveillanceLayer } from '@/lib/surveillance-feed';

/**
 * HORUS — Known Mass-Surveillance Technology
 *
 * Fixed counter-surveillance records now come from the SQLite surveillance-feed
 * sidecar. This route intentionally does not fall back to direct Overpass.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return proxySurveillanceLayer({ request, layer: 'mass_surveil', bucket: 'mass_surveil' });
}
