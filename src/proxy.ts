import { NextResponse } from 'next/server';
import type { NextRequest, NextFetchEvent } from 'next/server';
import { releaseResponseBody, safeAbortTimeout } from '@/lib/http-utils';

// Next 16 `proxy` convention (replaces the deprecated `middleware` file — keeping the
// deprecated convention is what sent Turbopack's dev server into a worker-respawn storm).
//
// Umami analytics is opt-in: it only runs when UMAMI_ENDPOINT is explicitly set (the web
// Docker deploy). Dev and the packaged desktop app leave it unset, so the Docker-only
// `umami-umami-1` host — which is unreachable everywhere else — is never contacted.
export function proxy(request: NextRequest, event: NextFetchEvent) {
  const endpoint = process.env.UMAMI_ENDPOINT;
  if (!endpoint) {
    return NextResponse.next();
  }

  const url = request.nextUrl.pathname;
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
  const userAgent = request.headers.get('user-agent') || 'Unknown HORUS Client';

  const basePayload = {
    hostname: request.nextUrl.hostname,
    language: 'en-US',
    referrer: request.headers.get('referer') || '',
    screen: '1920x1080',
    title: 'HORUS',
    url,
    website: process.env.UMAMI_WEBSITE_ID || 'cd8f216c-fc3f-45f5-ba1a-e10309a61d18',
  };

  // A hard timeout guarantees these never hang the request, even if umami is down.
  const send = (body: object) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent, 'x-forwarded-for': ip },
      body: JSON.stringify(body),
      signal: safeAbortTimeout(3000),
    }).then(releaseResponseBody).catch(() => {});

  event.waitUntil(
    Promise.all([
      send({ payload: basePayload, type: 'event' }),
      send({ payload: { ...basePayload, name: 'Network Log', data: { IP: ip } }, type: 'event' }),
    ])
  );

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
