import type { BBox } from './types.ts';

const DEFAULT_MAX_TILE_SPAN_DEGREES = 1;

export function parseBbox(raw: string): BBox {
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('invalid bbox: expected south,west,north,east');
  }

  return validateBbox(parts as BBox);
}

export function validateBbox(bbox: BBox): BBox {
  const [south, west, north, east] = bbox;
  if (south < -90 || north > 90) throw new Error('invalid bbox: latitude must be between -90 and 90');
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new Error('invalid bbox: longitude must be between -180 and 180');
  }
  if (south >= north) throw new Error('invalid bbox: south must be less than north');
  // west > east is a valid antimeridian-crossing box (e.g. Fiji, Chatham Islands, eastern
  // Russia); tileBbox splits it into two non-crossing halves. Only a zero-width box is invalid.
  if (west === east) throw new Error('invalid bbox: west and east must differ');
  return [south, west, north, east];
}

export function tileBbox(bbox: BBox, maxSpanDegrees = DEFAULT_MAX_TILE_SPAN_DEGREES): BBox[] {
  const [south, west, north, east] = validateBbox(bbox);
  const span = Number.isFinite(maxSpanDegrees) && maxSpanDegrees > 0 ? maxSpanDegrees : DEFAULT_MAX_TILE_SPAN_DEGREES;
  const tiles: BBox[] = [];

  // Antimeridian crossing (west > east): split into two non-crossing longitude ranges so
  // each downstream GeoRSS tile is a normal west<east box. A normal box is a single range.
  const lngRanges: Array<[number, number]> = west > east ? [[west, 180], [-180, east]] : [[west, east]];

  for (let tileSouth = south; tileSouth < north; tileSouth = roundCoord(tileSouth + span)) {
    const tileNorth = Math.min(roundCoord(tileSouth + span), north);
    for (const [rangeWest, rangeEast] of lngRanges) {
      for (let tileWest = rangeWest; tileWest < rangeEast; tileWest = roundCoord(tileWest + span)) {
        const tileEast = Math.min(roundCoord(tileWest + span), rangeEast);
        tiles.push([tileSouth, tileWest, tileNorth, tileEast]);
      }
    }
  }

  return tiles;
}

export function envForBbox(bbox: BBox): 'na' | 'il' | 'row' {
  const [south, west, north, east] = validateBbox(bbox);
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;

  if (lat >= 24 && lat <= 72 && lng >= -170 && lng <= -50) return 'na';
  if (lat >= 29 && lat <= 34 && lng >= 34 && lng <= 36) return 'il';
  return 'row';
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
