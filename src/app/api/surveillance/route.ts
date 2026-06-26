import { NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { safeAbortTimeout } from '@/lib/http-utils';

/**
 * HORUS — Surveillance Camera Locations (OpenStreetMap)
 *
 * Counter-surveillance intel layer: maps the LOCATIONS of fixed surveillance
 * cameras (`man_made=surveillance`) and speed/enforcement cameras
 * (`highway=speed_camera`) in OpenStreetMap. Positions only — no live video.
 * Data is community-sourced and licensed ODbL.
 *
 * Default coverage: New Zealand + Australia. Pass ?bbox=s,w,n,e to override.
 */

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_BBOX_AREA_DEGREES = 25;

type BBox = [number, number, number, number];

// [south, west, north, east]
const BBOXES: Record<string, BBox> = {
  nz: [-47.5, 166, -34, 179.5],
  au: [-44, 112, -10, 154],
};

interface OverpassNode {
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

function titleCase(s: string): string {
  return s.replace(/[_:]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function countryFor(lat: number, lng: number): string {
  const [s, w, n, e] = BBOXES.nz;
  if (lat >= s && lat <= n && lng >= w && lng <= e) return 'New Zealand';
  return 'Australia';
}

function parseBboxParam(bboxParam: string | null): { ok: true; boxes: BBox[] } | { ok: false; error: string } {
  if (!bboxParam) return { ok: true, boxes: Object.values(BBOXES) };

  const parts = bboxParam.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: 'invalid bbox format; expected south,west,north,east' };
  }

  const [s, w, n, e] = parts as BBox;
  if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w >= e) {
    return { ok: false, error: 'invalid bbox coordinates' };
  }

  const area = (n - s) * (e - w);
  if (area > MAX_BBOX_AREA_DEGREES) {
    return { ok: false, error: 'bbox area too large' };
  }

  return { ok: true, boxes: [[s, w, n, e]] };
}

export async function GET(request: Request) {
  try {
    const clientIp = getClientIp(request);
    if (isRateLimited(clientIp, 30, 60_000)) {
      return NextResponse.json({ surveillance: [], error: 'Rate limit exceeded' }, { status: 429 });
    }

    const { searchParams } = new URL(request.url);
    const parsedBbox = parseBboxParam(searchParams.get('bbox'));
    if (!parsedBbox.ok) {
      return NextResponse.json({ surveillance: [], error: parsedBbox.error }, { status: 400 });
    }
    const boxes = parsedBbox.boxes;

    const clauses = boxes
      .map(([s, w, n, e]) => {
        const bbox = `${s},${w},${n},${e}`;
        return `node["man_made"="surveillance"](${bbox});\n  node["highway"="speed_camera"](${bbox});`;
      })
      .join('\n  ');
    const query = `[out:json][timeout:30];\n(\n  ${clauses}\n);\nout body 12000;`;

    // Plain fetch (not stealthFetch — it hard-aborts at 10s; Overpass needs longer)
    // and Overpass etiquette asks for a descriptive User-Agent.
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'HORUS-map/1.0 (surveillance-location layer; OpenStreetMap data)',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: safeAbortTimeout(30000),
    });
    if (!res.ok) {
      return NextResponse.json({ surveillance: [], error: `Overpass ${res.status}` }, { status: 200 });
    }

    const data = await res.json();
    const surveillance = (data.elements as OverpassNode[] | undefined || [])
      .filter((el) => typeof el.lat === 'number' && typeof el.lon === 'number')
      .map((el) => {
        const t = el.tags || {};
        const isSpeed = t.highway === 'speed_camera';
        const kind = isSpeed
          ? 'speed_camera'
          : t['surveillance:type'] || t['camera:type'] || 'camera';
        return {
          id: `osm-surv-${el.id}`,
          lat: el.lat as number,
          lng: el.lon as number,
          name: t.name || t.description || t.operator || titleCase(kind),
          country: countryFor(el.lat as number, el.lon as number),
          surveillance_type: isSpeed ? 'speed_camera' : t['surveillance:type'] || null,
          camera_type: t['camera:type'] || null,
          zone: t['surveillance:zone'] || t.enforcement || null,
          operator: t.operator || null,
          source: 'OpenStreetMap',
          osm_url: `https://www.openstreetmap.org/node/${el.id}`,
        };
      });

    return NextResponse.json(
      { surveillance, total: surveillance.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' } },
    );
  } catch (error) {
    console.error('Surveillance fetch error:', error);
    return NextResponse.json({ surveillance: [], error: 'Failed' }, { status: 200 });
  }
}
