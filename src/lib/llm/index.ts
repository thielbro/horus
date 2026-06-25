// Unified LLM client for the intel framework.
//
// getLLM() returns one chat() behind a fallback chain: local LLM (Ollama/OpenAI-compatible)
// → Gemini cloud (existing ai-engine) → deterministic. The model only ever sees structured,
// source-tagged input from providers, so the deterministic rung is a usable degraded mode.
// Server-side only.

import type { LLMClient, LLMMessage, LLMResult, LLMBackend } from '@/lib/intel/types';
import { ollamaChat, ollamaHealth, llmUrl, llmModel } from './ollama';
import { geminiChat, geminiAvailable, GEMINI_MODEL } from './gemini-adapter';

const DETERMINISTIC_INPUT_LIMIT = 10_000;
const DETERMINISTIC_BODY_LIMIT = 1500;

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function deterministicChat(messages: LLMMessage[]): LLMResult {
  // Degraded mode: surface the structured facts the provider passed (its `- label: value`
  // bullets) rather than echoing the instruction prose — no model is available to summarize.
  let lastUser: LLMMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = messages[i];
      break;
    }
  }
  const content = (lastUser?.content || '').slice(0, DETERMINISTIC_INPUT_LIMIT);
  const bullets = content.split('\n').filter((l) => /^\s*[-*]\s/.test(l));
  const body = (bullets.length ? bullets.join('\n') : content).slice(0, DETERMINISTIC_BODY_LIMIT);
  const text = `_(No LLM backend reachable — showing gathered facts.)_\n\n${body}`;
  return { text, model: 'deterministic', backend: 'deterministic' };
}

let singleton: LLMClient | null = null;

export function getLLM(): LLMClient {
  if (singleton) return singleton;
  singleton = {
    async chat(messages, opts) {
      throwIfAborted(opts?.signal);
      // 1. Local LLM (preferred). A refused localhost connection fails fast → fall through.
      try {
        return await ollamaChat(messages, opts);
      } catch {
        throwIfAborted(opts?.signal);
        /* fall through */
      }
      // 2. Gemini cloud, if keys are configured.
      if (geminiAvailable()) {
        try {
          return await geminiChat(messages, opts);
        } catch {
          throwIfAborted(opts?.signal);
          /* fall through */
        }
      }
      // 3. Deterministic degraded mode.
      throwIfAborted(opts?.signal);
      return deterministicChat(messages);
    },
  };
  return singleton;
}

export interface LLMHealth {
  backend: LLMBackend;
  ok: boolean;
  url?: string;
  model?: string;
  models?: string[];
  geminiConfigured: boolean;
}

export async function llmHealth(): Promise<LLMHealth> {
  const geminiConfigured = geminiAvailable();
  const oll = await ollamaHealth();
  if (oll.ok) {
    return { backend: 'ollama', ok: true, url: llmUrl(), model: llmModel(), models: oll.models, geminiConfigured };
  }
  if (geminiConfigured) {
    return { backend: 'gemini', ok: true, model: GEMINI_MODEL, geminiConfigured };
  }
  return { backend: 'deterministic', ok: false, geminiConfigured };
}
