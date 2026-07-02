import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { safeAbortTimeout, releaseResponseBody } from '@/lib/http-utils';

export const dynamic = 'force-dynamic';

/**
 * Entity graph expansion for map objects.
 *
 * Aircraft are resolved KEYLESS and in-process from adsbdb.com (real airline + origin/
 * destination airports + owner/type) so aviation intel works without the horus-intel
 * sidecar running, and no longer relies on the old callsign-prefix guessing. The sidecar
 * (Wikidata + OpenSanctions) is still consulted for sanctions cross-refs when reachable, and
 * remains the resolver for the other entity types (vessel/company/person/ip/country).
 */

const INTEL_URL =
  process.env.INTEL_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://horus-intel:4000' : 'http://localhost:4000');

const ADSBDB = 'https://api.adsbdb.com/v0';

const ALLOWED_TYPES = new Set(['aircraft', 'vessel', 'company', 'person', 'ip', 'country']);

interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, unknown>;
}
interface GraphLink {
  source: string;
  target: string;
  label?: string;
}
interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

function dedup(nodes: GraphNode[], links: GraphLink[]): Graph {
  const seenN = new Set<string>();
  const uNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (seenN.has(n.id)) continue;
    seenN.add(n.id);
    uNodes.push(n);
  }
  const seenL = new Set<string>();
  const uLinks: GraphLink[] = [];
  for (const l of links) {
    const k = `${l.source}→${l.target}→${l.label ?? ''}`;
    if (seenL.has(k)) continue;
    seenL.add(k);
    uLinks.push(l);
  }
  return { nodes: uNodes, links: uLinks };
}

