// Spike 001: Waze mobile "RT" protocol client (register -> login -> handshake ->
// MapDisplayed boxes -> decoded alerts incl. POLICE).
//
// Protocol layer reimplemented in Node from highway-radar-sabre-plus (MIT),
// app/src/main/java/app/sabre/wzsabre/waze/* — wire framing, headers, command
// formats and error semantics copied verbatim from that verified live client.
//
// Usage: node spike.js [lat] [lon] [radiusM]     (default: downtown Los Angeles)
// Writes alerts-rt.json next to this file and prints a type histogram + police lines.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

const PROTOCOL_VERSION = 234;
const APP_VERSION = '5.17.1.0';
const RT_HOSTS = { na: 'rt-xlb-am.waze.com', il: 'rt-xlb-il.waze.com', row: 'rt-xlb-row.waze.com' };
const PATHS = { static: '/rtserver/distrib/static', login: '/rtserver/distrib/login', command: '/rtserver/distrib/command' };
const WAIT_LOGIN = '8500';
const WAIT_COMMAND = '10500';
const M_PER_DEG_LAT = 110574.0;
const mPerDegLon = (lat) => Math.cos((lat * Math.PI) / 180) * 111320.0;

const rtHost = (region) => RT_HOSTS[region] || RT_HOSTS.row;

function region(lat, lon) {
  if (lon >= -170.0 && lon <= -52.0 && lat >= -15.0 && lat <= 73.0) return 'na';
  if (lon >= 34.0 && lon <= 36.0 && lat >= 29.5 && lat <= 33.5) return 'il';
  return 'row';
}

