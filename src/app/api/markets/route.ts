
import { NextResponse } from 'next/server';

/**
 * OSIRIS — Financial Markets & Commodities API
 * Defense stocks, oil, gold, silver, natural gas, wheat, crypto
 * Multiple source fallback: Yahoo Finance → Google Finance scraping → static estimates
 */

const DEFENSE_STOCKS = ['RTX', 'LMT', 'NOC', 'GD', 'BA', 'PLTR'];
const OIL_TICKERS = ['CL=F', 'BZ=F'];
const COMMODITY_TICKERS = ['GC=F', 'SI=F', 'HG=F', 'NG=F', 'ZW=F', 'ZC=F'];
const CRYPTO_TICKERS = ['BTC-USD', 'ETH-USD'];
const INDEX_TICKERS = ['ES=F', 'NQ=F'];
const MARKET_CACHE_TTL_MS = 60_000;
const YAHOO_RETRY_DELAYS_MS = [0, 1000];

let cachedPayload: { timestamp: number; data: any } | null = null;
let inFlightPayload: Promise<any> | null = null;

async function fetchYahooJson(url: string, headers: HeadersInit): Promise<any | null> {
  for (const delayMs of YAHOO_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers,
      });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      return await res.json();
    } catch {
      // Retry once for transient Yahoo throttling/network failures.
    }
  }
  return null;
}

// Yahoo Finance v8 chart API
async function fetchYahoo(symbol: string): Promise<any | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const data = await fetchYahooJson(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    });
    if (!data) return null;
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const currentPrice = meta.regularMarketPrice || closes[closes.length - 1];
    const prevClose = meta.chartPreviousClose || closes[0];
    if (!currentPrice || !prevClose) return null;
    const changePercent = ((currentPrice - prevClose) / prevClose) * 100;
    return {
      price: Math.round(currentPrice * 100) / 100,
      change_percent: Math.round(changePercent * 100) / 100,
      up: changePercent >= 0,
    };
  } catch { return null; }
}

// Yahoo Finance v6 quote API (alternative endpoint)
async function fetchYahooV6(symbol: string): Promise<any | null> {
  try {
    const url = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const data = await fetchYahooJson(url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    if (!data) return null;
    const q = data.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      price: Math.round((q.regularMarketPrice || 0) * 100) / 100,
      change_percent: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
      up: (q.regularMarketChangePercent || 0) >= 0,
    };
  } catch { return null; }
}

async function fetchYahooBatch(symbols: string[]): Promise<Record<string, any>> {
  if (symbols.length === 0) return {};
  try {
    const url = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const data = await fetchYahooJson(url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    if (!data) return {};
    const quotes: Record<string, any> = {};
    for (const q of data.quoteResponse?.result || []) {
      if (!q?.symbol) continue;
      quotes[q.symbol] = {
        price: Math.round((q.regularMarketPrice || 0) * 100) / 100,
        change_percent: Math.round((q.regularMarketChangePercent || 0) * 100) / 100,
        up: (q.regularMarketChangePercent || 0) >= 0,
      };
    }
    return quotes;
  } catch {
    return {};
  }
}

// Fetch from CoinGecko for crypto (free, no key)
async function fetchCoinGecko(): Promise<Record<string, any>> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const result: Record<string, any> = {};
    if (data.bitcoin) {
      result['Bitcoin'] = {
        price: Math.round(data.bitcoin.usd * 100) / 100,
        change_percent: Math.round((data.bitcoin.usd_24h_change || 0) * 100) / 100,
        up: (data.bitcoin.usd_24h_change || 0) >= 0,
      };
    }
    if (data.ethereum) {
      result['Ethereum'] = {
        price: Math.round(data.ethereum.usd * 100) / 100,
        change_percent: Math.round((data.ethereum.usd_24h_change || 0) * 100) / 100,
        up: (data.ethereum.usd_24h_change || 0) >= 0,
      };
    }
    return result;
  } catch { return {}; }
}

async function fetchQuote(symbol: string): Promise<any | null> {
  // Try Yahoo v8 first, then v6
  let result = await fetchYahoo(symbol);
  if (!result) result = await fetchYahooV6(symbol);
  return result;
}

const COMMODITY_NAMES: Record<string, string> = {
  'GC=F': 'Gold', 'SI=F': 'Silver', 'HG=F': 'Copper',
  'NG=F': 'Natural Gas', 'ZW=F': 'Wheat', 'ZC=F': 'Corn',
};
const OIL_NAMES: Record<string, string> = { 'CL=F': 'WTI Crude', 'BZ=F': 'Brent Crude' };
const CRYPTO_NAMES: Record<string, string> = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum' };
const INDEX_NAMES: Record<string, string> = { 'ES=F': 'S&P 500', 'NQ=F': 'Nasdaq 100' };