async function adsbdbJson(path: string, signal: AbortSignal): Promise<any | null> {
  try {
    const res = await fetch(`${ADSBDB}/${path}`, {
      signal,
      headers: { Accept: 'application/json', 'User-Agent': 'HORUS-map/1.0' },
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function airportNode(rootId: string, ap: any, role: 'ORIGIN' | 'DESTINATION', nodes: GraphNode[], links: GraphLink[]) {
  if (!ap || (!ap.icao_code && !ap.name)) return;
  const id = `airport:${ap.icao_code || ap.name}`;
  nodes.push({
    id,
    label: `${ap.name || ap.icao_code}${ap.iata_code ? ` (${ap.iata_code})` : ''}`,
    type: 'event',
    properties: {
      role: role === 'ORIGIN' ? 'Origin airport' : 'Destination airport',
      lat: ap.latitude,
      lon: ap.longitude,
      municipality: ap.municipality || '',
      country: ap.country_name || '',
      icao: ap.icao_code || '',
      iata: ap.iata_code || '',
      source: 'adsbdb',
    },
  });
  links.push({ source: rootId, target: id, label: role === 'ORIGIN' ? 'DEPARTED' : 'ARRIVING' });
}

/** Build the aircraft graph from adsbdb (callsign→route, icao24/registration→aircraft). */
async function resolveAircraftKeyless(
  callsign: string,
  props: { registration?: string; model?: string; icao24?: string },
  signal: AbortSignal,
): Promise<Graph> {
  const rootId = `aircraft:${callsign}`;
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const registration = (props.registration || '').toUpperCase().trim();
  const icao24 = (props.icao24 || '').toLowerCase().trim();

  nodes.push({
    id: rootId,
    label: callsign,
    type: 'aircraft',
    properties: { callsign, registration: registration || 'N/A', model: props.model || '', icao24, source: 'ADS-B' },
  });

  const [routeRes, aircraftRes] = await Promise.allSettled([
    adsbdbJson(`callsign/${encodeURIComponent(callsign)}`, signal),
    icao24 || registration
      ? adsbdbJson(`aircraft/${encodeURIComponent(icao24 || registration)}`, signal)
      : Promise.resolve(null),
  ]);

  // Route → airline + origin/destination airports.
  const route = routeRes.status === 'fulfilled' ? routeRes.value?.response?.flightroute : null;
  let airlineName: string | null = null;
  if (route) {
    if (route.airline?.name) {
      airlineName = route.airline.name;
      const airId = `company:${airlineName}`;
      nodes.push({
        id: airId,
        label: airlineName as string,
        type: 'company',
        properties: { role: 'Airline', icao: route.airline.icao || '', iata: route.airline.iata || '', source: 'adsbdb' },
      });
      links.push({ source: rootId, target: airId, label: 'OPERATED BY' });
      if (route.airline.country) {
        const cid = `country:${route.airline.country}`;
        nodes.push({ id: cid, label: route.airline.country, type: 'country', properties: { source: 'adsbdb' } });
        links.push({ source: airId, target: cid, label: 'HEADQUARTERED' });
      }
    }
    airportNode(rootId, route.origin, 'ORIGIN', nodes, links);
    airportNode(rootId, route.destination, 'DESTINATION', nodes, links);
  }

  // Aircraft record → type, owner, owner country.
  const aircraft = aircraftRes.status === 'fulfilled' ? aircraftRes.value?.response?.aircraft : null;
  if (aircraft) {
    const model = aircraft.type || props.model || '';
    if (model) {
      const mid = `aircraft:model:${model}`;
      nodes.push({
        id: mid,
        label: model,
        type: 'aircraft',
        properties: { role: 'Type', manufacturer: aircraft.manufacturer || '', icao_type: aircraft.icao_type || '', source: 'adsbdb' },
      });
      links.push({ source: rootId, target: mid, label: 'AIRCRAFT TYPE' });
    }
    if (aircraft.registered_owner && aircraft.registered_owner !== airlineName) {
      const oid = `company:${aircraft.registered_owner}`;
      nodes.push({ id: oid, label: aircraft.registered_owner, type: 'company', properties: { role: 'Registered owner', source: 'adsbdb' } });
      links.push({ source: rootId, target: oid, label: 'OWNED BY' });
    }
    if (aircraft.registered_owner_country_name) {
      const cid = `country:${aircraft.registered_owner_country_name}`;
      nodes.push({ id: cid, label: aircraft.registered_owner_country_name, type: 'country', properties: { role: 'Registered', source: 'adsbdb' } });
      links.push({ source: rootId, target: cid, label: 'REGISTERED IN' });
    }
  }

  return dedup(nodes, links);
}

/** Merge the sidecar's graph (sanctions etc.) when the sidecar is actually reachable. */
async function mergeSidecar(type: string, id: string, params: URLSearchParams, base: Graph, clientIp: string): Promise<Graph> {
  try {
    const res = await fetch(`${INTEL_URL}/resolve?${params}`, {
      signal: safeAbortTimeout(6000),
      headers: { 'X-Forwarded-For': clientIp },
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return base;
    }
    const data = await res.json();
    const nodes = [...base.nodes, ...(Array.isArray(data?.nodes) ? data.nodes : [])];
    const links = [...base.links, ...(Array.isArray(data?.links) ? data.links : [])];
    return dedup(nodes, links);
  } catch {
    return base;
  }
}

export async function GET(req: Request) {
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 30, 60_000, 'entity-expand')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const type = (searchParams.get('type') || '').toLowerCase().trim();
  const id = (searchParams.get('id') || '').trim();

  if (!type || !ALLOWED_TYPES.has(type)) {
    return NextResponse.json(
      { error: `Invalid type. Allowed: ${[...ALLOWED_TYPES].join(', ')}` },
      { status: 400 },
    );
  }
  if (!id || id.length < 2 || id.length > 200) {
    return NextResponse.json({ error: 'Invalid id (2-200 chars)' }, { status: 400 });
  }

  const params = new URLSearchParams({ type, id });
  for (const key of ['registration', 'model', 'icao24']) {
    const val = searchParams.get(key);
    if (val) params.set(key, val);
  }

  // Aircraft: keyless in-process resolution first, then optional sidecar merge for sanctions.
  if (type === 'aircraft') {
    try {
      const signal = safeAbortTimeout(12_000);
      const base = await resolveAircraftKeyless(
        id.toUpperCase(),
        {
          registration: searchParams.get('registration') || undefined,
          model: searchParams.get('model') || undefined,
          icao24: searchParams.get('icao24') || undefined,
        },
        signal,
      );
      const merged = await mergeSidecar(type, id, params, base, clientIp);
      return NextResponse.json(
        { nodes: merged.nodes, links: merged.links, entity: { type, id }, source: 'HORUS (adsbdb + sidecar)', timestamp: new Date().toISOString() },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } },
      );
    } catch (e) {
      console.error('[HORUS] aircraft resolve error:', e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: 'Aircraft resolution failed', nodes: [], links: [] },
        { status: 502 },
      );
    }
  }

  // All other entity types proxy to the intel sidecar (Wikidata + OpenSanctions).
  try {
    const res = await fetch(`${INTEL_URL}/resolve?${params}`, {
      signal: safeAbortTimeout(15000),
      headers: { 'X-Forwarded-For': clientIp },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: body.error || `Intel layer returned ${res.status}`, nodes: [], links: [] },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  } catch (e) {
    console.error('[HORUS] Intel proxy error:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: 'Intelligence layer unavailable', nodes: [], links: [] },
      { status: 502 },
    );
  }
}
