'use client';

// HORUS — Dossier panel. Streams a compiled intel dossier (SSE from /api/intel/compile) and
// renders it: BLUF summary, sections, facts, nearby surveillance, street-level photos,
// citations, privacy notice, provenance. The map overlay (pin/radius/sightlines) is driven by
// the parent via onLoaded(dossier). Address is the first kind; the panel is kind-agnostic.

import { memo, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Loader2, AlertTriangle, MapPin, Camera, ScanLine, Shield, Gauge, Crosshair, ShieldCheck, ExternalLink, Network,
} from 'lucide-react';

export interface DossierTarget {
  kind: string;
  id: string;
  label?: string;
  lat?: number;
  lng?: number;
}

interface DossierSection {
  id: string;
  title: string;
  body: string;
}

interface DossierPointFeature {
  geometry?: {
    type?: string;
    coordinates?: [number, number] | number[];
  };
  properties?: {
    role?: string;
    kind?: string;
    name?: string;
    distanceM?: number;
    osmUrl?: string;
    [key: string]: unknown;
  };
}

interface Dossier {
  kind: string;
  ref: { kind: string; id: string; label?: string; lat?: number; lng?: number };
  summary: string;
  sections: DossierSection[];
  facts: Array<{ label: string; value: string; confidence?: string; source?: string }>;
  graph?: { nodes: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };
  citations: Array<{ id: string; title: string; url: string; source: string }>;
  media?: Array<{ url: string; thumbUrl?: string; capturedAt?: string; sourceUrl?: string; source: string }>;
  geometry?: { features?: DossierPointFeature[] };
  privacy?: { tier: string; notice: string };
  provenance?: { model: string; durationMs: number; signalSources: string[]; cacheHit: boolean };
}

interface Props {
  open: boolean;
  target: DossierTarget | null;
  requestId?: number;
  onClose: () => void;
  onLoaded?: (d: Dossier, requestId?: number) => void;
  onLocate?: (lat: number, lng: number) => void;
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  camera: Camera, alpr: ScanLine, speed: Gauge, police: Shield,
};
const KIND_COLOR: Record<string, string> = {
  camera: '#00E676', alpr: '#FF7043', speed: '#FFD54F', police: '#42A5F5',
};
const MAX_BUF_LEN = 2 * 1024 * 1024;
const MAX_NEARBY = 30;

// Minimal, safe markdown-lite → React (bold, links, bullets, line breaks). No raw HTML.
function renderMarkdown(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const content = bullet ? bullet[1] : line;
    const parts: React.ReactNode[] = [];
    const re = /\*\*(.+?)\*\*|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0; let m: RegExpExecArray | null; let k = 0;
    while ((m = re.exec(content)) !== null) {
      if (m.index > last) parts.push(content.slice(last, m.index));
      if (m[1] != null) parts.push(<strong key={k++} className="text-white">{m[1]}</strong>);
      else parts.push(<a key={k++} href={m[3]} target="_blank" rel="noopener noreferrer" className="text-[var(--cyan-primary)] hover:underline break-all">{m[2]}</a>);
      last = re.lastIndex;
    }
    if (last < content.length) parts.push(content.slice(last));
    if (!content.trim()) return <div key={i} className="h-1.5" />;
    return (
      <div key={i} className={bullet ? 'flex gap-1.5 pl-1' : ''}>
        {bullet && <span className="text-[var(--gold-primary)] mt-0.5">›</span>}
        <span>{parts}</span>
      </div>
    );
  });
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const nodes = useMemo(() => renderMarkdown(text), [text]);
  return <>{nodes}</>;
});

function pointCoordinates(feature: DossierPointFeature): [number, number] | null {
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? [lng, lat] : null;
}

function isNearbyFeature(feature: DossierPointFeature): boolean {
  const role = feature.properties?.role;
  return (role === 'nearby' || role === 'surveil') && pointCoordinates(feature) !== null;
}

