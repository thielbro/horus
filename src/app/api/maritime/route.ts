import { proxyMaritimeSnapshot } from '@/lib/live-feed';
import { rateLimitOr429 } from '@/lib/ssrf-guard';

/**
 * HORUS - Maritime Intelligence
 *
 * Live vessel sampling is owned by the activation-gated live-feed sidecar.
 * This route only proxies the current cached snapshot for the renderer.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const limited = rateLimitOr429(request, 30);
  if (limited) return limited;
  return proxyMaritimeSnapshot();
}
