import type { FeedDef } from './types';

// Faithful 1:1 encoding of page.tsx's former fetch wiring (core feeds + the layer-aware
// once-load + the polling subset). Special cases that don't fit the model — space-weather
// (its own state setter) and submarine-cables (a static asset, not /api) — stay in page.tsx.
export const BUILTIN_FEEDS: FeedDef[] = [
  // ── Core (startup + poll, always) ──
  { id: 'earthquakes', url: '/api/earthquakes', priority: 'core', intervalMs: 900_000 },
  { id: 'news', url: '/api/news', priority: 'core', intervalMs: 1_800_000 },
  { id: 'markets', url: '/api/markets', transform: (d) => ({ markets: d }), priority: 'core', startupDelayMs: 800, intervalMs: 900_000 },

  // ── Lazy (load once on layer activation; poll only if intervalMs set) ──
  { id: 'flights', url: '/api/flights', priority: 'lazy', activatedBy: ['flights', 'military', 'jets', 'private'], intervalMs: 300_000 },
  { id: 'satellites', url: '/api/satellites', priority: 'lazy', activatedBy: ['satellites'] },
  { id: 'fires', url: '/api/fires', priority: 'lazy', activatedBy: ['fires'] },
  { id: 'cctv', url: '/api/cctv?region=all&v=2', priority: 'lazy', activatedBy: ['cctv'] },
  { id: 'surveillance', url: '/api/surveillance', priority: 'lazy', activatedBy: ['surveillance'] },
  { id: 'maritime', url: '/api/maritime', transform: (d) => ({ maritime_ports: d.ports, maritime_chokepoints: d.chokepoints, maritime_ships: d.ships }), priority: 'lazy', activatedBy: ['maritime'], intervalMs: 10_000 },
  { id: 'balloons', url: '/api/balloons', transform: (d) => ({ balloons: d.balloons }), priority: 'lazy', activatedBy: ['balloons'], intervalMs: 300_000 },
  { id: 'radiation', url: '/api/radiation', transform: (d) => ({ radiation: d.stations }), priority: 'lazy', activatedBy: ['radiation'], intervalMs: 300_000 },
  { id: 'live_news', url: '/api/live-news', transform: (d) => ({ live_feeds: d.feeds }), priority: 'lazy', activatedBy: ['live_news'] },
  { id: 'weather', url: '/api/weather', transform: (d) => ({ weather_events: d.events }), priority: 'lazy', activatedBy: ['weather'] },
  { id: 'infrastructure', url: '/api/infrastructure', transform: (d) => ({ infrastructure: d.infrastructure }), priority: 'lazy', activatedBy: ['infrastructure'] },
  { id: 'gdelt', url: '/api/gdelt', transform: (d) => ({ gdelt: d.events }), priority: 'lazy', activatedBy: ['global_incidents'] },
  { id: 'malware', url: '/api/malware', transform: (d) => ({ malware_threats: d.threats }), priority: 'lazy', activatedBy: ['malware'] },
];

const feeds = new Map<string, FeedDef>();

export function registerFeed(feed: FeedDef): void {
  feeds.set(feed.id, feed);
}
export function getFeeds(): FeedDef[] {
  return [...feeds.values()];
}

BUILTIN_FEEDS.forEach(registerFeed);
