// Search provider selection. Firecrawl is the only backend today; the SearchProvider
// interface keeps Brave/Tavily/SearXNG pluggable later (selected via a future SEARCH_PROVIDER).

import type { SearchProvider } from '@/lib/intel/types';
import { firecrawlProvider } from './firecrawl';

export function getSearch(): SearchProvider {
  return firecrawlProvider;
}
