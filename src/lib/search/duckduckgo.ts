// Keyless web-search / page-read provider, used when Firecrawl isn't configured. Search hits
// come from the DuckDuckGo HTML "lite" endpoint (no API key); page reads fetch the URL directly
// and strip it to text. Both are SSRF-guarded exactly like the Firecrawl provider. Server-side only.

import { stealthFetch } from '@/lib/stealthFetch';
import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';
import { validateHost, type ValidationResult } from '@/lib/ssrf-guard';
import type { SearchProvider, SearchHit } from '@/lib/intel/types';

const DDG_URL = 'https://lite.duckduckgo.com/lite/';
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const VALIDATE_HOST_TIMEOUT_MS = 5_000;
const MAX_PAGE_CHARS = 12_000;

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

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// DDG lite wraps every result URL in //duckduckgo.com/l/?uddg=<encoded real url>. Pull the real
// URL back out and drop sponsored/ad redirects (y.js / ad_domain).
function extractRealUrl(href: string): string | null {
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs);
    const uddg = u.searchParams.get('uddg');
    const real = uddg ? decodeURIComponent(uddg) : abs;
    if (/duckduckgo\.com\/y\.js/.test(real) || /[?&]ad_(domain|provider|type)=/.test(real)) return null;
    if (!/^https?:\/\//.test(real)) return null;
    return real;
  } catch {
    return null;
  }
}

export const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',

  available() {
    return true;
  },

  async search(query, opts) {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // DDG's HTML "lite" endpoint requires a POST form submit — a GET returns a bot challenge.
    const res = await stealthFetch(DDG_URL, {
      method: 'POST',
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: trimmed }).toString(),
      signal: timeoutSignal(opts?.signal, SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      throw new Error(`DuckDuckGo search returned ${res.status}`);
    }
    const html = await res.text();

    const limit = Math.min(opts?.count ?? 5, 10);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();

    // Pair each result-link anchor with the following result-snippet cell (lite renders them in
    // order). NOTE: DDG lite emits `href` BEFORE `class` and uses single quotes, so capture the
    // whole tag's attributes and pull href out separately (attribute order is not guaranteed).
    const linkRe = /<a\b([^>]*\bclass=["']result-link["'][^>]*)>([\s\S]*?)<\/a>/gi;
    const hrefRe = /href=["']([^"']+)["']/i;
    const snippetRe = /class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeEntities(sm[1]));

    let lm: RegExpExecArray | null;
    let idx = 0;
    while ((lm = linkRe.exec(html)) !== null && hits.length < limit) {
      const hrefMatch = hrefRe.exec(lm[1]);
      const url = hrefMatch ? extractRealUrl(hrefMatch[1].replace(/&amp;/g, '&')) : null;
      const title = decodeEntities(lm[2]);
      const i = idx++;
      if (!url || seen.has(url) || !title) continue;
      seen.add(url);
      hits.push({ title, url, snippet: snippets[i] || '', source: 'duckduckgo' });
    }
    return hits;
  },

  async fetchPage(url, opts) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const check = await validateHostWithTimeout(host);
    if (!check.ok) return null;

    const res = await stealthFetch(url, {
      headers: { Accept: 'text/html' },
      signal: timeoutSignal(opts?.signal, FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await releaseResponseBody(res);
      return null;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(ctype) && ctype) {
      await releaseResponseBody(res);
      return null;
    }
    const raw = await res.text();
    // Strip scripts/styles/markup down to readable text.
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    const text = decodeEntities(stripped).slice(0, MAX_PAGE_CHARS);
    if (!text) return null;
    return { text, title: titleMatch ? decodeEntities(titleMatch[1]) : undefined, url };
  },
};
