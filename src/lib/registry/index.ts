// OSIRIS layer/source registry — public barrel. The declarative source of truth for
// groups, layers, feeds and (incrementally) map rendering. Builtins are seeded by the
// store/feeds modules on import; plugins register here too.

export * from './types';
export * from './store';
export { resolveIcon } from './icons';
export { registerFeed, getFeeds, BUILTIN_FEEDS } from './feeds';
export { useFeedEngine } from './engine';
export { addRegistryLayer, renderRegistryLayer } from './mapEngine';
