// Gemini rung of the LLM fallback chain — reuses the existing ai-engine client + key rotation
// but exposes a generic chat() shape (the framework's LLMClient), separate from ai-engine's
// IntelligenceContext-specific helpers.

import { createGeminiClient, rotateApiKey } from '@/lib/ai-engine';
import type { LLMMessage, LLMResult, LLMChatOptions } from '@/lib/intel/types';

const GEMINI_MODEL = 'gemini-2.0-flash';

export function geminiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key && key.trim().length > 0) keys.push(key.trim());
  }
  return keys;
}

export function geminiAvailable(): boolean {
  return geminiKeys().length > 0;
}

export async function geminiChat(messages: LLMMessage[], _opts?: LLMChatOptions): Promise<LLMResult> {
  const keys = geminiKeys();
  if (keys.length === 0) throw new Error('No Gemini API key configured');

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${m.content}`)
    .join('\n\n');

  const client = createGeminiClient(rotateApiKey(keys));
  const model = client.getGenerativeModel({
    model: GEMINI_MODEL,
    ...(system ? { systemInstruction: system } : {}),
  });
  const result = await model.generateContent(convo || system || '');
  const text = result.response.text();
  if (!text || !text.trim()) throw new Error('Gemini returned an empty response');
  return { text, model: GEMINI_MODEL, backend: 'gemini' };
}
