// Intel provider registry — keyed by `kind`, mirroring RESOLVERS in the intel sidecar.
// Real providers (address, route, company, …) register here as later phases land.

import type { IntelProvider } from '@/lib/intel/types';
import { stubProvider } from './stub';

const PROVIDERS = new Map<string, IntelProvider>();

export function registerProvider(provider: IntelProvider): void {
  PROVIDERS.set(provider.kind, provider);
}

export function getProvider(kind: string): IntelProvider | null {
  return PROVIDERS.get(kind) || null;
}

export function providerKinds(): string[] {
  return [...PROVIDERS.keys()];
}

registerProvider(stubProvider);
