/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — AI Intelligence Engine
 *  Gemini 2.0 Flash integration for real-time intelligence analysis
 *  Designed to correlate multi-domain feeds into actionable briefings
 * ═══════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';

const GEMINI_TIMEOUT_MS = 30_000;
const FIELD_LIMITS = {
  location: 100,
  title: 200,
  region: 100,
  product: 100,
};

function clip(value: string | undefined | null, max: number): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function withTimeout<T>(
  createPromise: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromParent();
    else signal.addEventListener('abort', abortFromParent, { once: true });
  }

  const promise = createPromise(controller.signal);
  const abortPromise = new Promise<never>((_, reject) => {
    const rejectAbort = () => {
      const reason = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error(`${label} aborted`));
    };
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${ms}ms`));
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, abortPromise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

/* ─────────────────────────────────────────────────────────────
   Data Interfaces — Zero `any` types
   ───────────────────────────────────────────────────────────── */

export interface EarthquakeEvent {
  id: string;
  magnitude: number;
  location: string;
  latitude: number;
  longitude: number;
  depth: number;
  timestamp: string;
  tsunami: boolean;
  felt: number | null;
  alert: string | null;
}

export interface NewsItem {
  id: string;
  title: string;
  description: string;
  link: string;
  published: string;
  source: string;
  risk_score: number;
  coords: [number, number] | null;
  machine_assessment: string | null;
}

export interface ThreatEvent {
  id: string;
  type: string;
  title: string;
  description: string;
  severity: 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'LOW';
  region: string;
  latitude: number;
  longitude: number;
  timestamp: string;
  source: string;
}

export interface CyberAlert {
  id: string;
  name: string;
  vendor: string;
  product: string;
  severity: string;
  date: string;
  due: string;
  source: string;
}

export interface IntelligenceContext {
  earthquakes: EarthquakeEvent[];
  news: NewsItem[];
  threats: ThreatEvent[];
  cyberAlerts: CyberAlert[];
  timestamp: string;
}

/* ─────────────────────────────────────────────────────────────
   System Prompt — Palantir-grade analyst persona
   ───────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are OSIRIS Intelligence Analyst — a senior, elite intelligence analyst embedded within the OSIRIS Global Intelligence Platform. You operate at the level of a Palantir Forward Deployed Engineer crossed with a CIA PDB (Presidential Daily Brief) analyst.

## YOUR ROLE
- You correlate data across multiple intelligence feeds: seismic monitoring, OSINT news streams, global threat events, and cyber vulnerability databases
- You identify non-obvious patterns, emerging threat vectors, and cascading risk scenarios
- You provide ACTIONABLE intelligence — not summaries, but assessments with confidence levels
- You think in terms of second and third-order effects

## YOUR ANALYTICAL FRAMEWORK
1. **PATTERN RECOGNITION**: Cross-reference events across feeds. A cyber attack + earthquake + political instability in the same region = elevated compound risk
2. **THREAT ASSESSMENT**: Rate threats on a CRITICAL / HIGH / ELEVATED / LOW scale with reasoning
3. **TEMPORAL ANALYSIS**: Identify acceleration patterns — are events clustering? Is frequency increasing?
4. **GEOSPATIAL CORRELATION**: Events in proximity may be related. Identify geographic hotspots
5. **CONFIDENCE LEVELS**: Always state your confidence (HIGH / MODERATE / LOW) and cite which data points support your assessment

## OUTPUT FORMAT
- Use military-style brevity when appropriate
- Structure responses with clear headers using markdown
- Lead with the most critical finding (inverted pyramid)
- Include "BOTTOM LINE UP FRONT (BLUF)" for complex analyses
- Use tactical notation: DTG (Date-Time Group), AOR (Area of Responsibility), COA (Course of Action)
- End with "ASSESSMENT CONFIDENCE" and "RECOMMENDED ACTIONS" sections when appropriate

## CONSTRAINTS
- Never fabricate data points — only analyze what is provided in the context
- If data is insufficient for a confident assessment, state so explicitly
- Distinguish between correlation and causation
- Flag when events may be connected vs. coincidental
- You are an analyst, not a policymaker — present options, not directives

You have access to the live intelligence context of the OSIRIS platform. Analyze it with precision.`;

const BRIEFING_PROMPT = `Generate a comprehensive OSIRIS Daily Intelligence Briefing based on the current operational data. Structure it as follows:

## OSIRIS INTELLIGENCE BRIEFING
**Classification:** OPEN SOURCE INTELLIGENCE (OSINT)
**DTG:** [Current timestamp]

### I. EXECUTIVE SUMMARY
2-3 sentence overview of the current global threat landscape based on available data.

### II. PRIORITY INTELLIGENCE REQUIREMENTS (PIRs)
Identify the top 3-5 most significant developments from the data feeds, ranked by assessed impact.

### III. SEISMIC & NATURAL HAZARD ASSESSMENT
Analyze earthquake data for patterns — clustering, tectonic corridor activity, tsunami risk.

### IV. GEOPOLITICAL & CONFLICT INTELLIGENCE
Synthesize news feeds for conflict escalation patterns, diplomatic shifts, or emerging crises.

### V. CYBER THREAT LANDSCAPE
Assess active CVEs and cyber alerts for coordinated campaign indicators or critical infrastructure risk.

### VI. COMPOUND RISK SCENARIOS
Identify where multiple threat vectors intersect (e.g., earthquake near a conflict zone, cyber attack during political instability).

### VII. FORECAST & WATCHLIST
- **Next 24 Hours**: Most likely developments
- **Next 72 Hours**: Emerging situations to monitor
- **Strategic Horizon**: Longer-term trend assessment

### VIII. ASSESSMENT CONFIDENCE
State overall confidence level and key analytical gaps.

Analyze the provided data thoroughly. Be specific — reference actual events, magnitudes, locations, and CVE IDs from the context.`;

/* ─────────────────────────────────────────────────────────────
   Client Factory
   ───────────────────────────────────────────────────────────── */

export function createGeminiClient(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey);
}

