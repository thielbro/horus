// Waze mobile "RT" protocol layer (register/login/MapDisplayed) for the live
// crowd-sourced alert feed. Ported from spikes/001-waze-rt-alerts/spike.js,
// which reimplemented highway-radar-sabre-plus (MIT) —
// app/src/main/java/app/sabre/wzsabre/waze/*. Wire framing, command formats and
// error semantics are copied verbatim from that verified live client.

export type RtRegion = 'na' | 'il' | 'row';
export const RT_HOSTS: Record<RtRegion, string> = {
  na: 'rt-xlb-am.waze.com',
  il: 'rt-xlb-il.waze.com',
  row: 'rt-xlb-row.waze.com',
};
const M_PER_DEG_LAT = 110_574.0;
const mPerDegLon = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111_320.0;
const f6 = (v: number) => v.toFixed(6);

// Verbatim port of WazeRtCodec.mapDisplayedCommand (see spike.js:247).
export function mapDisplayedCommand(lonMin: number, latMin: number, lonMax: number, latMax: number): string {
  const midLon = (lonMin + lonMax) / 2, midLat = (latMin + latMax) / 2;
  const corners = `${f6(lonMin)},${f6(latMax)},${f6(lonMax)},${f6(latMax)},${f6(lonMax)},${f6(latMin)},${f6(lonMin)},${f6(latMin)}`;
  return `MapDisplayed,${corners},${f6(midLon)},${f6(midLat)},67186,${corners}`;
}

// box = [lonMin, latMin, lonMax, latMax]
export function shrinkBox(box: [number, number, number, number], f: number): [number, number, number, number] {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const hx = ((box[2] - box[0]) / 2) * f, hy = ((box[3] - box[1]) / 2) * f;
  return [cx - hx, cy - hy, cx + hx, cy + hy];
}

// Port of spike.js:27 region() — evaluated at the tile centre.
export function rtRegionForBbox(bbox: readonly [number, number, number, number]): RtRegion {
  const [south, west, north, east] = bbox;
  const lat = (south + north) / 2, lon = (west + east) / 2;
  if (lon >= -170.0 && lon <= -52.0 && lat >= -15.0 && lat <= 73.0) return 'na';
  if (lon >= 34.0 && lon <= 36.0 && lat >= 29.5 && lat <= 33.5) return 'il';
  return 'row';
}
