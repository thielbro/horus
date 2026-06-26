// Group/layer store — seeded with builtins on import. Kept separate from the index
// barrel so the map engine can read it without a circular import.

import { BUILTIN_GROUPS, BUILTIN_LAYERS } from './builtins';
import { bumpRegistry } from './events';
import type { RegistryGroup, RegistryLayer } from './types';

const groups = new Map<string, RegistryGroup>();
const layers = new Map<string, RegistryLayer>(); // insertion order preserved per group
const MAX_REGISTRY_GROUPS = 100;
const MAX_REGISTRY_LAYERS = 500;

let seeding = false;

export function registerGroup(group: RegistryGroup): void {
  if (!groups.has(group.id) && groups.size >= MAX_REGISTRY_GROUPS) {
    console.warn('[HORUS] Registry group limit reached; ignoring group', group.id);
    return;
  }
  groups.set(group.id, group);
  if (!seeding) bumpRegistry();
}
export function registerLayer(layer: RegistryLayer): void {
  if (!layers.has(layer.id) && layers.size >= MAX_REGISTRY_LAYERS) {
    console.warn('[HORUS] Registry layer limit reached; ignoring layer', layer.id);
    return;
  }
  layers.set(layer.id, layer);
  if (!seeding) bumpRegistry();
}
export function unregisterGroup(id: string): void {
  if (groups.delete(id)) bumpRegistry();
}
export function unregisterLayer(id: string): void {
  if (layers.delete(id)) bumpRegistry();
}

/** Remove every layer/group contributed by a plugin (used on uninstall/disable/reload). */
export function clearByPlugin(pluginId: string): void {
  let changed = false;
  for (const [id, l] of layers) if (l.pluginId === pluginId) { layers.delete(id); changed = true; }
  for (const [id, g] of groups) if (g.pluginId === pluginId) { groups.delete(id); changed = true; }
  if (changed) bumpRegistry();
}

// Seed builtins once, in declaration order (no per-item bump).
seeding = true;
BUILTIN_GROUPS.forEach(registerGroup);
BUILTIN_LAYERS.forEach(registerLayer);
seeding = false;

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
