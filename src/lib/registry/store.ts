// Group/layer store — seeded with builtins on import. Kept separate from the index
// barrel so the map engine can read it without a circular import.

import { BUILTIN_GROUPS, BUILTIN_LAYERS } from './builtins';
import type { RegistryGroup, RegistryLayer } from './types';

const groups = new Map<string, RegistryGroup>();
const layers = new Map<string, RegistryLayer>(); // insertion order preserved per group

export function registerGroup(group: RegistryGroup): void {
  groups.set(group.id, group);
}
export function registerLayer(layer: RegistryLayer): void {
  layers.set(layer.id, layer);
}

// Seed builtins once, in declaration order.
BUILTIN_GROUPS.forEach(registerGroup);
BUILTIN_LAYERS.forEach(registerLayer);

/** Groups in display order. */
export function getGroups(): RegistryGroup[] {
  return [...groups.values()].sort((a, b) => a.order - b.order);
}

/** All registered layers, in registration order. */
export function getLayers(): RegistryLayer[] {
  return [...layers.values()];
}

/** Layers belonging to a group, in registration order. */
export function getLayersForGroup(groupId: string): RegistryLayer[] {
  return getLayers().filter((l) => l.group === groupId);
}

export function getLayer(id: string): RegistryLayer | undefined {
  return layers.get(id);
}
