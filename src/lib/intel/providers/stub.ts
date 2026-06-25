// Stub intel provider — exercises the full compile pipeline (gather → graph → LLM synth)
// without any external geocode/search dependency. Used to verify Phase 1 end-to-end and as a
// reference implementation for real providers (address, route, …).

import type { IntelProvider } from '@/lib/intel/types';

export const stubProvider: IntelProvider = {
  kind: 'stub',
  version: '1',

  async gather(ref, ctx) {
    ctx.emit({ event: 'status', data: { stage: 'gathering', note: 'stub provider' } });
    return {
      signals: [
        { key: 'ref', label: 'Reference', value: ref.id, source: 'input' },
        { key: 'kind', label: 'Kind', value: ref.kind, source: 'input' },
        ...(ref.lat != null && ref.lng != null
          ? [{ key: 'coords', label: 'Coordinates', value: `${ref.lat}, ${ref.lng}`, source: 'input' as const }]
          : []),
      ],
      citations: [],
      graph: {
        nodes: [{ id: `stub:${ref.id}`, label: ref.label || ref.id, type: 'event', properties: { kind: ref.kind } }],
        links: [],
      },
    };
  },

  async synthesize(ref, gathered, ctx) {
    const factsBlock = gathered.signals.map((s) => `- ${s.label}: ${JSON.stringify(s.value)}`).join('\n');
    const result = await ctx.llm.chat(
      [
        { role: 'system', content: 'You are OSIRIS, an OSINT analyst. Write one concise paragraph using ONLY the facts provided. Do not invent details.' },
        { role: 'user', content: `Summarize this reference for an analyst.\n\nFACTS:\n${factsBlock}` },
      ],
      { signal: ctx.signal },
    );
    return {
      summary: result.text,
      sections: [{ id: 'overview', title: 'Overview', body: result.text }],
      facts: gathered.signals.map((s) => ({
        label: s.label,
        value: typeof s.value === 'string' ? s.value : JSON.stringify(s.value),
        source: s.source,
      })),
    };
  },
};
