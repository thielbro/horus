import { NextResponse } from 'next/server';
import { llmHealth } from '@/lib/llm';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — LLM backend health.
 * GET /api/llm/health → which rung is live: local Ollama, Gemini cloud, or deterministic.
 * Backs the Settings UX so users can tell whether their local model is wired up.
 */
export async function GET() {
  try {
    const health = await llmHealth();
    return NextResponse.json(health, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { backend: 'deterministic', ok: false, geminiConfigured: false, error: e instanceof Error ? e.message : 'health check failed' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
