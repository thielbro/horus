import type { Browser, Page } from 'playwright';
import { envForBbox, parseBbox, tileBbox, validateBbox } from './bbox.ts';
import type {
  BBox,
  ScrapeWazePoliceCameraAlertsOptions,
  WazeAlertKind,
  WazeGeoRssTransport,
  WazePoliceCameraAlert,
  WazeScrapeError,
  WazeScrapeResult,
  WazeTransportMode,
} from './types.ts';

const WAZE_GEORSS_ENDPOINT = 'https://www.waze.com/live-map/api/georss';
const WAZE_LIVE_MAP_URL = 'https://www.waze.com/live-map';
const WAZE_LIVE_MAP_TYPES = 'alerts,traffic,users';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RECAPTCHA_SETTLE_MS = 5_000;
// Guardrails: cap the raw GeoRSS payload we parse, and the total normalized alerts we
// accumulate, so a pathological response can't OOM the parser or balloon memory.
const MAX_GEORSS_RESPONSE_CHARS = 5_000_000;
const MAX_NORMALIZED_ALERTS = 10_000;
const PLAYWRIGHT_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36';

// Endpoint and raw-field handling informed by public Waze Live Map/GeoRSS projects:
// https://github.com/guberm/waze-alerts-monitor and https://github.com/begundal-ug/waze-traffic
export async function scrapeWazePoliceCameraAlerts(options: ScrapeWazePoliceCameraAlertsOptions): Promise<WazeScrapeResult> {
  const bbox = typeof options.bbox === 'string' ? parseBbox(options.bbox) : validateBbox(options.bbox);
  const tiles = tileBbox(bbox, options.maxTileSpanDegrees);
  const transport = resolveTransport(options.transport ?? 'auto', { browserHeadless: options.browserHeadless ?? false });
  const errors: WazeScrapeError[] = [];
  const alerts: WazePoliceCameraAlert[] = [];

  try {
    await mapWithConcurrency(tiles, options.concurrency ?? DEFAULT_CONCURRENCY, async (tile) => {
      const env = envForBbox(tile);
      const url = buildWazeGeoRssUrl(tile, env);

      try {
        const response = await transport.fetchGeoRss(url, { bbox: tile, env, signal: options.signal });
        for (const rawAlert of extractRawAlerts(response)) {
          if (alerts.length >= MAX_NORMALIZED_ALERTS) break;
          const normalized = normalizeWazeAlert(rawAlert);
          if (normalized) alerts.push(normalized);
        }
      } catch (error) {
        errors.push(toScrapeError(error, tile));
      }
    });
  } finally {
    await transport.close?.();
  }

  return {
    timestamp: new Date().toISOString(),
    provider: 'waze',
    alerts: dedupeAlerts(alerts),
    errors,
  };
}

export function buildWazeGeoRssUrl(bbox: BBox, env = envForBbox(bbox)): string {
  const [south, west, north, east] = validateBbox(bbox);
  const query = [
    `top=${north}`,
    `bottom=${south}`,
    `left=${west}`,
    `right=${east}`,
    `env=${encodeURIComponent(env)}`,
    // Waze rejects alerts-only requests; request the browser app shape and drop non-alert data.
    `types=${WAZE_LIVE_MAP_TYPES}`,
  ].join('&');
  return `${WAZE_GEORSS_ENDPOINT}?${query}`;
}

export function classifyWazeAlert(raw: unknown): WazeAlertKind | null {
  const record = asRecord(raw);
  if (!record) return null;

  const tokens = [
    record.type,
    record.subtype,
    record.reportType,
    record.alertType,
    record.category,
  ]
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter(Boolean);

  if (tokens.some((token) => token.startsWith('POLICE'))) return 'police';
  if (tokens.some(isCameraToken)) return 'camera';
  return null;
}

