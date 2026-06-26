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
  if (west >= east) throw new Error('invalid bbox: west must be less than east');
  return [south, west, north, east];
}

export function tileBbox(bbox: BBox, maxSpanDegrees = DEFAULT_MAX_TILE_SPAN_DEGREES): BBox[] {
  const [south, west, north, east] = validateBbox(bbox);
  const span = Number.isFinite(maxSpanDegrees) && maxSpanDegrees > 0 ? maxSpanDegrees : DEFAULT_MAX_TILE_SPAN_DEGREES;
  const tiles: BBox[] = [];

  for (let tileSouth = south; tileSouth < north; tileSouth = roundCoord(tileSouth + span)) {
    const tileNorth = Math.min(roundCoord(tileSouth + span), north);
    for (let tileWest = west; tileWest < east; tileWest = roundCoord(tileWest + span)) {
      const tileEast = Math.min(roundCoord(tileWest + span), east);
      tiles.push([tileSouth, tileWest, tileNorth, tileEast]);
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
