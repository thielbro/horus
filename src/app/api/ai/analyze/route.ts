/**
 * ═══════════════════════════════════════════════════════════════
 *  HORUS — AI Intelligence Analysis Endpoint
 *  POST /api/ai/analyze
 *  Rate-limited, multi-key Gemini integration
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createGeminiClient,
  rotateApiKey,
  analyzeIntelligence,
  generateLocalAnalysis,
  type IntelligenceContext,
} from '@/lib/ai-engine';

export const dynamic = 'force-dynamic';

/* ─────────────────────────────────────────────────────────────
   Rate Limiter — 5 requests per minute per IP
   ───────────────────────────────────────────────────────────── */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Map lives on globalThis so the single (HMR-guarded) cleanup timer always operates on
// the live map, not a stale module-local copy left behind by a dev hot reload.
const __analyzeStore = globalThis as unknown as { __horusAnalyzeRL?: Map<string, RateLimitEntry> };
if (!__analyzeStore.__horusAnalyzeRL) __analyzeStore.__horusAnalyzeRL = new Map<string, RateLimitEntry>();
const rateLimitMap = __analyzeStore.__horusAnalyzeRL;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function pruneRateLimitMap(now: number) {
  // First evict every expired entry.
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
  // If still over the cap, evict the oldest-inserted entries until back under it.
  // (Previously the size check sat inside the per-entry condition, which could delete
  // far more than the excess — effectively wiping live rate-limit state.)
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const excess = rateLimitMap.size - MAX_RATE_LIMIT_ENTRIES;
    let removed = 0;
    for (const ip of rateLimitMap.keys()) {
      if (removed >= excess) break;
      rateLimitMap.delete(ip);
      removed++;
    }
  }
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) pruneRateLimitMap(now);
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetIn: entry.resetAt - now };
}

// Periodic cleanup to prevent memory leaks.
// Guarded so dev hot-reloads (which re-import this module) don't stack duplicate timers.
const __analyzeTimers = globalThis as unknown as { __horusAnalyzeRLCleanup?: boolean };
if (!__analyzeTimers.__horusAnalyzeRLCleanup) {
  __analyzeTimers.__horusAnalyzeRLCleanup = true;
  setInterval(() => {
    pruneRateLimitMap(Date.now());
  }, 120_000);
}

/* ─────────────────────────────────────────────────────────────
   Collect API keys from environment
   ───────────────────────────────────────────────────────────── */

function getEnvApiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key && key.trim().length > 0) {
      keys.push(key.trim());
    }
  }
  return keys;
}

function createRequestSignal(requestSignal: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => requestSignal.removeEventListener('abort', abort),
  };
}

/* ─────────────────────────────────────────────────────────────
   Request / Response types
   ───────────────────────────────────────────────────────────── */

interface AnalyzeRequestBody {
  query: string;
  context: IntelligenceContext;
}

interface AnalyzeResponse {
  analysis: string;
  model: string;
  timestamp: string;
}

interface ErrorResponse {
  error: string;
  code: string;
  retryAfter?: number;
}

/* ─────────────────────────────────────────────────────────────
   POST Handler
   ───────────────────────────────────────────────────────────── */

export async function POST(
  request: NextRequest
): Promise<NextResponse<AnalyzeResponse | ErrorResponse>> {
  // Extract client IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  // Rate limit check
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded. Maximum 5 requests per minute.',
        code: 'RATE_LIMITED',
        retryAfter: Math.ceil(rateCheck.resetIn / 1000),
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rateCheck.resetIn / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(rateCheck.resetIn / 1000)),
        },
      }
    );
  }

  // Parse request body
  let body: AnalyzeRequestBody;
  try {
    body = (await request.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.', code: 'INVALID_BODY' },
      { status: 400 }
    );
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return NextResponse.json(
      { error: 'Query field is required and must be a non-empty string.', code: 'MISSING_QUERY' },
      { status: 400 }
    );
  }

  if (!body.context) {
    return NextResponse.json(
      { error: 'Intelligence context is required.', code: 'MISSING_CONTEXT' },
      { status: 400 }
    );
  }

  // Determine API key — user-provided header takes priority
  const userKey = request.headers.get('x-gemini-key')?.trim();
  let apiKey: string;

  if (userKey && userKey.length > 0) {
    apiKey = userKey;
  } else {
    const envKeys = getEnvApiKeys();
    if (envKeys.length === 0) {
      return NextResponse.json(
        {
          analysis: generateLocalAnalysis(
            body.context,
            body.query.trim(),
            'No Gemini API key is configured.'
          ),
          model: 'local-fallback',
          timestamp: new Date().toISOString(),
        },
        {
          headers: {
            'X-RateLimit-Remaining': String(rateCheck.remaining),
            'X-HORUS-AI-Fallback': 'local',
          },
        }
      );
    }
    apiKey = rotateApiKey(envKeys);
  }

  // Call Gemini
  const { signal, cleanup } = createRequestSignal(request.signal);
  try {
    const client = createGeminiClient(apiKey);
    const analysis = await analyzeIntelligence(client, body.context, body.query.trim(), signal);

    return NextResponse.json(
      {
        analysis,
        model: 'gemini-2.0-flash',
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'X-RateLimit-Remaining': String(rateCheck.remaining),
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown Gemini API error';

    // Detect specific Gemini error types
    if (message.includes('API_KEY_INVALID') || message.includes('API key not valid')) {
      return NextResponse.json(
        { error: 'Invalid Gemini API key. Please check your configuration.', code: 'INVALID_KEY' },
        { status: 401 }
      );
    }

    if (message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
      return NextResponse.json(
        {
          error: 'Gemini API quota exhausted. Try again later or provide your own API key.',
          code: 'QUOTA_EXHAUSTED',
        },
        { status: 429 }
      );
    }

    if (message.includes('SAFETY')) {
      return NextResponse.json(
        {
          error: 'Response blocked by Gemini safety filters. Try rephrasing your query.',
          code: 'SAFETY_BLOCKED',
        },
        { status: 422 }
      );
    }

    console.error('[HORUS AI] Analysis error:', message);
    return NextResponse.json(
      {
        analysis: generateLocalAnalysis(body.context, body.query.trim(), message),
        model: 'local-fallback',
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'X-RateLimit-Remaining': String(rateCheck.remaining),
          'X-HORUS-AI-Fallback': 'local',
        },
      }
    );
  } finally {
    cleanup();
  }
}