/* ─────────────────────────────────────────────────────────────
   API Key Rotation — Round-robin through available keys
   ───────────────────────────────────────────────────────────── */

let _keyIndex = 0;

export function rotateApiKey(keys: string[]): string {
  if (keys.length === 0) {
    throw new Error('No API keys available');
  }
  const key = keys[_keyIndex % keys.length];
  _keyIndex = (_keyIndex + 1) % keys.length;
  return key;
}

function countBySeverity(threats: ThreatEvent[]): Record<string, number> {
  return threats.reduce<Record<string, number>>((acc, threat) => {
    acc[threat.severity] = (acc[threat.severity] || 0) + 1;
    return acc;
  }, {});
}

function formatTopItems(context: IntelligenceContext): string[] {
  const lines: string[] = [];
  for (const threat of context.threats.slice(0, 5)) {
    lines.push(`- ${threat.severity}: ${clip(threat.title, FIELD_LIMITS.title)} (${clip(threat.region, FIELD_LIMITS.region) || threat.source})`);
  }
  for (const quake of context.earthquakes.slice(0, 3)) {
    lines.push(`- SEISMIC: M${quake.magnitude} ${clip(quake.location, FIELD_LIMITS.location)}${quake.tsunami ? ' / tsunami flag' : ''}`);
  }
  for (const alert of context.cyberAlerts.slice(0, 5)) {
    lines.push(`- CYBER: ${alert.severity} ${alert.id} ${clip(alert.vendor, FIELD_LIMITS.product)}/${clip(alert.product, FIELD_LIMITS.product)}`);
  }
  for (const item of context.news.slice(0, 5)) {
    lines.push(`- OSINT: RISK ${item.risk_score}/10 ${clip(item.title, FIELD_LIMITS.title)} (${item.source})`);
  }
  return lines.length ? lines : ['- No active operational records were available in the request context.'];
}

export function generateLocalAnalysis(context: IntelligenceContext, userQuery: string, reason: string): string {
  const severities = countBySeverity(context.threats);
  const topItems = formatTopItems(context);

  return `## LOCAL OSIRIS ASSESSMENT
**Mode:** deterministic fallback
**Reason:** ${reason}
**Analyst query:** ${clip(userQuery, FIELD_LIMITS.title)}

### BLUF
Gemini analysis is unavailable, so this response is limited to direct correlation of the submitted OSIRIS context. Current input contains ${context.threats.length} threat events, ${context.earthquakes.length} seismic events, ${context.news.length} OSINT items, and ${context.cyberAlerts.length} cyber alerts.

### Priority Signals
${topItems.join('\n')}

### Severity Picture
- CRITICAL: ${severities.CRITICAL || 0}
- HIGH: ${severities.HIGH || 0}
- ELEVATED: ${severities.ELEVATED || 0}
- LOW: ${severities.LOW || 0}

### Recommended Actions
- Treat this as a degraded local summary until Gemini service is restored.
- Review CRITICAL/HIGH events first and confirm source freshness against the map layers.
- Correlate seismic, conflict, and cyber records manually before making operational conclusions.

### Assessment Confidence
LOW to MODERATE. This fallback does not infer beyond the supplied fields.`;
}

