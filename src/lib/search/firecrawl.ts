// Firecrawl search/scrape provider (self-hosted by default). One service covers both web
// search (/v1/search) and clean page-reading (/v1/scrape → markdown) for the LLM.
// Server-side only. FIRECRAWL_URL/FIRECRAWL_KEY come from process.env.

import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';
import { validateHost, type ValidationResult } from '@/lib/ssrf-guard';
import type { SearchProvider, SearchHit } from '@/lib/intel/types';

const DEFAULT_FIRECRAWL_URL = 'http://127.0.0.1:3002';
const SEARCH_TIMEOUT_MS = 20_000;
const SCRAPE_TIMEOUT_MS = 25_000;
const VALIDATE_HOST_TIMEOUT_MS = 5_000;
const MAX_RESULTS = 10;

function fcUrl(): string {
  return (process.env.FIRECRAWL_URL || DEFAULT_FIRECRAWL_URL).replace(/\/+$/, '');
}
function fcHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = process.env.FIRECRAWL_KEY;
  if (key && key.trim()) headers['Authorization'] = `Bearer ${key.trim()}`;
  return headers;
}
function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? safeAbortAny([signal, safeAbortTimeout(ms)]) : safeAbortTimeout(ms);
}

async function validateHostWithTimeout(host: string): Promise<ValidationResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ValidationResult>((resolve) => {
    timeoutId = setTimeout(() => resolve({ ok: false, reason: 'host validation timed out' }), VALIDATE_HOST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([validateHost(host), timeout]);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'host validation failed' };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export const firecrawlProvider: SearchProvider = {
  name: 'firecrawl',

  available() {
    try {
      new URL(fcUrl());
      return true;
    } catch {
      return false;
    }
  },

  async search(query, opts) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const res = await fetch(`${fcUrl()}/v1/search`, {
      method: 'POST',
      headers: fcHeaders(),
      body: JSON.stringify({
        query: trimmedQuery,
        limit: Math.min(opts?.count ?? 5, MAX_RESULTS),
        scrapeOptions: { formats: ['markdown'] },
      }),
      signal: timeoutSignal(opts?.signal, SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      throw new Error(`Firecrawl search returned ${res.status}`);
    }
    const data = await res.json();
    const items: unknown[] = Array.isArray(data?.data) ? data.data : [];
    return items
      .map((raw): SearchHit => {
        const it = (raw && typeof raw === 'object') ? raw as Record<string, any> : {};
        return {
          title: it.title || it.metadata?.title || it.url || 'Result',
          url: it.url || it.metadata?.sourceURL || '',
          snippet: it.description || it.metadata?.description || '',
          markdown: typeof it.markdown === 'string' ? it.markdown : undefined,
          source: 'firecrawl',
        };
      })
      .filter((h) => h.url);
  },

  async fetchPage(url, opts) {
    // SSRF guard: the URL may come from search results or the LLM — never let it reach an
    // internal host via Firecrawl. validateHost resolves DNS and rejects reserved ranges.
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const check = await validateHostWithTimeout(host);
    if (!check.ok) return null;

    const res = await fetch(`${fcUrl()}/v1/scrape`, {
      method: 'POST',
      headers: fcHeaders(),
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: timeoutSignal(opts?.signal, SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const data = await res.json();
    const md = data?.data?.markdown;
    if (typeof md !== 'string' || !md.trim()) return null;
    return { text: md, title: data?.data?.metadata?.title, url: data?.data?.metadata?.sourceURL || url };
  },
};