export function normalizeWazeAlert(raw: unknown): WazePoliceCameraAlert | null {
  const record = asRecord(raw);
  if (!record) return null;

  const kind = classifyWazeAlert(record);
  if (!kind) return null;

  const coords = extractCoordinates(record);
  if (!coords) return null;

  const type = textOrNull(record.type ?? record.reportType ?? record.alertType);
  const subtype = textOrNull(record.subtype);
  const reportTime = extractReportTime(record);
  const reliability = numberOrNull(record.reliability);
  const confidence = numberOrNull(record.confidence);
  const description = textOrNull(record.description ?? record.reportDescription ?? record.street ?? record.city);
  const id = textOrNull(record.uuid ?? record.id ?? record.reportId) ?? fallbackAlertId(kind, type, subtype, coords, reportTime);

  return {
    id,
    provider: 'waze',
    kind,
    lat: coords.lat,
    lng: coords.lng,
    type,
    subtype,
    reportTime,
    reliability,
    confidence,
    description,
    raw: record,
  };
}

export function dedupeAlerts(alerts: WazePoliceCameraAlert[]): WazePoliceCameraAlert[] {
  const seen = new Set<string>();
  const deduped: WazePoliceCameraAlert[] = [];

  for (const alert of alerts) {
    const key = alert.id || fallbackAlertId(alert.kind, alert.type, alert.subtype, { lat: alert.lat, lng: alert.lng }, alert.reportTime);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(alert);
  }

  return deduped;
}

function resolveTransport(transport: WazeTransportMode | WazeGeoRssTransport, options: { browserHeadless: boolean }): WazeGeoRssTransport {
  if (typeof transport !== 'string') return transport;
  if (transport === 'http') return createHttpWazeTransport();
  if (transport === 'browser') return createBrowserWazeTransport(options);
  return createAutoWazeTransport(options);
}

function createAutoWazeTransport(options: { browserHeadless: boolean }): WazeGeoRssTransport {
  const http = createHttpWazeTransport();
  const browser = createBrowserWazeTransport(options);

  return {
    async fetchGeoRss(url, context) {
      try {
        return await http.fetchGeoRss(url, context);
      } catch (error) {
        if (error instanceof WazeTransportError && error.status === 403) {
          return browser.fetchGeoRss(url, context);
        }
        throw error;
      }
    },
    async close() {
      await browser.close?.();
    },
  };
}

function createHttpWazeTransport(): WazeGeoRssTransport {
  return {
    async fetchGeoRss(url, context) {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: WAZE_LIVE_MAP_URL,
          'User-Agent': 'Mozilla/5.0 HORUS Waze police-camera scraper',
        },
        signal: context.signal,
      });

      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // Best-effort connection cleanup; preserve the original HTTP status.
        }
        throw new WazeTransportError(`Waze HTTP ${response.status}`, response.status, 'http');
      }

      return response.json();
    },
  };
}

function createBrowserWazeTransport(options: { browserHeadless: boolean }): WazeGeoRssTransport {
  let browser: Browser | null = null;
  let page: Page | null = null;

  async function ensurePage(bbox: BBox) {
    if (page) return page;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: options.browserHeadless });
    const context = await browser.newContext({
      locale: 'en-US',
      userAgent: PLAYWRIGHT_CHROME_UA,
    });
    page = await context.newPage();
    await page.goto(buildLiveMapCenterUrl(bbox), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(DEFAULT_RECAPTCHA_SETTLE_MS);
    await page.waitForFunction(() => Boolean((globalThis as any).grecaptcha?.enterprise), undefined, { timeout: 30_000 });
    return page;
  }

  return {
    async fetchGeoRss(url, context) {
      const liveMapPage = await ensurePage(context.bbox);
      const browserFetch = new Function(
        'apiUrl',
        `
          return (async () => {
            const gon = JSON.parse(document.querySelector('#gon')?.textContent || '{}');
            const recaptcha = globalThis.grecaptcha;
            let token = null;
            if (gon.recaptchaActionSiteKey && recaptcha?.enterprise) {
              token = await new Promise((resolve, reject) => {
                recaptcha.enterprise.ready(() => {
                  recaptcha.enterprise.execute(gon.recaptchaActionSiteKey, { action: 'livemap' }).then(resolve, reject);
                });
              });
            }
            const headers = { Accept: 'application/json, text/plain, */*' };
            if (token) headers['x-recaptcha-token'] = token;
            const response = await fetch(apiUrl, { headers, credentials: 'include' });
            return { ok: response.ok, status: response.status, text: await response.text() };
          })();
        `,
      ) as (apiUrl: string) => Promise<{ ok: boolean; status: number; text: string }>;
      const result = await liveMapPage.evaluate(browserFetch, url);

      if (!result.ok) {
        throw new WazeTransportError(`Waze browser HTTP ${result.status}`, result.status, 'browser');
      }

      if (result.text.length > MAX_GEORSS_RESPONSE_CHARS) {
        throw new WazeTransportError(`Waze browser response too large (${result.text.length} chars)`, 413, 'browser');
      }
      return JSON.parse(result.text);
    },
    async close() {
      await browser?.close();
      browser = null;
      page = null;
    },
  };
}

