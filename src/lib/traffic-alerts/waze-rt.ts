// Waze mobile "RT" protocol layer (register/login/MapDisplayed) for the live
// crowd-sourced alert feed. Ported from spikes/001-waze-rt-alerts/spike.js,
// which reimplemented highway-radar-sabre-plus (MIT) —
// app/src/main/java/app/sabre/wzsabre/waze/*. Wire framing, command formats and
// error semantics are copied verbatim from that verified live client.

import protobuf from 'protobufjs';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WazeTransportError } from './errors.ts';
import type { BBox, WazeGeoRssTransport } from './types.ts';
import rtProtoJson from './waze-rt.proto.json';

export type RtRegion = 'na' | 'il' | 'row';
export const RT_HOSTS: Record<RtRegion, string> = {
  na: 'rt-xlb-am.waze.com',
  il: 'rt-xlb-il.waze.com',
  row: 'rt-xlb-row.waze.com',
};
// Degree-per-metre helpers for the client's 1500 m circleToBox handshake box and
// the ±500 m clientInfo jitter (WazeRtCodec semantics, spike.js:22-23).
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
  loginResponse?: {
    loginError?: { errorType?: number; reason?: string } | null;
    loginSuccess?: { serverSessionId?: unknown; secretKey?: string | null; globalUserId?: unknown } | null;
  } | null;
  registerSuccessful?: { username?: string | null; password?: string | null; userId?: unknown } | null;
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
      // non-fatal server error (code < 400) — ignore it but still inspect this
      // element's loginError/loginResponse below (spike.js:146-157 falls through).
    }
    const le = el.loginError;
    if (le) return le.errorType === 2 || le.errorType === 0 ? 'transient' : 'rejected';
    const lr = el.loginResponse && el.loginResponse.loginError;
    if (lr) return 'rejected';
  }
  return null;
}

// ── anonymous-credentials cache ─────────────────────────────────────────────
// Anonymous registration is capped (~10/day): credentials must be cached and
// reused; a missing/corrupt cache is what triggers re-registration.

export interface RtCredentials { installationId?: string; community: string; secret: string; }

export function defaultRtCredsPath(): string {
  // Empty-string env vars are plausible (desktop/main.js uses ??=), so a blank
  // override must not become a real path.
  return process.env.WAZE_RT_CREDS_FILE?.trim()
    || path.join(os.homedir(), '.horus', 'waze-rt-credentials.json');
}

export async function saveRtCredentials(file: string, creds: RtCredentials): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(creds));
  try { await fsp.chmod(file, 0o600); } catch { /* Windows may not apply it — swallow */ }
}

// null means "no usable cache" — missing file, corrupt JSON, or wrong shape —
// and is the caller's signal to re-register.
export async function loadRtCredentials(file: string): Promise<RtCredentials | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object'
    && typeof (parsed as RtCredentials).community === 'string'
    && typeof (parsed as RtCredentials).secret === 'string') {
    return parsed as RtCredentials;
  }
  return null;
}

// ── RT client (port of spike.js CookieJar:34 + WazeRt:56) ──────────────────
// Wire behaviour copied verbatim from the live-proven spike; the deltas are
// injected fetch/debug logging, AbortSignal threading, and error classification
// routed through classifyRtBatchError instead of the spike's inline errKind throw.

const PROTOCOL_VERSION = 234;
const APP_VERSION = '5.17.1.0';
const RT_PATHS = {
  static: '/rtserver/distrib/static',
  login: '/rtserver/distrib/login',
  command: '/rtserver/distrib/command',
};
const WAIT_LOGIN = '8500';
const WAIT_COMMAND = '10500';

// In-band protocol failure carrying the spike's errKind taxonomy. The transport
// layer (asRtTransportError) and the Task 6 fallback chain key off `kind`;
// `status` preserves the HTTP code for plain transport errors.
export class RtProtocolError extends Error {
  readonly kind: RtErrorKind;
  readonly transport = 'rt';
  readonly status?: number;