function DossierPanel({ open, target, requestId, onClose, onLoaded, onLocate }: Props) {
  const [stage, setStage] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [streamSections, setStreamSections] = useState<DossierSection[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const latestOnLoadedRef = useRef(onLoaded);
  const requestIdRef = useRef(requestId);
  const sectionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => { latestOnLoadedRef.current = onLoaded; }, [onLoaded]);
  useEffect(() => { requestIdRef.current = requestId; }, [requestId]);

  const run = useCallback(async (t: DossierTarget) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    const runRequestId = requestIdRef.current;
    abortRef.current = controller;
    sectionIdsRef.current = new Set();
    setLoading(true); setError(null); setDossier(null); setStreamSections([]); setStage('starting');

    const qs = new URLSearchParams({ kind: t.kind, id: t.id });
    if (t.label) qs.set('label', t.label);
    if (t.lat != null && t.lng != null) { qs.set('lat', String(t.lat)); qs.set('lng', String(t.lng)); }

    try {
      const res = await fetch(`/api/intel/compile?${qs.toString()}`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          if (buf.length > MAX_BUF_LEN) throw new Error('Dossier stream exceeded buffer limit');
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const evMatch = /^event:\s*(.+)$/m.exec(raw);
            const dataMatch = /^data:\s*([\s\S]*)$/m.exec(raw);
            if (!evMatch || !dataMatch) continue;
            let payload: unknown; try { payload = JSON.parse(dataMatch[1]); } catch { continue; }
            if (controller.signal.aborted) return;
            switch (evMatch[1].trim()) {
              case 'status':
                setStage(String((payload as { stage?: unknown }).stage || ''));
                break;
              case 'section': {
                const section = payload as Partial<DossierSection>;
                if (typeof section.id !== 'string' || typeof section.title !== 'string' || typeof section.body !== 'string') break;
                if (sectionIdsRef.current.has(section.id)) break;
                sectionIdsRef.current.add(section.id);
                setStreamSections((prev) => [...prev, section as DossierSection]);
                break;
              }
              case 'done': {
                if (controller.signal.aborted) return;
                const nextDossier = (payload as { dossier?: Dossier }).dossier;
                if (!nextDossier) break;
                setDossier(nextDossier);
                setLoading(false);
                setStage('');
                latestOnLoadedRef.current?.(nextDossier, runRequestId);
                break;
              }
              case 'error':
                setError(String((payload as { message?: unknown }).message || 'compile failed'));
                setLoading(false);
                break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'compile failed');
      }
    } finally {
      if (abortRef.current === controller) { abortRef.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    if (open && target) run(target);
    return () => { abortRef.current?.abort(); };
  }, [open, target, requestId, run]);

  const sections = dossier?.sections ?? streamSections;
  const summary = dossier?.summary;
  const nearby = useMemo(() => (dossier?.geometry?.features ?? [])
    .filter(isNearbyFeature)
    .map((f) => {
      const [lng, lat] = pointCoordinates(f)!;
      const distanceM = Number(f.properties?.distanceM ?? 0);
      return {
        kind: String(f.properties?.kind || 'camera'),
        name: String(f.properties?.name || 'Surveillance'),
        distanceM: Number.isFinite(distanceM) ? distanceM : 0,
        lat,
        lng,
      };
    })
    .slice(0, MAX_NEARBY), [dossier?.geometry?.features]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: 500, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 500, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className="fixed top-0 right-0 h-full z-[520] flex flex-col glass-panel w-[460px] max-w-[92vw]"
          style={{ borderLeft: '1px solid var(--border-primary)', borderRadius: 0 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-primary)] bg-[var(--gold-primary)]/5">
            <div className="flex items-center gap-2.5 min-w-0">
              <Crosshair className="w-4 h-4 text-[var(--gold-primary)] shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)]">[ INTEL DOSSIER ]</div>
                <div className="text-[10px] font-mono text-white/60 truncate">{target?.label || target?.id}</div>
              </div>
              {loading && <Loader2 className="w-3.5 h-3.5 text-[var(--gold-primary)] animate-spin shrink-0" />}
            </div>
            <button onClick={onClose} className="p-1 hover:bg-[#FF1744]/20 rounded transition-colors shrink-0"><X className="w-4 h-4 text-[#FF1744]" /></button>
          </div>

          <div className="flex-1 overflow-y-auto styled-scrollbar px-5 py-4 space-y-5">
            {loading && (
              <div className="text-[10px] font-mono text-[var(--gold-primary)]/80 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--gold-primary)] animate-horus-pulse" />
                {stage ? `${stage.toUpperCase()}…` : 'COMPILING…'}
              </div>
            )}

            {error && (
              <div className="text-[10px] font-mono text-[var(--alert-red)] flex items-start gap-1.5 bg-[#FF1744]/10 border border-[#FF1744]/30 rounded px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /><span className="break-words">{error}</span>
              </div>
            )}

            {/* Summary */}
            {summary && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">SUMMARY</div>
                <div className="text-[11px] font-mono text-white/80 leading-relaxed space-y-0.5"><MarkdownBlock text={summary} /></div>
              </section>
            )}

            {/* Photos */}
            {dossier?.media && dossier.media.length > 0 && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">STREET-LEVEL IMAGERY</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {dossier.media.slice(0, 9).map((m, i) => (
                    <a key={i} href={m.sourceUrl || m.url} target="_blank" rel="noopener noreferrer" className="block aspect-square overflow-hidden rounded border border-white/10 hover:border-[var(--gold-primary)]/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={m.thumbUrl || m.url}
                        alt={`Street view from ${m.source} — ${i + 1}`}
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        className="w-full h-full object-cover"
                      />
                    </a>
                  ))}
                </div>
                <div className="text-[8px] font-mono text-white/30 mt-1">Nearest available street-level imagery · {dossier.media[0]?.source}</div>
              </section>
            )}

            {/* Photos — honest empty state (address/route only) */}
            {dossier && (dossier.kind === 'address' || dossier.kind === 'route') && (!dossier.media || dossier.media.length === 0) && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">STREET-LEVEL IMAGERY</div>
                <div className="text-[10px] font-mono text-white/40 py-1">No street-level imagery found near this location.</div>
              </section>
            )}

            {/* Sections */}
            {sections.filter((s) => s.body && s.body !== summary).map((s) => (
              <section key={s.id}>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">{s.title.toUpperCase()}</div>
                <div className="text-[11px] font-mono text-white/75 leading-relaxed space-y-0.5"><MarkdownBlock text={s.body} /></div>
              </section>
            ))}

            {/* Nearby surveillance */}
            {nearby.length > 0 && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">{dossier?.kind === 'route' ? 'SURVEILLANCE ON ROUTE' : 'NEARBY SURVEILLANCE'} ({nearby.length})</div>
                <div className="space-y-1">
                  {nearby.map((n, i) => {
                    const Icon = KIND_ICON[n.kind] || Camera;
                    const color = KIND_COLOR[n.kind] || '#00E676';
                    return (
                      <button key={i} onClick={() => { if (Number.isFinite(n.lat) && Number.isFinite(n.lng)) onLocate?.(n.lat, n.lng); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/5 hover:border-white/15 hover:bg-white/5 transition-colors text-left">
                        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                        <span className="text-[10px] font-mono text-white/80 flex-1 truncate">{n.name}</span>
                        <span className="text-[9px] font-mono tabular-nums" style={{ color }}>{n.distanceM}m</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Facts */}
            {dossier?.facts && dossier.facts.length > 0 && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">FACTS</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {dossier.facts.map((f, i) => (
                    <div key={i} className="min-w-0">
                      <div className="text-[8px] font-mono uppercase tracking-widest text-white/35">{f.label}</div>
                      <div className="text-[11px] font-mono text-white/85 truncate">{f.value}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Citations */}
            {dossier?.citations && dossier.citations.length > 0 && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">SOURCES</div>
                <div className="space-y-1">
                  {dossier.citations.map((c) => (
                    <a key={c.id} href={c.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[10px] font-mono text-white/60 hover:text-[var(--cyan-primary)]">
                      <ExternalLink className="w-3 h-3 shrink-0" /><span className="truncate">{c.title}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* Web leads — honest empty state (address/route only) */}
            {dossier && (dossier.kind === 'address' || dossier.kind === 'route') && (!dossier.citations || dossier.citations.filter((c) => c.source === 'web').length === 0) && (
              <section>
                <div className="text-[10px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-1.5 mb-2">WEB LEADS</div>
                <div className="text-[10px] font-mono text-white/40 py-1">No web leads found for this location.</div>
              </section>
            )}

            {/* Privacy */}
            {dossier?.privacy && (
              <div className="flex items-start gap-2 text-[9px] font-mono text-white/40 border border-white/10 rounded px-3 py-2 bg-black/20">
                <ShieldCheck className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--gold-primary)]/60" />
                <span>[{dossier.privacy.tier.toUpperCase()}] {dossier.privacy.notice}</span>
              </div>
            )}

            {!loading && !error && !dossier && (
              <div className="text-[10px] font-mono text-white/30 flex items-center gap-2"><Network className="w-3.5 h-3.5" /> No dossier.</div>
            )}
          </div>

          {/* Provenance footer */}
          {dossier?.provenance && (
            <div className="px-5 py-2 border-t border-[var(--border-primary)] text-[8px] font-mono text-white/30 flex items-center justify-between">
              <span className="flex items-center gap-1"><MapPin className="w-2.5 h-2.5" /> {dossier.provenance.signalSources.join(' · ')}</span>
              <span>{dossier.provenance.model} · {dossier.provenance.durationMs}ms{dossier.provenance.cacheHit ? ' · cached' : ''}</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default DossierPanel;
