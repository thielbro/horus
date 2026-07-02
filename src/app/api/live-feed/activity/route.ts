import { rateLimitOr429 } from '@/lib/ssrf-guard';
import { proxyLiveFeedActivity } from '@/lib/live-feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  const limited = rateLimitOr429(request, 120);
  if (limited) return limited;
  return proxyLiveFeedActivity(request);
}
