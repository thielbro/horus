// Waze mobile "RT" protocol layer (register/login/MapDisplayed) for the live
// crowd-sourced alert feed. Ported from spikes/001-waze-rt-alerts/spike.js,
// which reimplemented highway-radar-sabre-plus (MIT) —
// app/src/main/java/app/sabre/wzsabre/waze/*. Wire framing, command formats and
// error semantics are copied verbatim from that verified live client.

import protobuf from 'protobufjs';
import rtProtoJson from './waze-rt.proto.json';

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

// ── protobuf descriptor + ProtoBase64 framing ──────────────────────────────

export type RtBatch = ReturnType<protobuf.Type['decode']>;
export type RtRoot = protobuf.Root;

let cachedRoot: RtRoot | undefined;
export async function loadRtRoot(): Promise<RtRoot> {
  if (!cachedRoot) cachedRoot = protobuf.Root.fromJSON(rtProtoJson as protobuf.INamespace);
  return cachedRoot;
}

function requireRtRoot(): RtRoot {
  if (!cachedRoot) throw new Error('waze-rt: loadRtRoot() must run before framing/parsing');
  return cachedRoot;
}

// spike.js:82 protoLine, extracted to a module function taking any Element-shaped object.
// fromObject REQUIRES camelCase keys — snake_case silently encodes EMPTY messages and
// Waze answers "500 Bad proto element".
export function buildProtoLine(elementObj: Record<string, unknown>): string {
  const Batch = requireRtRoot().lookupType('Batch');
  const bytes = Batch.encode(Batch.fromObject({ element: [elementObj] })).finish();
  return 'ProtoBase64,' + Buffer.from(bytes).toString('base64');
}

// ── alert parsing (port of spike.js parseAlerts/enumName) ──────────────────

// Decoded messages arrive as untyped Message<{}> instances; this is the shape
// of the Element fields the alert-fetch path actually reads (see waze.proto).
interface RawElement {
  error?: { code?: number; description?: string } | null;
  loginError?: { errorType?: number; reason?: string } | null;
  loginResponse?: { loginError?: { errorType?: number; reason?: string } | null } | null;
  oldCommand?: string;
  addAlertAction?: { realtimeAlert?: {
    alertUuid?: string | null; id?: unknown;
    alertInfo?: {
      position?: { lonTimes1000000?: number; latTimes1000000?: number } | null;
      type?: number; subType?: number; azymuth?: number;
    } | null;
    alertReportingInfo?: {
      reportTime?: unknown; thumbsUpCount?: unknown;
      alertAddress?: { street?: string; city?: string } | null;
    } | null;
  } | null } | null;
}
interface RawBatch { element?: RawElement[] | null }

export interface RtAlert {
  uuid: string; id: string; type: string; subtype: string;
  lon: number; lat: number; magvar: number;
  pubMillis: number; thumbsUp: number | null;
  street: string | null; city: string | null;
}

// spike.js:76 enumName — reverse-lookup of the enum values map.
function rtEnumName(values: Record<string, number>, v: number | undefined | null): string {
  if (v === undefined || v === null) return '';
  for (const [n, val] of Object.entries(values)) if (val === v) return n;
  return String(v);
}

// Port of spike.js:270 parseAlerts. Output keys are camelCase (pubMillis/
// thumbsUp renamed from the spike's pub_millis/thumbs_up) so
// normalizeWazeAlert.extractReportTime picks them up with no changes.
export function parseRtAlerts(batch: RtBatch): RtAlert[] {
  const root = requireRtRoot();
  const typeValues = root.lookupEnum('AlertType').values;
  const subValues = root.lookupEnum('AlertSubType').values;
  const out: RtAlert[] = [];
  for (const el of (batch as unknown as RawBatch).element || []) {
    const ra = el.addAlertAction && el.addAlertAction.realtimeAlert;
    if (!ra || !ra.alertInfo || !ra.alertInfo.position) continue;
    const p = ra.alertInfo.position;
    let lonRaw = (p.lonTimes1000000 ?? 0) | 0; lonRaw = lonRaw >>> 0; // unsigned view then re-sign (upstream fix)
    if (lonRaw >= 0x80000000) lonRaw -= 0x100000000;
    const lon = lonRaw / 1e6;
    const lat = ((p.latTimes1000000 ?? 0) | 0) / 1e6;
    const info = ra.alertInfo;
    let typeName = rtEnumName(typeValues, info.type);
    if (typeName === 'UNKNOWN_TYPE' || typeName.startsWith('__NOT_IN_USE')) typeName = 'UNKNOWN';
    let subName = rtEnumName(subValues, info.subType);
    if (subName === 'NO_SUBTYPE' || subName.startsWith('__NOT_IN_USE')) subName = '';
    const ri = ra.alertReportingInfo || {};
    const reportTime = Number(ri.reportTime || 0);
    const addr = ri.alertAddress || {};
    out.push({
      uuid: ra.alertUuid || String(ra.id ?? ''),
      id: String(ra.id ?? ''),
      type: typeName,
      subtype: subName,
      lon, lat,
      magvar: (info.azymuth ?? 0) | 0,
      pubMillis: reportTime > 0 ? reportTime * 1000 : Date.now(),
      thumbsUp: ri.thumbsUpCount ? Number(ri.thumbsUpCount) : null,
      street: addr.street || null,
      city: addr.city || null,
    });
  }
  return out;
}

// ── in-band error classification (port of spike.js:132 errKind, no throw) ──

export type RtErrorKind = 'session' | 'transient' | 'rejected';

// Same ladder as the spike's errKind — except it returns instead of throwing
// and ignores non-fatal (code < 400) errors, continuing the scan. The client
// (Task 4) throws using this result; do not duplicate the ladder there.
export function classifyRtBatchError(batchLike: unknown): RtErrorKind | null {
  const batch = (batchLike ?? {}) as RawBatch;
  for (const el of batch.element || []) {
    const err = el.error;
    if (err && Number(err.code)) {
      const code = Number(err.code);
      const desc = String(err.description ?? '').toLowerCase();
      if (/relogin|unknown userid|secretkey missing|secret key missing/.test(desc)) return 'session';
      if (code >= 400 && code < 500) return 'rejected';
      if (code >= 500) return 'transient';
      continue; // non-fatal server error — ignore and keep scanning (spike.js:146)
    }
    const le = el.loginError;
    if (le) return le.errorType === 2 || le.errorType === 0 ? 'transient' : 'rejected';
    const lr = el.loginResponse && el.loginResponse.loginError;
    if (lr) return 'rejected';
  }
  return null;
}

