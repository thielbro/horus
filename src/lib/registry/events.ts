// Registry change bus — a tiny version counter + pub/sub so React consumers (sidebar,
// map, feed engine) re-render when layers/feeds/groups are registered or removed at
// runtime (custom sources, plugins). Leaf module: imported by store/feeds without cycles.

let version = 0;
const listeners = new Set<() => void>();

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
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
