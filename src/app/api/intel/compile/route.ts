import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { compile, providerKinds } from '@/lib/intel/compile';
import type { CompileEvent, EntityRef } from '@/lib/intel/types';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — on-the-go intel compiler.
 *
 * GET /api/intel/compile?kind=<kind>&id=<ref>[&lat=&lng=&label=][&stream=0][&force=1]
 *   Streams Server-Sent Events (status / graph / section / done) by default.
 *   ?stream=0 returns the assembled Dossier as one JSON object (tests / curl).
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parseRef(searchParams: URLSearchParams, kind: string): EntityRef | null {
  const id = (searchParams.get('id') || searchParams.get('ref') || '').trim();
  const lat = parseFloat(searchParams.get('lat') || '');
  const lng = parseFloat(searchParams.get('lng') || '');
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (!id && !hasCoords) return null;
  return {
    kind,
    id: id || `${lat},${lng}`,
    label: searchParams.get('label') || undefined,
    lat: hasCoords ? lat : undefined,
    lng: hasCoords ? lng : undefined,
  };
}

export async function GET(req: Request) {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 20, 60_000)) {
    return json({ error: 'Rate limit exceeded' }, 429);
  }

  const { searchParams } = new URL(req.url);
  const kind = (searchParams.get('kind') || '').toLowerCase().trim();
  const allowed = providerKinds();
  if (!allowed.includes(kind)) {
    return json({ error: `Invalid kind. Allowed: ${allowed.join(', ')}` }, 400);
  }

  const ref = parseRef(searchParams, kind);
  if (!ref) return json({ error: 'Provide id/ref or lat & lng' }, 400);

  const force = searchParams.get('force') === '1';
  const stream = searchParams.get('stream') !== '0';

  if (!stream) {
    try {
      const dossier = await compile(kind, ref, { signal: req.signal, force });
      return json(dossier);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'compile failed' }, 500);
    }
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let errorSent = false;
      const send = (ev: CompileEvent) => {
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        try {
          if (ev.event === 'error') errorSent = true;
          controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
        } catch {
          /* stream already closed */
        }
      };
      try {
        await compile(kind, ref, { signal: req.signal, force, emit: send });
      } catch (e) {
        if (!errorSent) send({ event: 'error', data: { message: e instanceof Error ? e.message : 'compile failed' } });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