  constructor(message: string, kind: RtErrorKind, status?: number) {
    super(message);
    this.name = 'RtProtocolError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

// Login sets a Waze-Session-Affinity cookie every later request must carry
// (port of spike.js:34 CookieJar).
class RtCookieJar {
  private readonly map = new Map<string, string>();
  absorb(resp: { headers: { getSetCookie?: () => string[]; get(name: string): string | null } }): void {
    let sc: string[] = [];
    if (typeof resp.headers.getSetCookie === 'function') sc = resp.headers.getSetCookie();
    else { const v = resp.headers.get('set-cookie'); if (v) sc = [v]; }
    for (const c of sc) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  header(): string | undefined {
    return this.map.size ? [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }
  clear(): void { this.map.clear(); }
}

// Raw command lines (verbatim from WazeRtCodec via spike.js:257-268).
const seeMeLine = () => 'SeeMe,1,2,T,T,T,1,-1,1,7';
const setMoodLine = () => 'SetMood,1';
const locationLine = (lon: number, lat: number) => `Location,${lon},${lat}`;
// box = [lonMin, latMin, lonMax, latMax]
function circleToBox(lon: number, lat: number, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / M_PER_DEG_LAT, dLon = radiusM / mPerDegLon(lat);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// First error element, human-readable. classifyRtBatchError is a pure message-less
// ladder (pinned by tests), so building the thrown message is the client's job.
function describeRtBatchError(batch: unknown): string {
  for (const el of (batch as RawBatch | null | undefined)?.element ?? []) {
    if (el.error && Number(el.error.code)) return `server error ${el.error.code}: ${el.error.description ?? ''}`;
    if (el.loginError) return `login error: ${el.loginError.errorType ?? el.loginError.reason ?? ''}`;
    const lr = el.loginResponse?.loginError;
    if (lr) return `login error (nested): ${lr.errorType ?? lr.reason ?? ''}`;
  }
  return 'unknown batch error';
}

// Port of spike.js:304 parseRemoved — RmAlert ids the server retracts mid-sweep.
function parseRtRemoved(batch: RtBatch): string[] {
  const ids: string[] = [];
  for (const el of (batch as unknown as RawBatch).element || []) {
    const oc = (el.oldCommand || '').trim();
    if (oc.startsWith('RmAlert,')) ids.push(oc.slice('RmAlert,'.length).trim());
  }
  return ids;
}

export interface WazeRtClientOptions {
  root: RtRoot;
  region: RtRegion;
  lon: number;
  lat: number;
  // RtCredentials accepts the optional installationId so a cached account keeps
  // the same device identity across scrapes (register is capped — it must persist).
  creds?: RtCredentials | null;
  installationId?: string;
  fetchImpl?: typeof globalThis.fetch;
  debugLog?: (message: string) => void;
}

export class WazeRtClient {
  private readonly Batch: protobuf.Type;
  private readonly UID: protobuf.Type;
  private readonly base: string;
  private readonly cookies = new RtCookieJar();
  private readonly lon: number;
  private readonly lat: number;
  // Fixed device profile (matches one of the 8 the upstream client rotates).
  private readonly device = { manufacturer: 'Google', model: 'Pixel 8', osVersion: '15-SDK35', screenW: 1080, screenH: 2400 };
  private readonly installationId: string;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly debugLog?: (message: string) => void;
  private seq = 1;
  private creds: RtCredentials | null = null;
  private session: { serverSessionId: string; secretKey: string; globalUserId: string } | null = null;

  constructor(opts: WazeRtClientOptions) {
    this.Batch = opts.root.lookupType('Batch');
    this.UID = opts.root.lookupType('UID');
    this.base = `https://${RT_HOSTS[opts.region] || RT_HOSTS.row}`;
    this.lon = opts.lon;
    this.lat = opts.lat;
    this.installationId = opts.installationId ?? opts.creds?.installationId ?? randomUUID();
    this.fetchImpl = opts.fetchImpl;
    this.debugLog = opts.debugLog;
    if (opts.creds) {
      this.creds = { installationId: this.installationId, community: opts.creds.community, secret: opts.creds.secret };
    }
  }

  // null until register() succeeds or credentials were injected. Carries the
  // installationId so the caller's credential cache can persist the device identity.
  get credentials(): RtCredentials | null { return this.creds; }

  private clientInfoLine(): string {
    // jitter +-500 m like the official client. NOTE: fromObject requires camelCase keys.
    const lonOff = ((Math.random() - 0.5) * 1000.0) / mPerDegLon(this.lat);
    const latOff = ((Math.random() - 0.5) * 1000.0) / M_PER_DEG_LAT;
    return buildProtoLine({
      clientInfo: {
        protocol: PROTOCOL_VERSION,
        clientVersion: APP_VERSION,
        lastPosition: {
          lonTimes1000000: Math.round((this.lon + lonOff) * 1e6) | 0,
          latTimes1000000: Math.round((this.lat + latOff) * 1e6) | 0,
        },
        manufacturer: this.device.manufacturer,
        model: this.device.model,
        osVersion: this.device.osVersion,
        locale: 'en',
        installationId: this.installationId,
        deviceType: 50,   // ANDROID_DEVICE
        appType: 1,       // WAZE
        display: [{ type: 2, width: this.device.screenW, height: this.device.screenH }], // BUILT_IN
        osLanguageId: 'en',
        sessionUuid: randomUUID(),
        currentTimeMillis: Date.now(),
        appFlavor: 5,     // ALPHA
      },
    });
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ code: number; body: Buffer }> {
    const h: Record<string, string> = { 'content-type': 'binary/octet-stream', ...headers };
    const ck = this.cookies.header();
    if (ck) h.cookie = ck;
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    // The caller's signal AND a 20 s backstop: a hung RT host can never pin a tile.
    const resp = await doFetch(url, {
      method: 'POST',
      headers: h,
      body: Buffer.from(body, 'utf8'),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    this.cookies.absorb(resp);
    const buf = Buffer.from(await resp.arrayBuffer());
    return { code: resp.status, body: buf };
  }

  // Anonymous registration is capped server-side (~10/day): the caller must
  // persist the returned credentials (Task 3 cache) and reuse them.
  async register(signal?: AbortSignal): Promise<void> {
    const body = this.clientInfoLine() + '\n' + buildProtoLine({ register: {} });
    const r = await this.post(this.base + RT_PATHS.static, body, {
      'user-agent': APP_VERSION,
      'x-waze-network-version': '3',
      'sequence-number': String(this.seq++),
    }, signal);
    if (r.code >= 400) throw Object.assign(new Error(`register HTTP ${r.code}`), { status: r.code });
    if (!r.body.length) throw new Error('empty register response');
    const batch = this.Batch.decode(r.body);
    const kind = classifyRtBatchError(batch);
    if (kind) throw new RtProtocolError(`register: ${describeRtBatchError(batch)}`, kind);
    for (const el of (batch as unknown as RawBatch).element || []) {
      const rs = el.registerSuccessful;
      if (rs && rs.username && rs.password) {
        this.creds = { installationId: this.installationId, community: rs.username, secret: rs.password };
        this.debugLog?.(`[spike] registered anonymous account: ${rs.username}`);
        return;
      }
    }
    throw new Error(`register: no RegisterSuccessful element (${r.body.length}B)`);
  }

  async login(signal?: AbortSignal): Promise<void> {
    if (!this.creds) throw new Error('login before register');
    this.cookies.clear();
    const creds = this.creds;
    const body = this.clientInfoLine() + '\n'
      + buildProtoLine({ loginRequest: { passwordCredential: { username: creds.community, password: creds.secret }, reason: 0 } }) + '\n'
      + buildProtoLine({ reportAdsSetting: {} });
    const r = await this.post(this.base + RT_PATHS.login, body, {
      'user-agent': `waze/${APP_VERSION}`,
      'cache-control': 'no-cache',
      'sequence-number': String(this.seq++),
      'x-waze-network-version': '3',
      'x-waze-wait-timeout': WAIT_LOGIN,
    }, signal);
    if (r.code >= 400) throw new RtProtocolError(`login HTTP ${r.code}`, r.code < 500 ? 'rejected' : 'transient', r.code);
    const batch = this.Batch.decode(r.body);
    const kind = classifyRtBatchError(batch);
    if (kind) throw new RtProtocolError(`login: ${describeRtBatchError(batch)}`, kind);
    for (const el of (batch as unknown as RawBatch).element || []) {
      const s = el.loginResponse && el.loginResponse.loginSuccess;
      if (s && Number(s.serverSessionId) !== 0 && s.secretKey) {
        this.session = { serverSessionId: String(s.serverSessionId), secretKey: String(s.secretKey), globalUserId: String(s.globalUserId ?? '') };
        this.seq = 2; // upstream resets the sequence after login
        this.debugLog?.(`[spike] login OK sessionId=${this.session.serverSessionId}`);
        return;
      }
    }
    throw new Error(`login: no LoginSuccess element (${r.body.length}B)`);
  }

  // Port of spike.js:214 — UID message (session id + secret key) base64'd into
  // the uid header, same framing style as buildProtoLine but not wrapped in a Batch.
  private uidHeader(): string {
    if (!this.session) throw new Error('command before login');
    const uid = this.UID.fromObject({ id: this.session.serverSessionId, secretKey: this.session.secretKey });
    return Buffer.from(this.UID.encode(uid).finish()).toString('base64');
  }

  async command(payload: string, opts: { attempt?: number; signal?: AbortSignal } = {}): Promise<RtBatch> {
    const attempt = opts.attempt ?? 1;
    const r = await this.post(this.base + RT_PATHS.command, payload, {
      'user-agent': APP_VERSION,
      'cache-control': 'no-cache',
      'sequence-number': String(this.seq++),
      'x-waze-network-version': '3',
      'x-waze-wait-timeout': WAIT_COMMAND,
      'uid': this.uidHeader(),
    }, opts.signal);
    if (r.code >= 400) throw new RtProtocolError(`command HTTP ${r.code}`, r.code < 500 ? 'session' : 'transient', r.code);
    if (!r.body.length) throw new Error('empty command response');
    const batch = this.Batch.decode(r.body);
    const kind = classifyRtBatchError(batch);
    if (kind) {
      // A fresh account's first /command almost always draws an in-band 504 Retry —
      // absorb with one retry (spike.js:234-240).
      if (kind === 'transient' && attempt < 2) {
        this.debugLog?.(`[spike] transient in-band error (${describeRtBatchError(batch)}) — retrying`);
        await new Promise((res) => setTimeout(res, 1200));
        return this.command(payload, { attempt: attempt + 1, signal: opts.signal });
      }
      throw new RtProtocolError(describeRtBatchError(batch), kind);
    }
    return batch;
  }

  // Register once per client when creds are missing, then ALWAYS login: logins are
  // cheap and a fresh session per scrape is by design (the server never re-sends
  // alerts within one session).
  async ensureSession(signal?: AbortSignal): Promise<void> {
    if (!this.creds) await this.register(signal);
    await this.login(signal);
  }

  // Sweep one tile (replaces the spike's fetchArea, spike.js:313-338): handshake
  // SeeMe/SetMood/Location/MapDisplayed on a 1500 m circle at the tile centre, then
  // 5 shrinking MapDisplayed boxes over the full tile (x0.5 steps, x0.75 pre-shrink
  // per command, 10 s wall-clock deadline checked before each command — the server
  // thins big viewports; small boxes recover near-driver detail). bbox is
  // [south, west, north, east]; internal boxes are [west, south, east, north].
  async fetchBox(
    bbox: readonly [number, number, number, number],
    signal?: AbortSignal,
  ): Promise<{ alerts: RtAlert[]; removed: string[] }> {
    const [south, west, north, east] = bbox;
    const tileBox: [number, number, number, number] = [west, south, east, north];
    const merged = new Map<string, RtAlert>();
    const removed = new Set<string>();
    const merge = (batch: RtBatch) => {
      for (const a of parseRtAlerts(batch)) merged.set(a.uuid, a);
      for (const id of parseRtRemoved(batch)) removed.add(id);
    };
    const hb = seeMeLine() + '\n' + setMoodLine() + '\n'
      + locationLine(this.lon, this.lat) + '\n'
      + (() => { const [x0, y0, x1, y1] = circleToBox(this.lon, this.lat, 1500); return mapDisplayedCommand(x0, y0, x1, y1); })();
    merge(await this.command(hb, { signal }));
    const steps = 5;
    const boxes: [number, number, number, number][] = [];
    { let b = tileBox;
      for (let i = 0; i < steps; i++) { boxes.push(b); b = shrinkBox(b, 0.5); } }
    const deadline = Date.now() + 10_000;
    for (const zoom of boxes) {
      if (Date.now() >= deadline) break;
      merge(await this.command(mapDisplayedCommand(...shrinkBox(zoom, 0.75)), { signal }));
    }
    return { alerts: [...merged.values()], removed: [...removed] };
  }
}

// ── createRtTransport: RT sweep exposed as a WazeGeoRssTransport ───────────

export interface RtTransportOptions {
  fetchImpl?: typeof globalThis.fetch;
  credsPath?: string;
  debugLog?: (message: string) => void;
  timeoutMsPerTile?: number; // reserved; default per-command 10_500 wait + 20_000 backstop
}

// Wrap anything thrown inside the RT path into the shared transport-error
// taxonomy the scrape pipeline reports: session 401, rejected 403, transient
// 504, HTTP 5xx 502, anything else 500 — always transport 'rt'.
function asRtTransportError(error: unknown): WazeTransportError {
  if (error instanceof WazeTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RtProtocolError) {
    const status = error.kind === 'session' ? 401 : error.kind === 'rejected' ? 403 : 504;
    return new WazeTransportError(message, status, 'rt');
  }
  const http = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(http) && http >= 500 && http < 600) return new WazeTransportError(message, 502, 'rt');
  return new WazeTransportError(message, 500, 'rt');
}

export function createRtTransport(options: RtTransportOptions = {}): WazeGeoRssTransport {
  const credsPath = options.credsPath ?? defaultRtCredsPath();
  let rootPromise: Promise<RtRoot> | undefined;             // lazy descriptor load
  let sessionPromise: Promise<WazeRtClient> | null = null;  // ONE session per transport; concurrent tiles share the handshake
  let sessionForRegion: RtRegion | null = null;

  const newClient = (root: RtRoot, region: RtRegion, bbox: BBox, creds: RtCredentials | null) =>
    new WazeRtClient({
      root,
      region,
      lon: (bbox[1] + bbox[3]) / 2,
      lat: (bbox[0] + bbox[2]) / 2,
      creds,
      ...options,
    });

  async function buildSession(root: RtRoot, region: RtRegion, bbox: BBox, signal?: AbortSignal): Promise<WazeRtClient> {
    const creds = await loadRtCredentials(credsPath);
    let fresh = newClient(root, region, bbox, creds);
    try {
      await fresh.ensureSession(signal);
    } catch (error) {
      // Stale cached creds (server says session/rejected on login): drop the
      // cache and re-register once — register is capped, so never more than that.
      if (error instanceof RtProtocolError && error.kind !== 'transient') {
        await fsp.rm(credsPath, { force: true }).catch(() => {});
        fresh = newClient(root, region, bbox, null);
        try {
          await fresh.ensureSession(signal);
        } catch (retryError) {
          throw asRtTransportError(retryError);
        }
      } else {
        throw asRtTransportError(error);
      }
    }
    if (fresh.credentials) await saveRtCredentials(credsPath, fresh.credentials);
    return fresh;
  }

  function ensureClient(root: RtRoot, region: RtRegion, bbox: BBox, signal?: AbortSignal): Promise<WazeRtClient> {
    // Synchronous check-and-claim: two tiles of the same region starting at the
    // same time must never race two registrations (the ~10/day cap).
    if (sessionPromise && sessionForRegion === region) return sessionPromise;
    sessionForRegion = region;
    const pending = buildSession(root, region, bbox, signal);
    sessionPromise = pending;
    pending.catch(() => {
      if (sessionPromise === pending) { // failed handshake: let the next tile retry
        sessionPromise = null;
        sessionForRegion = null;
      }
    });
    return pending;
  }

  return {
    // The GeoRSS url is ignored — the RT sweep answers from context.bbox.
    async fetchGeoRss(_url, { bbox, signal }) {
      const root = await (rootPromise ??= loadRtRoot());
      const session = await ensureClient(root, rtRegionForBbox(bbox), bbox, signal);
      try {
        const { alerts } = await session.fetchBox(bbox, signal);
        // Shape == GeoRSS: RtAlert records feed normalizeWazeAlert unchanged
        // (uuid/lat/lon/type/pubMillis/street), so the pipeline needs zero changes.
        return { alerts };
      } catch (error) {
        if (error instanceof RtProtocolError && error.kind === 'session') {
          // Mid-sweep session expiry: drop the creds and the shared session so the
          // NEXT tile rebuilds. The failed tile's retry is the Task 6 chain's job.
          await fsp.rm(credsPath, { force: true }).catch(() => {});
          sessionPromise = null;
          sessionForRegion = null;
        }
        throw asRtTransportError(error);
      }
    },
  };
}

// ── createRtFallbackChain: RT-first transport with a per-tile legacy fallback ──

// Mode 'auto' wiring: try the RT sweep for the tile; on ANY error answer the same
// tile from the legacy chain, exactly once. rt is never retried at this level — the
// RT call already consumed (or tried) the capped register budget, so an rt-level
// retry here would burn it again; recovery is the NEXT tile's fresh RT call.
export function createRtFallbackChain(
  rt: WazeGeoRssTransport,
  fallback: WazeGeoRssTransport,
): WazeGeoRssTransport {
  return {
    async fetchGeoRss(url, context) {
      try {
        return await rt.fetchGeoRss(url, context);
      } catch {
        return fallback.fetchGeoRss(url, context);
      }
    },
    // The RT leg has no close(); optional-chain both so either shape works.
    async close() {
      await rt.close?.();
      await fallback.close?.();
    },
  };
}

