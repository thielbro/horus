import { bumpRegistry } from './events';
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
  // CCTV is split per continent so each request stays under the camera cap (no region can be
  // starved) and continents toggle independently. Each writes its own bucket.
  { id: 'cctv_europe', url: '/api/cctv?continent=europe', transform: (d) => ({ cameras_europe: d.cameras }), priority: 'lazy', activatedBy: ['cctv_europe'] },
  { id: 'cctv_north_america', url: '/api/cctv?continent=north-america', transform: (d) => ({ cameras_north_america: d.cameras }), priority: 'lazy', activatedBy: ['cctv_north_america'] },
  { id: 'cctv_asia', url: '/api/cctv?continent=asia', transform: (d) => ({ cameras_asia: d.cameras }), priority: 'lazy', activatedBy: ['cctv_asia'] },
  { id: 'cctv_oceania', url: '/api/cctv?continent=oceania', transform: (d) => ({ cameras_oceania: d.cameras }), priority: 'lazy', activatedBy: ['cctv_oceania'] },
  // NOTE: the OSM positions-only point layers (surveillance, police, flock,
  // mass_surveil) are NOT feed-engine fetches — they're viewport-driven via
  // useViewportLayers (src/lib/registry/useViewportLayers.ts), which queries
  // `/api/<layer>?bbox=<current view>` instead of fixed continent defaults.
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
const MAX_REGISTRY_FEEDS = 200;
let seeding = false;

export function registerFeed(feed: FeedDef): void {
  if (!feeds.has(feed.id) && feeds.size >= MAX_REGISTRY_FEEDS) {
    console.warn('[HORUS] Registry feed limit reached; ignoring feed', feed.id);
    return;
  }
  feeds.set(feed.id, feed);
  if (!seeding) bumpRegistry();
}
export function unregisterFeed(id: string): void {
  if (feeds.delete(id)) bumpRegistry();
}
export function clearFeedsByPlugin(pluginId: string): void {
  let changed = false;
  for (const [id, f] of feeds) if (f.pluginId === pluginId) { feeds.delete(id); changed = true; }
  if (changed) bumpRegistry();
}
export function getFeeds(): FeedDef[] {
  return [...feeds.values()];
}

seeding = true;
BUILTIN_FEEDS.forEach(registerFeed);
seeding = false;