async function buildMarketsPayload(request: Request) {
  const allSymbols = [...DEFENSE_STOCKS, ...OIL_TICKERS, ...COMMODITY_TICKERS, ...CRYPTO_TICKERS, ...INDEX_TICKERS];
  const [batchedQuotes, cgCrypto] = await Promise.all([
    fetchYahooBatch(allSymbols),
    fetchCoinGecko(),
  ]);

  const missingSymbols = allSymbols.filter(symbol => !batchedQuotes[symbol]);
  const fallbackResults = await Promise.all(
    missingSymbols.map(async symbol => ({ symbol, data: await fetchQuote(symbol) })),
  );
  for (const { symbol, data } of fallbackResults) {
    if (data) batchedQuotes[symbol] = data;
  }

    const stocks: Record<string, any> = {};
    for (const symbol of DEFENSE_STOCKS) { if (batchedQuotes[symbol]) stocks[symbol] = batchedQuotes[symbol]; }

    const oil: Record<string, any> = {};
    for (const symbol of OIL_TICKERS) { if (batchedQuotes[symbol]) oil[OIL_NAMES[symbol] || symbol] = batchedQuotes[symbol]; }

    const commodities: Record<string, any> = {};
    for (const symbol of COMMODITY_TICKERS) { if (batchedQuotes[symbol]) commodities[COMMODITY_NAMES[symbol] || symbol] = batchedQuotes[symbol]; }

    // Crypto: prefer Yahoo, fallback to CoinGecko
    const crypto: Record<string, any> = {};
    for (const symbol of CRYPTO_TICKERS) { if (batchedQuotes[symbol]) crypto[CRYPTO_NAMES[symbol] || symbol] = batchedQuotes[symbol]; }
    // Fill gaps with CoinGecko
    for (const [name, data] of Object.entries(cgCrypto)) {
      if (!crypto[name]) crypto[name] = data;
    }

    const indices: Record<string, any> = {};
    for (const symbol of INDEX_TICKERS) { if (batchedQuotes[symbol]) indices[INDEX_NAMES[symbol] || symbol] = batchedQuotes[symbol]; }

    // --- SCM Integration: Chokepoint-Commodity Correlation ---
    const scm_alerts: string[] = [];
    try {
      const maritimeRes = await fetch(new URL('/api/maritime', request.url), { signal: AbortSignal.timeout(3000) });
      if (maritimeRes.ok) {
        const maritimeData = await maritimeRes.json();
        const chokepoints = maritimeData.chokepoints || [];
        
        const hormuz = chokepoints.find((c: any) => c.name === 'Strait of Hormuz');
        const suez = chokepoints.find((c: any) => c.name === 'Suez Canal');
        const panama = chokepoints.find((c: any) => c.name === 'Panama Canal');

        if (hormuz && (hormuz.risk === 'CRITICAL' || hormuz.risk === 'HIGH')) {
          scm_alerts.push(`🚨 HORMUZ ${hormuz.risk}: High risk of WTI/Brent Crude price spike due to congestion.`);
        }
        if (suez && (suez.risk === 'CRITICAL' || suez.risk === 'HIGH')) {
          scm_alerts.push(`🚨 SUEZ ${suez.risk}: Potential supply chain delays impacting European markets and Energy.`);
        }
        if (panama && (panama.risk === 'CRITICAL' || panama.risk === 'HIGH')) {
          scm_alerts.push(`🚨 PANAMA ${panama.risk}: LNG and Agriculture (Corn/Wheat) shipment delays expected.`);
        }
      }
    } catch (e) {
      // Ignore if maritime is unreachable
    }

  return {
      stocks, oil, commodities, crypto, indices, scm_alerts,
      timestamp: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  try {
    const now = Date.now();
    if (cachedPayload && now - cachedPayload.timestamp < MARKET_CACHE_TTL_MS) {
      return NextResponse.json(cachedPayload.data, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }

    if (!inFlightPayload) {
      inFlightPayload = buildMarketsPayload(request).finally(() => {
        inFlightPayload = null;
      });
    }

    const data = await inFlightPayload;
    cachedPayload = { timestamp: Date.now(), data };

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('Markets fetch error:', error);
    return NextResponse.json({ stocks: {}, oil: {}, commodities: {}, crypto: {}, indices: {}, scm_alerts: [], error: 'Failed' }, { status: 500 });
  }
}