// Cookie jar: login sets a Waze-Session-Affinity cookie every later request must carry.
class CookieJar {
  constructor() { this.map = new Map(); }
  absorb(resp) {
    let sc = [];
    if (typeof resp.headers.getSetCookie === 'function') sc = resp.headers.getSetCookie();
    else { const v = resp.headers.get('set-cookie'); if (v) sc = [v]; }
    for (const c of sc) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  header() { return this.map.size ? [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ') : undefined; }
  clear() { this.map.clear(); }
}

// Fixed device profile (matches one of the 8 the upstream client rotates).
const DEVICE = {
  manufacturer: 'Google', model: 'Pixel 8', osVersion: '15-SDK35',
  screenW: 1080, screenH: 2400, installationId: crypto.randomUUID(),
};

class WazeRt {
  constructor(root, regionName, lon, lat) {
    this.T = {
      Batch: root.lookupType('Batch'),
      ClientInfo: root.lookupType('ClientInfo'),
      LoginRequest: root.lookupType('LoginRequest'),
      Register: root.lookupType('Register'),
      ReportAdsSettings: root.lookupType('ReportAdsSettings'),
      UID: root.lookupType('UID'),
    };
    this.enums = { type: root.lookupEnum('AlertType').values, subtype: root.lookupEnum('AlertSubType').values };
    this.region = regionName;
    this.base = `https://${rtHost(regionName)}`;
    this.cookies = new CookieJar();
    this.seq = 1;
    this.credentials = null; // { community, secret }
    this.session = null;     // { serverSessionId, secretKey, globalUserId }
    this.lon = lon; this.lat = lat;
  }

  enumName(enumValues, v) {
    if (v === undefined || v === null) return '';
    for (const [n, val] of Object.entries(enumValues)) if (val === v) return n;
    return String(v);
  }

  protoLine(elementObj) {
    // fromObject maps both snake_case and camelCase keys to fields (plain create() would not).
    const bytes = this.T.Batch.encode(this.T.Batch.fromObject({ element: [elementObj] })).finish();
    return 'ProtoBase64,' + Buffer.from(bytes).toString('base64');
  }

  clientInfoLine() {
    // jitter +-500 m like the official client. NOTE: protobufjs fromObject requires camelCase keys.
    const lonOff = ((Math.random() - 0.5) * 1000.0) / mPerDegLon(this.lat);
    const latOff = ((Math.random() - 0.5) * 1000.0) / M_PER_DEG_LAT;
    return this.protoLine({
      clientInfo: {
        protocol: PROTOCOL_VERSION,
        clientVersion: APP_VERSION,
        lastPosition: {
          lonTimes1000000: Math.round((this.lon + lonOff) * 1e6) | 0,
          latTimes1000000: Math.round((this.lat + latOff) * 1e6) | 0,
        },
        manufacturer: DEVICE.manufacturer,
        model: DEVICE.model,
        osVersion: DEVICE.osVersion,
        locale: 'en',
        installationId: DEVICE.installationId,
        deviceType: 50,   // ANDROID_DEVICE
        appType: 1,       // WAZE
        display: [{ type: 2, width: DEVICE.screenW, height: DEVICE.screenH }], // BUILT_IN
        osLanguageId: 'en',
        sessionUuid: crypto.randomUUID(),
        currentTimeMillis: Date.now(),
        appFlavor: 5,     // ALPHA
      },
    });
  }

  async post(url, body, headers) {
    const h = { 'content-type': 'binary/octet-stream', ...headers };
    const ck = this.cookies.header();
    if (ck) h.cookie = ck;
    if (process.env.SPIKE_DEBUG) console.log('[debug] POST', url, 'headers', JSON.stringify(h), 'body', JSON.stringify(body).slice(0, 260));
    const resp = await fetch(url, {
      method: 'POST',
      headers: h,
      body: Buffer.from(body, 'utf8'),
      signal: AbortSignal.timeout(20000),
    });
    this.cookies.absorb(resp);
    const buf = Buffer.from(await resp.arrayBuffer());
    return { code: resp.status, body: buf };
  }

  static errKind(batch) {
    for (const el of batch.element || []) {
      const err = el.error;
      if (err && err.code) {
        const desc = String(err.description || '').toLowerCase();
        if (/relogin|unknown userid|secretkey missing|secret key missing/.test(desc)) {
          const e = new Error(`server error: ${err.description}`); e.kind = 'session'; throw e;
        }
        if (err.code >= 400 && err.code < 500) {
          const e = new Error(`server error ${err.code}: ${err.description}`); e.kind = 'rejected'; throw e;
        }
        if (err.code >= 500) {
          const e = new Error(`server error ${err.code}: ${err.description}`); e.kind = 'transient'; throw e;
        }
        console.log(`[spike] ignoring non-fatal server error ${err.code}: ${err.description}`);
      }
      const le = el.loginError;
      if (le) {
        const e = new Error(`login error: ${le.errorType ?? le.reason}`); e.kind = le.errorType === 2 || le.errorType === 0 ? 'transient' : 'rejected';
        throw e;
      }
      const lr = el.loginResponse;
      if (lr && lr.loginError) {
        const e = new Error(`login error (nested): ${lr.loginError.errorType ?? lr.loginError.reason}`);
        e.kind = 'rejected'; throw e;
      }
    }
  }

  async register() {
    const body = this.clientInfoLine() + '\n' + this.protoLine({ register: {} });
    const r = await this.post(this.base + PATHS.static, body, {
      'user-agent': APP_VERSION,
      'x-waze-network-version': '3',
      'sequence-number': String(this.seq++),
    });
    if (r.code >= 400) throw new Error(`register HTTP ${r.code}`);
    if (!r.body.length) throw new Error('empty register response');
    const batch = this.T.Batch.decode(r.body);
    if (process.env.SPIKE_DEBUG) {
      console.log('[debug] register resp', r.body.length + 'B:', JSON.stringify(this.T.Batch.toObject(batch, { longs: String, enums: Number, defaults: false })).slice(0, 900));
    }
    WazeRt.errKind(batch);
    for (const el of batch.element || []) {
      const rs = el.registerSuccessful;
      if (rs && rs.username && rs.password) {
        this.credentials = { community: rs.username, secret: rs.password };
        console.log(`[spike] registered anonymous account: ${rs.username}`);
        return;
      }
    }
    throw new Error(`register: no RegisterSuccessful element (${r.body.length}B)`);
  }

  async login() {
    if (!this.credentials) throw new Error('login before register');
    this.cookies.clear();
    const body = this.clientInfoLine() + '\n'
      + this.protoLine({ loginRequest: { passwordCredential: { username: this.credentials.community, password: this.credentials.secret }, reason: 0 } }) + '\n'
      + this.protoLine({ reportAdsSetting: {} });
    const r = await this.post(this.base + PATHS.login, body, {
      'user-agent': `waze/${APP_VERSION}`,
      'cache-control': 'no-cache',
      'sequence-number': String(this.seq++),
      'x-waze-network-version': '3',
      'x-waze-wait-timeout': WAIT_LOGIN,
    });
    if (r.code >= 400) throw Object.assign(new Error(`login HTTP ${r.code}`), { kind: r.code < 500 ? 'rejected' : 'transient' });
    const batch = this.T.Batch.decode(r.body);
    WazeRt.errKind(batch);
    for (const el of batch.element || []) {
      const s = el.loginResponse && el.loginResponse.loginSuccess;
      if (s && Number(s.serverSessionId) !== 0 && s.secretKey) {
        this.session = { serverSessionId: s.serverSessionId, secretKey: s.secretKey, globalUserId: String(s.globalUserId ?? '') };
        this.seq = 2; // upstream resets the sequence after login
        console.log(`[spike] login OK sessionId=${this.session.serverSessionId}`);
        return;
      }
    }
    throw new Error(`login: no LoginSuccess element (${r.body.length}B)`);
  }

  uidHeader() {
    const uid = this.T.UID.fromObject({ id: this.session.serverSessionId, secretKey: this.session.secretKey });
    return Buffer.from(this.T.UID.encode(uid).finish()).toString('base64');
  }

  async command(payload, { attempt = 1 } = {}) {
    const r = await this.post(this.base + PATHS.command, payload, {
      'user-agent': APP_VERSION,
      'cache-control': 'no-cache',
      'sequence-number': String(this.seq++),
      'x-waze-network-version': '3',
      'x-waze-wait-timeout': WAIT_COMMAND,
      'uid': this.uidHeader(),
    });
    if (r.code >= 400) throw Object.assign(new Error(`command HTTP ${r.code}`), { kind: r.code < 500 ? 'session' : 'transient' });
    if (!r.body.length) throw new Error('empty command response');
    const batch = this.T.Batch.decode(r.body);
    try {
      WazeRt.errKind(batch);
    } catch (e) {
      // A fresh account's first /command almost always draws an in-band 504 Retry — absorb with one retry.
      if (e.kind === 'transient' && attempt < 2) {
        console.log(`[spike] transient in-band error (${e.message}) — retrying`);
        await new Promise((res) => setTimeout(res, 1200));
        return this.command(payload, { attempt: attempt + 1 });
      }
      throw e;
    }
    return batch;
  }

  // ── raw command lines (verbatim from WazeRtCodec) ──
  static f6(v) { return v.toFixed(6); }
  static mapDisplayed(lonMin, latMin, lonMax, latMax) {
    const midLon = (lonMin + lonMax) / 2, midLat = (latMin + latMax) / 2;
    const c = WazeRt.f6;
    return 'MapDisplayed,'
      + `${c(lonMin)},${c(latMax)},${c(lonMax)},${c(latMax)},`
      + `${c(lonMax)},${c(latMin)},${c(lonMin)},${c(latMin)},`
      + `${c(midLon)},${c(midLat)},67186,`
      + `${c(lonMin)},${c(latMax)},${c(lonMax)},${c(latMax)},`
      + `${c(lonMax)},${c(latMin)},${c(lonMin)},${c(latMin)}`;
  }
  static seeMe() { return 'SeeMe,1,2,T,T,T,1,-1,1,7'; }
  static setMood() { return 'SetMood,1'; }
  static location(lon, lat) { return `Location,${lon},${lat}`; }
  static circleToBox(lon, lat, radiusM) {
    const dLat = radiusM / M_PER_DEG_LAT, dLon = radiusM / mPerDegLon(lat);
    return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
  }
  static shrink(box, f) {
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hx = ((box[2] - box[0]) / 2) * f, hy = ((box[3] - box[1]) / 2) * f;
    return [cx - hx, cy - hy, cx + hx, cy + hy];
  }

  parseAlerts(batch) {
    const out = [];
    for (const el of batch.element || []) {
      const ra = el.addAlertAction && el.addAlertAction.realtimeAlert;
      if (!ra || !ra.alertInfo || !ra.alertInfo.position) continue;
      const p = ra.alertInfo.position;
      let lonRaw = (p.lonTimes1000000 | 0) >>> 0; // unsigned view then re-sign (upstream fix)
      if (lonRaw >= 0x80000000) lonRaw -= 0x100000000;
      const lon = lonRaw / 1e6;
      const lat = (p.latTimes1000000 | 0) / 1e6;
      const info = ra.alertInfo;
      let typeName = this.enumName(this.enums.type, info.type);
      if (typeName === 'UNKNOWN_TYPE' || typeName.startsWith('__NOT_IN_USE')) typeName = 'UNKNOWN';
      let subName = this.enumName(this.enums.subtype, info.subType);
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
        magvar: info.azymuth | 0,
        pub_millis: reportTime > 0 ? reportTime * 1000 : Date.now(),
        thumbs_up: ri.thumbsUpCount ? Number(ri.thumbsUpCount) : null,
        street: addr.street || null,
        city: addr.city || null,
      });
    }
    return out;
  }

  parseRemoved(batch) {
    const ids = [];
    for (const el of batch.element || []) {
      const oc = (el.oldCommand || '').trim();
      if (oc.startsWith('RmAlert,')) ids.push(oc.slice('RmAlert,'.length).trim());
    }
    return ids;
  }

  async fetchArea(radiusM) {
    if (!this.credentials) await this.register();
    await this.login();
    // handshake (real viewport query; server never re-sends these alerts this session)
    const hb = WazeRt.seeMe() + '\n' + WazeRt.setMood() + '\n'
      + WazeRt.location(this.lon, this.lat) + '\n'
      + (() => { const [x0, y0, x1, y1] = WazeRt.circleToBox(this.lon, this.lat, 1500); return WazeRt.mapDisplayed(x0, y0, x1, y1); })();
    const merged = new Map();
    const removed = new Set();
    const merge = (batch) => {
      for (const a of this.parseAlerts(batch)) merged.set(a.uuid, a);
      for (const id of this.parseRemoved(batch)) removed.add(id);
    };
    merge(await this.command(hb));
    // shrinking-box series: server thins big viewports, small boxes recover near-driver detail
    const steps = 5;
    const boxes = [];
    { let b = WazeRt.circleToBox(this.lon, this.lat, radiusM);
      for (let i = 0; i < steps; i++) { boxes.push(b); b = WazeRt.shrink(b, 0.5); } }
    const deadline = Date.now() + 10000;
    for (const zoom of boxes) {
      if (Date.now() >= deadline) break;
      merge(await this.command(WazeRt.mapDisplayed(...WazeRt.shrink(zoom, 0.75))));
    }
    return { alerts: [...merged.values()], removed: [...removed] };
  }
}

async function main() {
  const lat = Number(process.argv[2] || 34.0522);
  const lon = Number(process.argv[3] || -118.2437);
  const radiusM = Number(process.argv[4] || 10000);
  const t0 = Date.now();
  const root = await protobuf.load(path.join(__dirname, 'waze.proto'));
  const rg = region(lat, lon);
  console.log(`[spike] point=${lat.toFixed(4)},${lon.toFixed(4)} radius=${radiusM}m region=${rg} host=${rtHost(rg)}`);
  const client = new WazeRt(root, rg, lon, lat);
  const { alerts, removed } = await client.fetchArea(radiusM);
  const byType = {};
  for (const a of alerts) byType[a.type] = (byType[a.type] || 0) + 1;
  console.log(`[spike] ${alerts.length} alerts merged (${removed.length} removed) in ${Date.now() - t0}ms`);
  console.log('[spike] types:', JSON.stringify(byType));
  const police = alerts.filter((a) => a.type === 'POLICE');
  console.log(`[spike] POLICE: ${police.length}`);
  for (const a of police) {
    console.log(`  POLICE ${a.subtype || '(no subtype)'} @ ${a.lon.toFixed(5)},${a.lat.toFixed(5)} `
      + `[(a)${a.street || '?'} / ${(a.city || '?')}] ${(a.thumbs_up || 0)}+ `
      + `age=${Math.round((Date.now() - a.pub_millis) / 60000)}min uuid=${a.uuid.slice(0, 8)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'alerts-rt.json'), JSON.stringify({ point: [lat, lon], radiusM, region: rg, fetched_at: new Date().toISOString(), removed: removed.length, alerts }, null, 1));
  console.log('[spike] wrote alerts-rt.json');
  process.exit(alerts.length ? 0 : 2);
}

main().catch((e) => { console.error('[spike] FAILED:', e && e.message || e, e && e.kind ? `(${e.kind})` : ''); process.exit(1); });
