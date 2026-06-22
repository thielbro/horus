import { NextRequest, NextResponse } from 'next/server';

const MAX_TILE_BYTES = 5 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    // Only allow cartocdn.com domains to prevent open proxy abuse
    const targetUrl = new URL(url);
    const host = targetUrl.hostname.toLowerCase();
    if (host !== 'cartocdn.com' && !host.endsWith('.cartocdn.com')) {
      return NextResponse.json({ error: 'Forbidden domain' }, { status: 403 });
    }

    const response = await fetch(targetUrl.toString(), {
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Osiris-Tile-Proxy/1.0',
      },
      signal: AbortSignal.timeout(10000),
      // Using Next.js fetch cache options to heavily cache tiles locally
      next: {
        revalidate: 31536000, // Cache for 1 year
      }
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch tile' }, { status: response.status });
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > MAX_TILE_BYTES) {
      await response.body?.cancel();
      return NextResponse.json({ error: 'Tile response too large' }, { status: 502 });
    }

    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_TILE_BYTES) {
      return NextResponse.json({ error: 'Tile response too large' }, { status: 502 });
    }
    
    // Forward the content-type from the upstream response
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Tile proxy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
