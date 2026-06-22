/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Intelligence Briefing Endpoint
 *  POST /api/ai/briefing
 *  Generates structured threat briefings via Gemini
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createGeminiClient,
  rotateApiKey,
  generateBriefing,
  generateLocalBriefing,
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
const __briefingStore = globalThis as unknown as { __osirisBriefingRL?: Map<string, RateLimitEntry> };
if (!__briefingStore.__osirisBriefingRL) __briefingStore.__osirisBriefingRL = new Map<string, RateLimitEntry>();
const rateLimitMap = __briefingStore.__osirisBriefingRL;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 10_000;

function pruneRateLimitMap(now: number) {
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt || rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
      rateLimitMap.delete(ip);
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

// Guard against duplicate timers across dev hot-reloads (the module is re-imported on
// every HMR cycle; a bare module-scope setInterval would stack up a new timer each time).
const __briefingTimers = globalThis as unknown as { __osirisBriefingRLCleanup?: boolean };
if (!__briefingTimers.__osirisBriefingRLCleanup) {
  __briefingTimers.__osirisBriefingRLCleanup = true;
  setInterval(() => {
    pruneRateLimitMap(Date.now());
  }, 120_000);
}

/* ─────────────────────────────────────────────────────────────
   Environment Key Collection
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

interface BriefingRequestBody {
  context: IntelligenceContext;
}

interface BriefingResponse {
  briefing: string;
  generatedAt: string;
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
): Promise<NextResponse<BriefingResponse | ErrorResponse>> {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

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
        },
      }
    );
  }

  let body: BriefingRequestBody;
  try {
    body = (await request.json()) as BriefingRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.', code: 'INVALID_BODY' },
      { status: 400 }
    );
  }

  if (!body.context) {
    return NextResponse.json(
      { error: 'Intelligence context is required.', code: 'MISSING_CONTEXT' },
      { status: 400 }
    );
  }

  const userKey = request.headers.get('x-gemini-key')?.trim();
  let apiKey: string;

  if (userKey && userKey.length > 0) {
    apiKey = userKey;
  } else {
    const envKeys = getEnvApiKeys();
    if (envKeys.length === 0) {
      return NextResponse.json(
        {
          briefing: generateLocalBriefing(body.context, 'No Gemini API key is configured.'),
          generatedAt: new Date().toISOString(),
        },
        {
          headers: {
            'X-RateLimit-Remaining': String(rateCheck.remaining),
            'X-OSIRIS-AI-Fallback': 'local',
          },
        }
      );
    }
    apiKey = rotateApiKey(envKeys);
  }

  const { signal, cleanup } = createRequestSignal(request.signal);
  try {
    const client = createGeminiClient(apiKey);
    const briefing = await generateBriefing(client, body.context, signal);

    return NextResponse.json(
      {
        briefing,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          'X-RateLimit-Remaining': String(rateCheck.remaining),
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown Gemini API error';

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
          error: 'Response blocked by Gemini safety filters. Try again.',
          code: 'SAFETY_BLOCKED',
        },
        { status: 422 }
      );
    }

    console.error('[OSIRIS AI] Briefing error:', message);
    return NextResponse.json(
      {
        briefing: generateLocalBriefing(body.context, message),
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          'X-RateLimit-Remaining': String(rateCheck.remaining),
          'X-OSIRIS-AI-Fallback': 'local',
        },
      }
    );
  } finally {
    cleanup();
  }
}
