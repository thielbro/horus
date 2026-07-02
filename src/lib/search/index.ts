// Search provider selection. Keyless DuckDuckGo is the default so web leads work out of the
// box; Firecrawl is used only when FIRECRAWL_URL is explicitly configured (self-hosted or cloud).
// SEARCH_PROVIDER can force a choice ('firecrawl' | 'duckduckgo').

import type { SearchProvider } from '@/lib/intel/types';
import { firecrawlProvider } from './firecrawl';
import { duckduckgoProvider } from './duckduckgo';

export function getSearch(): SearchProvider {
  const forced = process.env.SEARCH_PROVIDER?.trim().toLowerCase();
  if (forced === 'firecrawl') return firecrawlProvider;
  if (forced === 'duckduckgo') return duckduckgoProvider;
  // Auto: Firecrawl when its URL is set, otherwise the keyless DuckDuckGo provider.
  if (process.env.FIRECRAWL_URL && process.env.FIRECRAWL_URL.trim()) return firecrawlProvider;
  return duckduckgoProvider;
}
