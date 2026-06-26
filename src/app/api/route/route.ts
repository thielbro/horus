import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { routeBetween, type RoutePoint } from '@/lib/routing';

export const dynamic = 'force-dynamic';

/**
 * HORUS — driving-route proxy.
 *
 * GET /api/route?from=<lat,lng>&to=<lat,lng>
 *   → { geometry: { type:'LineString', coordinates:[[lng,lat]...] }, distance, duration }
 *
 * Thin wrapper over OSRM (via ROUTING_URL — self-hosted in prod, public OSRM demo for dev).
 * The route intel provider calls routeBetween() directly; this endpoint exists for the client
 * (route preview) and curl smoke tests.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parsePoint(raw: string | null): RoutePoint | null {
  if (!raw) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export async function GET(req: Request) {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 30, 60_000)) {
    return json({ error: 'Rate limit exceeded' }, 429);
  }

  const { searchParams } = new URL(req.url);
  const start = parsePoint(searchParams.get('from'));
  const end = parsePoint(searchParams.get('to'));
  if (!start || !end) {
    return json({ error: 'Provide from=<lat,lng> and to=<lat,lng>' }, 400);
  }

  try {
    const route = await routeBetween(start, end, req.signal);
    if (!route) return json({ error: 'No route found' }, 502);
    return json({
      geometry: { type: 'LineString', coordinates: route.coordinates },
      distance: route.distance,
      duration: route.duration,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'routing failed' }, 500);
  }
}
