'use client';

// React binding for the registry change bus. Any component that renders from the
// registry (sidebar, map, feed engine) calls useRegistryVersion() so it re-renders
// when custom sources or plugins register/unregister layers, feeds, or groups.

import { useSyncExternalStore } from 'react';
import { getRegistryVersion, subscribeRegistry } from './events';

export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribeRegistry, getRegistryVersion, getRegistryVersion);
}
