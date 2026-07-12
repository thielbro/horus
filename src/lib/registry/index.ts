// HORUS layer/source registry — public barrel. The declarative source of truth for
// groups, layers, feeds and (incrementally) map rendering. Builtins are seeded by the
// store/feeds modules on import; plugins register here too.

export * from './types';
export * from './store';
export { resolveIcon } from './icons';
export { registerFeed, unregisterFeed, clearFeedsByPlugin, getFeeds, BUILTIN_FEEDS } from './feeds';
export { useFeedEngine } from './engine';
export { useLiveFeedActivity } from './useLiveFeedActivity';
export { useViewportLayers } from './useViewportLayers';
export { addRegistryLayer, renderRegistryLayer, removeRegistryLayer, updateRegistryLayerTheme } from './mapEngine';
export { getRegistryVersion, subscribeRegistry } from './events';
export { useRegistryVersion } from './reactive';
export { buildCustomSource, registerCustomSource, unregisterCustomSource, migrateCustomSource, type CustomSourceSpec, type CustomSourceType, type CustomStreamFormat } from './customSource';
