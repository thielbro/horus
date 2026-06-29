import { NextResponse } from 'next/server';

type FixedLayer = 'surveillance' | 'flock' | 'police' | 'mass_surveil';

interface ProxyOptions {
  request: Request;
  layer: FixedLayer;
  bucket: FixedLayer;
}

const FEED_TIMEOUT_MS = 15_000;

function feedBaseUrl(): string | null {
  const raw = process.env.SURVEILLANCE_FEED_URL?.trim();
  return raw || null;
}

function buildFeedUrl(base: string, request: Request, layer: FixedLayer): URL {
  const incoming = new URL(request.url);
  const url = new URL('/v1/layers', base.endsWith('/') ? base : `${base}/`);
  const bbox = incoming.searchParams.get('bbox');
  if (bbox) url.searchParams.set('bbox', bbox);
  url.searchParams.set('layers', layer);
  return url;
}

async function readJsonOrNull(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    await res.body?.cancel();
    return null;
  }
}

function unavailable(bucket: FixedLayer, message: string, status = 503) {
  return NextResponse.json(
    {
      [bucket]: [],
      total: 0,
      error: message,
      backend: 'surveillance-feed',
      backendUnavailable: true,
      timestamp: new Date().toISOString(),
    },
    { status },
  );
}

export async function proxySurveillanceLayer({ request, layer, bucket }: ProxyOptions) {
  const base = feedBaseUrl();
  if (!base) {
    return unavailable(bucket, 'Surveillance feed backend is not configured. Set SURVEILLANCE_FEED_URL.');
  }

  const incoming = new URL(request.url);
  if (!incoming.searchParams.get('bbox')) {
    return NextResponse.json({ [bucket]: [], total: 0, error: 'bbox is required; expected south,west,north,east' }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('surveillance feed timeout')), FEED_TIMEOUT_MS);
  const abortFromRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortFromRequest();
  else request.signal.addEventListener('abort', abortFromRequest, { once: true });

  try {
    const res = await fetch(buildFeedUrl(base, request, layer), {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const json = await readJsonOrNull(res);
    if (!res.ok) {
      return unavailable(
        bucket,
        json?.error || `Surveillance feed returned HTTP ${res.status}`,
        res.status >= 500 ? 503 : res.status,
      );
    }
    const records = Array.isArray(json?.[layer]) ? json[layer] : [];
    return NextResponse.json(
      {
        [bucket]: records,
        total: records.length,
        timestamp: json?.timestamp ?? new Date().toISOString(),
        refresh: json?.refresh,
        backend: 'surveillance-feed',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (request.signal.aborted) {
      return unavailable(bucket, 'Surveillance feed request aborted', 499);
    }
    console.warn('[HORUS] Surveillance feed proxy failed:', error instanceof Error ? error.message : error);
    return unavailable(bucket, 'Surveillance feed backend unavailable');
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortFromRequest);
  }
}
