// Registry change bus — a tiny version counter + pub/sub so React consumers (sidebar,
// map, feed engine) re-render when layers/feeds/groups are registered or removed at
// runtime (custom sources, plugins). Leaf module: imported by store/feeds without cycles.

let version = 0;
const listeners = new Set<() => void>();
// A correctly-behaved app has a handful of subscribers (sidebar, map, feed engine, a few
// panels). Reaching this many means a leak (e.g. a component subscribing without unsubscribing
// or a buggy plugin) — cap it so memory can't grow unbounded; evict the oldest to make room.
const MAX_REGISTRY_LISTENERS = 1000;

/** Bump on every registry mutation. */
export function bumpRegistry(): void {
  version++;
  listeners.forEach((l) => {
    try { l(); } catch (err) { console.error('[HORUS] Registry listener failed', err); }
  });
}

export function getRegistryVersion(): number {
  return version;
}

export function subscribeRegistry(cb: () => void): () => void {
  if (listeners.size >= MAX_REGISTRY_LISTENERS && !listeners.has(cb)) {
    const oldest = listeners.values().next().value;
    if (oldest) listeners.delete(oldest);
    console.warn('[HORUS] Registry listener cap reached; evicting oldest subscriber (possible leak)');
  }
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