function buildLiveMapCenterUrl(bbox: BBox): string {
  const [south, west, north, east] = validateBbox(bbox);
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  return `${WAZE_LIVE_MAP_URL}/directions?to=ll.${lat}%2C${lng}`;
}

function extractRawAlerts(response: unknown): unknown[] {
  const record = asRecord(response);
  if (!record) return [];
  if (Array.isArray(record.alerts)) return record.alerts;
  const nestedAlerts = asRecord(record.data)?.alerts;
  return Array.isArray(nestedAlerts) ? nestedAlerts : [];
}

function isCameraToken(token: string): boolean {
  return (
    token.includes('CAMERA') ||
    token.startsWith('SPEED_CAM') ||
    token.startsWith('SPEED') ||
    token.includes('RED_LIGHT') ||
    token.includes('REDLIGHT') ||
    token.includes('ENFORCEMENT')
  );
}

function extractCoordinates(record: Record<string, unknown>): { lat: number; lng: number } | null {
  const location = asRecord(record.location);
  const lat = numberOrNull(record.lat ?? record.latitude ?? record.y ?? location?.lat ?? location?.latitude ?? location?.y);
  const lng = numberOrNull(record.lng ?? record.lon ?? record.longitude ?? record.x ?? location?.lng ?? location?.lon ?? location?.longitude ?? location?.x);

  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function extractReportTime(record: Record<string, unknown>): string | null {
  const raw = record.pubMillis ?? record.reportMillis ?? record.reportTimeMillis ?? record.updateMillis ?? record.createdAt ?? record.reportTime;
  const numeric = numberOrNull(raw);
  if (numeric != null) {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  if (typeof raw === 'string') {
    const millis = Date.parse(raw);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
  }

  return null;
}

function fallbackAlertId(
  kind: WazeAlertKind,
  type: string | null,
  subtype: string | null,
  coords: { lat: number; lng: number },
  reportTime: string | null,
): string {
  return `waze-${stableHash({
    kind,
    type,
    subtype,
    lat: Math.round(coords.lat * 100_000) / 100_000,
    lng: Math.round(coords.lng * 100_000) / 100_000,
    reportTime,
  })}`;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const limit = Math.max(1, Math.trunc(concurrency || DEFAULT_CONCURRENCY));
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }),
  );
}

function toScrapeError(error: unknown, tile: BBox): WazeScrapeError {
  if (error instanceof WazeTransportError) {
    return { message: error.message, status: error.status, transport: error.transport, tile };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    tile,
  };
}

function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stableHash(value: unknown): string {
  const raw = stableStringify(value);
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(',')}}`;
}

class WazeTransportError extends Error {
  readonly status: number;
  readonly transport: string;

  constructor(message: string, status: number, transport: string) {
    super(message);
    this.name = 'WazeTransportError';
    this.status = status;
    this.transport = transport;
  }
}