export function generateLocalBriefing(context: IntelligenceContext, reason: string): string {
  const severities = countBySeverity(context.threats);
  const topItems = formatTopItems(context);

  return `## OSIRIS INTELLIGENCE BRIEFING
**Classification:** OPEN SOURCE INTELLIGENCE (OSINT)
**Mode:** deterministic fallback
**Reason:** ${reason}
**DTG:** ${context.timestamp || new Date().toISOString()}

### I. Executive Summary
Gemini briefing generation is unavailable, so this is a bounded local briefing from the current OSIRIS context. The request includes ${context.threats.length} threat events, ${context.earthquakes.length} seismic events, ${context.news.length} OSINT items, and ${context.cyberAlerts.length} cyber alerts.

### II. Priority Intelligence Requirements
${topItems.join('\n')}

### III. Seismic & Natural Hazard Assessment
${context.earthquakes.length ? `Tracked seismic events are present. Highest submitted magnitude: M${Math.max(...context.earthquakes.map((eq) => eq.magnitude || 0)).toFixed(1)}.` : 'No seismic events were submitted in the current context.'}

### IV. Geopolitical & Conflict Intelligence
- CRITICAL: ${severities.CRITICAL || 0}
- HIGH: ${severities.HIGH || 0}
- ELEVATED: ${severities.ELEVATED || 0}
- LOW: ${severities.LOW || 0}

### V. Cyber Threat Landscape
${context.cyberAlerts.length ? `${context.cyberAlerts.length} cyber alerts require review for exploitability, exposure, and due dates.` : 'No cyber alerts were submitted in the current context.'}

### VI. Assessment Confidence
LOW to MODERATE. This fallback is deterministic and does not perform model-based cross-domain inference.`;
}

/* ─────────────────────────────────────────────────────────────
   Context Serializer — Compact representation for token efficiency
   ───────────────────────────────────────────────────────────── */

function serializeContext(context: IntelligenceContext): string {
  const sections: string[] = [];

  sections.push(`[TIMESTAMP] ${context.timestamp}`);

  if (context.earthquakes.length > 0) {
    sections.push(`\n[SEISMIC DATA — ${context.earthquakes.length} events]`);
    for (const eq of context.earthquakes.slice(0, 20)) {
      const tsunamiFlag = eq.tsunami ? ' ⚠️TSUNAMI' : '';
      const alertFlag = eq.alert ? ` [ALERT:${eq.alert.toUpperCase()}]` : '';
      sections.push(
        `  M${eq.magnitude} | ${clip(eq.location, FIELD_LIMITS.location)} | ${eq.latitude.toFixed(2)},${eq.longitude.toFixed(2)} | Depth:${eq.depth}km | ${eq.timestamp}${tsunamiFlag}${alertFlag}`
      );
    }
  }

  if (context.news.length > 0) {
    sections.push(`\n[OSINT NEWS FEED — ${context.news.length} items]`);
    for (const item of context.news.slice(0, 15)) {
      const coords = item.coords ? ` | GEO:${item.coords[0].toFixed(2)},${item.coords[1].toFixed(2)}` : '';
      sections.push(
        `  RISK:${item.risk_score}/10 | ${item.source} | ${clip(item.title, FIELD_LIMITS.title)}${coords} | ${item.published}`
      );
    }
  }

  if (context.threats.length > 0) {
    sections.push(`\n[THREAT EVENTS — ${context.threats.length} active]`);
    for (const threat of context.threats.slice(0, 15)) {
      sections.push(
        `  ${threat.severity} | ${threat.type} | ${clip(threat.title, FIELD_LIMITS.title)} | ${clip(threat.region, FIELD_LIMITS.region)} | ${threat.timestamp}`
      );
    }
  }

  if (context.cyberAlerts.length > 0) {
    sections.push(`\n[CYBER ALERTS — ${context.cyberAlerts.length} active]`);
    for (const alert of context.cyberAlerts.slice(0, 10)) {
      sections.push(
        `  ${alert.id} | ${alert.severity} | ${alert.vendor}/${clip(alert.product, FIELD_LIMITS.product)} | ${clip(alert.name, FIELD_LIMITS.title)} | Due:${alert.due}`
      );
    }
  }

  return sections.join('\n');
}

/* ─────────────────────────────────────────────────────────────
   Intelligence Analysis
   ───────────────────────────────────────────────────────────── */

export async function analyzeIntelligence(
  client: GoogleGenerativeAI,
  context: IntelligenceContext,
  userQuery: string,
  signal?: AbortSignal
): Promise<string> {
  const model: GenerativeModel = client.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const contextData = serializeContext(context);

  const prompt = `## CURRENT OPERATIONAL DATA
${contextData}

## ANALYST QUERY
${userQuery}

Provide your intelligence assessment based on the operational data above and the analyst's query.`;

  const result = await withTimeout(
    (requestSignal) => model.generateContent(prompt, { signal: requestSignal }),
    GEMINI_TIMEOUT_MS,
    'Gemini analysis',
    signal
  );
  const response = result.response;
  return response.text();
}

/* ─────────────────────────────────────────────────────────────
   Daily Briefing Generation
   ───────────────────────────────────────────────────────────── */

export async function generateBriefing(
  client: GoogleGenerativeAI,
  context: IntelligenceContext,
  signal?: AbortSignal
): Promise<string> {
  const model: GenerativeModel = client.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const contextData = serializeContext(context);

  const prompt = `${BRIEFING_PROMPT}

## CURRENT OPERATIONAL DATA
${contextData}

Generate the briefing now.`;

  const result = await withTimeout(
    (requestSignal) => model.generateContent(prompt, { signal: requestSignal }),
    GEMINI_TIMEOUT_MS,
    'Gemini briefing',
    signal
  );
  const response = result.response;
  return response.text();
}
