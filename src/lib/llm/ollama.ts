// OpenAI-compatible local-LLM client (Ollama / LM Studio / llama.cpp server).
// Server-side only. LLM_URL/LLM_MODEL come from process.env (settings → desktop env).
// We use plain fetch (NOT safeFetch) because the endpoint is our own configured local
// service — safeFetch's SSRF guard would block 127.0.0.1.

import { safeAbortTimeout, safeAbortAny, releaseResponseBody } from '@/lib/http-utils';
import type { LLMMessage, LLMResult, LLMChatOptions } from '@/lib/intel/types';

const DEFAULT_LLM_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'llama3.1';
const LLM_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_500;

export function llmUrl(): string {
  return (process.env.LLM_URL || DEFAULT_LLM_URL).replace(/\/+$/, '');
}
export function llmModel(): string {
  return process.env.LLM_MODEL?.trim() || DEFAULT_MODEL;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? safeAbortAny([signal, safeAbortTimeout(ms)]) : safeAbortTimeout(ms);
}

export async function ollamaChat(messages: LLMMessage[], opts?: LLMChatOptions): Promise<LLMResult> {
  const model = opts?.model || llmModel();
  const res = await fetch(`${llmUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: opts?.temperature ?? 0.2,
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: timeoutSignal(opts?.signal, LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    await releaseResponseBody(res);
    throw new Error(`Local LLM returned ${res.status}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Local LLM returned an empty response');
  return { text, model, backend: 'ollama' };
}

export async function ollamaHealth(): Promise<{ ok: boolean; models?: string[] }> {
  try {
    const res = await fetch(`${llmUrl()}/models`, { signal: safeAbortTimeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) {
      await releaseResponseBody(res);
      return { ok: false };
    }
    const data = await res.json();
    const models = Array.isArray(data?.data)
      ? data.data.map((m: { id?: string }) => m?.id).filter((id: unknown): id is string => typeof id === 'string')
      : undefined;
    return { ok: true, models };
  } catch {
    return { ok: false };
  }
}
