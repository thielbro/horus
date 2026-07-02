'use client';

// HORUS — dedicated Surveillance menu.
//
// Splits surveillance out of the cramped 80px layer rail into its own panel: cameras toggled
// per continent (each loads its own feed, so no continent starves another), counter-surveillance
// layers (OSM cameras, Flock/ALPR, police, mass-surveillance), and a source manager with an
// editable URL + Test button so users can see how to add new sources or spot dead ones.
// The custom-source plumbing (validate → upsert → persist → live registry) is reused verbatim
// from the extension subsystem.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Camera, Eye, Shield, ScanLine, Boxes, Plus, Trash2, Pencil, AlertTriangle, MapPin, Navigation, FlaskConical, Loader2, CheckCircle2 } from 'lucide-react';
import { getGroups } from '@/lib/registry';
import RoutePlanner from '@/components/RoutePlanner';
import {
  useCustomSources, upsertCustomSource, removeCustomSource,
  validateCustomSourceSpec, formatValidationErrors,
  type CustomSourceSpec,
} from '@/lib/plugins';

interface WazeScanResult { ok: boolean; police: number; camera: number; timestamp?: string; error?: string; errors?: unknown[] }

interface SurveillancePanelProps {
  open: boolean;
  onClose: () => void;
  data: any;
  activeLayers: Record<string, boolean>;
  setActiveLayers: React.Dispatch<React.SetStateAction<any>>;
  /** Scans the current map viewport for live Waze police/camera alerts (one headed-browser fetch). */
  onScanWaze?: () => Promise<WazeScanResult>;
  onLocate?: (lat: number, lng: number) => void;
}

// CCTV continents with sources today: [toggle key, label, data bucket].
const CONTINENTS: Array<{ key: string; label: string; bucket: string }> = [
  { key: 'cctv_europe', label: 'Europe', bucket: 'cameras_europe' },
  { key: 'cctv_north_america', label: 'North America', bucket: 'cameras_north_america' },
  { key: 'cctv_united_states', label: 'United States', bucket: 'cameras_united_states' },
  { key: 'cctv_asia', label: 'Asia', bucket: 'cameras_asia' },
  { key: 'cctv_oceania', label: 'Oceania', bucket: 'cameras_oceania' },
];
const EMPTY_CONTINENTS = ['Africa', 'South America', 'Antarctica'];

const COUNTER_LAYERS: Array<{ key: string; label: string; bucket: string; color: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'surveillance', label: 'OSM Surveillance Cameras', bucket: 'surveillance', color: '#FFAB00', icon: Eye },
  { key: 'flock', label: 'Flock / ALPR Cameras', bucket: 'flock', color: '#FF7043', icon: ScanLine },
  { key: 'police', label: 'Police Stations', bucket: 'police', color: '#42A5F5', icon: Shield },
  { key: 'mass_surveil', label: 'Mass Surveillance Tech', bucket: 'mass_surveil', color: '#EF5350', icon: Camera },
];

const BUILTIN_SOURCES: Array<{ label: string; url: string }> = [
  { label: 'CCTV — Europe', url: '/api/cctv?continent=europe' },
  { label: 'CCTV — North America', url: '/api/cctv?continent=north-america' },
  { label: 'CCTV — United States', url: '/api/cctv?continent=united-states' },
  { label: 'CCTV — Asia', url: '/api/cctv?continent=asia' },
  { label: 'CCTV — Oceania', url: '/api/cctv?continent=oceania' },
  { label: 'OSM Surveillance', url: '/api/surveillance' },
  { label: 'Police Stations', url: '/api/police' },
  { label: 'Flock / ALPR', url: '/api/flock' },
  { label: 'Mass Surveillance', url: '/api/mass-surveillance' },
];

const inputCls = 'w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none';
const labelCls = 'text-[9px] font-mono tracking-widest text-white/40 mb-1 block uppercase';
const btnCls = 'flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-[10px] font-mono tracking-wider text-white/70 hover:border-[var(--gold-primary)]/40 hover:text-white transition-colors';
const SOURCE_TEST_TIMEOUT_MS = 12_000;
const MAX_TEST_RESULTS = 50;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source';

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3 text-[11px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-2">
      <Icon className="w-3.5 h-3.5" />
      {children}
    </div>
  );
}

function ToggleRow({ label, color, count, active, onToggle, disabled, Icon }: {
  label: string; color: string; count?: number | null; active: boolean; onToggle: () => void; disabled?: boolean;
  Icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded border transition-colors ${
        active ? 'bg-white/10 border-white/20' : 'bg-transparent border-white/5 hover:border-white/10'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span
        className="w-2.5 h-2.5 rounded-full border flex-shrink-0 transition-all"
        style={{ background: active ? color : 'transparent', borderColor: active ? color : 'rgba(255,255,255,0.3)', boxShadow: active ? `0 0 8px ${color}` : 'none' }}
      />
      {Icon && <Icon className="w-3.5 h-3.5 text-white/40" />}
      <span className={`text-[11px] font-mono uppercase tracking-wider flex-1 text-left ${active ? 'text-white' : 'text-white/60'}`}>{label}</span>
      {count != null && <span className="text-[9px] font-mono tabular-nums opacity-60">{count.toLocaleString()}</span>}
    </button>
  );
}

type TestState = { loading?: boolean; ok?: boolean; status?: number; count?: number | null; arrayPath?: string | null; sampleKeys?: string[] | null; error?: string; message?: string };

function TestResultLine({ r }: { r: TestState }) {
  if (r.loading) return <div className="mt-1 text-[9px] font-mono text-white/40 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> testing…</div>;
  if (r.error) return <div className="mt-1 text-[9px] font-mono text-[var(--alert-red)] break-words flex items-start gap-1.5"><AlertTriangle className="w-3 h-3 mt-px shrink-0" />{r.error}</div>;
  const good = r.ok && (r.count ?? 0) > 0;
  return (
    <div className="mt-1 text-[9px] font-mono break-words" style={{ color: good ? 'var(--alert-green)' : '#E0A030' }}>
      <span className="inline-flex items-center gap-1">
        {good ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
        HTTP {r.status} · {r.count != null ? `${r.count} records` : 'no array found'}{r.arrayPath ? ` @ ${r.arrayPath}` : ''}
      </span>
      {r.sampleKeys && r.sampleKeys.length > 0 && (
        <div className="text-white/40 mt-0.5">fields: {r.sampleKeys.join(', ')}</div>
      )}
      {r.message && <div className="text-white/40 mt-0.5">{r.message}</div>}
    </div>
  );
}

type Draft = Omit<CustomSourceSpec, 'id'> & { id?: string };
const EMPTY_DRAFT: Draft = {
  label: '', group: 'SURVEIL', color: '#00E676', url: '', jsonPath: '', latProp: 'lat', lngProp: 'lng',
  labelProp: 'name', markerType: 'circle', radius: 5, intervalMs: undefined,
};

function SurveillancePanel({ open, onClose, data, activeLayers, setActiveLayers, onScanWaze, onLocate }: SurveillancePanelProps) {
  const customSources = useCustomSources();
  const formRef = useRef<HTMLDivElement>(null);
  const testAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [addrQuery, setAddrQuery] = useState('');
  const [wazeScan, setWazeScan] = useState<{ loading: boolean; result?: WazeScanResult }>({ loading: false });

  const runWazeScan = async () => {
    if (!onScanWaze || wazeScan.loading) return;
    setWazeScan({ loading: true });
    try {
      const result = await onScanWaze();
      setWazeScan({ loading: false, result });
    } catch (e) {
      setWazeScan({ loading: false, result: { ok: false, police: 0, camera: 0, error: e instanceof Error ? e.message : 'Scan failed' } });
    }
  };

  const runAddressIntel = () => {
    const q = addrQuery.trim();
    if (!q) return;
    (window as unknown as { openHorusDossier?: (r: { kind: string; id: string; label: string }) => void }).openHorusDossier?.({ kind: 'address', id: q, label: q });
  };

  const toggle = (key: string) => setActiveLayers((prev: any) => ({ ...prev, [key]: !prev[key] }));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const count = (bucket: string): number | null => (Array.isArray(data[bucket]) ? data[bucket].length : null);

  const abortAllTests = useCallback(() => {
    testAbortControllersRef.current.forEach((controller) => controller.abort());
    testAbortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    if (open) return;
    abortAllTests();
    setTests({});
  }, [open, abortAllTests]);

  useEffect(() => () => abortAllTests(), [abortAllTests]);

  const setTestResult = (url: string, result: TestState) => {
    setTests((prev) => {
      const entries = Object.entries(prev).filter(([key]) => key !== url);
      entries.push([url, result]);
      return Object.fromEntries(entries.slice(-MAX_TEST_RESULTS));
    });
  };

  const runTest = async (url: string, jsonPath?: string) => {
    const testUrl = url.trim();
    if (!testUrl) return;
    testAbortControllersRef.current.get(testUrl)?.abort();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Source test timed out')), SOURCE_TEST_TIMEOUT_MS);
    testAbortControllersRef.current.set(testUrl, controller);
    setTestResult(testUrl, { loading: true });
    try {
      const qs = new URLSearchParams({ url: testUrl });
      if (jsonPath) qs.set('jsonPath', jsonPath);
      const res = await fetch(`/api/source-test?${qs.toString()}`, { signal: controller.signal });
      const json = await res.json();
      if (!controller.signal.aborted) setTestResult(testUrl, { loading: false, ...json });
    } catch (e) {
      if (controller.signal.aborted) return;
      setTestResult(testUrl, { loading: false, ok: false, error: e instanceof Error ? e.message : 'Request failed' });
    } finally {
      clearTimeout(timeout);
      if (testAbortControllersRef.current.get(testUrl) === controller) testAbortControllersRef.current.delete(testUrl);
    }
  };

  const jumpToForm = () => {
    setDraft((d) => ({ ...d, group: 'SURVEIL' }));
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const edit = (s: CustomSourceSpec) => { setDraft({ ...s }); setFormError(null); jumpToForm(); };

  const save = () => {
    setFormError(null);
    try {
      if (!draft.label.trim()) throw new Error('Name is required.');
      if (!draft.url.trim()) throw new Error('Feed URL is required.');
      const spec: CustomSourceSpec = { ...draft, id: draft.id ?? `custom_${slug(draft.label)}` } as CustomSourceSpec;
      if (!spec.intervalMs) delete (spec as any).intervalMs;
      if (!spec.labelProp) delete (spec as any).labelProp;
      if (!spec.jsonPath) delete (spec as any).jsonPath;
      const groups = getGroups();
      const validation = validateCustomSourceSpec(spec, {
        groupIds: groups.map((g) => g.id),
        existingIds: customSources.map((s) => s.id),
        currentId: spec.id,
      });
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      const result = upsertCustomSource(validation.value);
      if (!result.ok) throw new Error(result.error ?? 'Custom source could not be registered.');
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveSource = (id: string) => {
    setFormError(null);
    try {
      removeCustomSource(id);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const anyCctv = CONTINENTS.some((c) => activeLayers[c.key]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            className="glass-panel w-full max-w-[560px] max-h-[85vh] overflow-y-auto styled-scrollbar rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-primary)] sticky top-0 bg-[var(--bg-panel)] backdrop-blur-md z-10">
              <span className="text-sm font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)] flex items-center gap-2"><Eye className="w-4 h-4" /> SURVEILLANCE</span>
              <button onClick={onClose} className="text-[var(--text-muted)] hover:text-white transition-colors p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-7">
              {/* ── CCTV by continent ── */}
              <section>
                <SectionTitle icon={Camera}>CCTV CAMERAS — BY CONTINENT</SectionTitle>
                <div className="space-y-1.5">
                  {CONTINENTS.map((c) => {
                    const active = !!activeLayers[c.key];
                    const n = count(c.bucket);
                    return (
                      <ToggleRow
                        key={c.key}
                        label={c.label}
                        color="#00E676"
                        active={active}
                        count={active ? (n ?? 0) : n}
                        onToggle={() => toggle(c.key)}
                      />
                    );
                  })}
                  {EMPTY_CONTINENTS.map((label) => (
                    <div key={label} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded border border-dashed border-white/5 opacity-60">
                      <span className="w-2.5 h-2.5 rounded-full border border-white/20 flex-shrink-0" />
                      <span className="text-[11px] font-mono uppercase tracking-wider flex-1 text-left text-white/40">{label}</span>
                      <button onClick={jumpToForm} className="text-[9px] font-mono tracking-wider text-[var(--cyan-primary)] hover:text-white flex items-center gap-1"><Plus className="w-3 h-3" /> ADD A SOURCE</button>
                    </div>
                  ))}
                </div>
              </section>

              {/* ── Counter-surveillance ── */}
              <section>
                <SectionTitle icon={Shield}>COUNTER-SURVEILLANCE</SectionTitle>
                <div className="space-y-1.5">
                  {COUNTER_LAYERS.map((l) => {
                    const active = !!activeLayers[l.key];
                    const n = count(l.bucket);
                    return (
                      <ToggleRow
                        key={l.key}
                        label={l.label}
                        color={l.color}
                        Icon={l.icon}
                        active={active}
                        count={active ? (n ?? 0) : n}
                        onToggle={() => toggle(l.key)}
                      />
                    );
                  })}
                </div>
                <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
                  Positions only (OpenStreetMap, ODbL) — no live video. Coverage is community-sourced and continent-scale by default.
                </p>
              </section>

              {/* ── Waze live alerts (on-demand viewport scan) ── */}
              {onScanWaze && (() => {
                const r = wazeScan.result;
                const total = r ? r.police + r.camera : 0;
                const hasData = (count('waze_alerts') ?? 0) > 0;
                return (
                  <section>
                    <SectionTitle icon={AlertTriangle}>WAZE LIVE ALERTS</SectionTitle>
                    <div className="bg-black/30 border border-white/5 rounded px-3 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={runWazeScan}
                          disabled={wazeScan.loading}
                          className={`${btnCls} flex-1 justify-center ${wazeScan.loading ? 'opacity-60 cursor-wait' : ''}`}
                        >
                          {wazeScan.loading
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> SCANNING…</>
                            : <><ScanLine className="w-3.5 h-3.5" /> SCAN THIS AREA</>}
                        </button>
                        {hasData && (
                          <button
                            onClick={() => toggle('waze_alerts')}
                            title={activeLayers.waze_alerts ? 'Hide on map' : 'Show on map'}
                            className={`p-1.5 rounded border transition-colors ${activeLayers.waze_alerts ? 'border-[#FF1744]/50 text-[#FF1744]' : 'border-white/10 text-white/40 hover:text-white/80'}`}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      {r && !wazeScan.loading && (
                        r.error ? (
                          <div className="mt-2 text-[9px] font-mono text-[var(--alert-red)] break-words flex items-start gap-1.5"><AlertTriangle className="w-3 h-3 mt-px shrink-0" />{r.error}</div>
                        ) : (
                          <div className="mt-2 text-[9px] font-mono break-words" style={{ color: total > 0 ? 'var(--alert-green)' : '#E0A030' }}>
                            <span className="inline-flex items-center gap-1">
                              {total > 0 ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                              {total > 0 ? `${r.police} police · ${r.camera} cameras` : 'No Waze alerts in this view'}
                              {r.timestamp ? ` · ${new Date(r.timestamp).toLocaleTimeString()}` : ''}
                            </span>
                            {(r.errors?.length ?? 0) > 0 && <div className="text-white/40 mt-0.5">{r.errors!.length} tile(s) failed — results may be partial.</div>}
                          </div>
                        )
                      )}
                    </div>
                    <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
                      Crowd-sourced police &amp; speed-camera sightings reported by Waze drivers for the current map view —
                      live and ephemeral, so re-scan to refresh. Zoom in if the area is too large. A browser window may briefly
                      open while fetching.
                    </p>
                  </section>
                );
              })()}

              {/* ── Custom sources (toggle / edit / remove) ── */}
              {customSources.length > 0 && (
                <section>
                  <SectionTitle icon={Boxes}>YOUR SOURCES</SectionTitle>
                  <div className="space-y-1.5">
                    {customSources.map((s) => {
                      const active = !!activeLayers[s.id];
                      return (
                        <div key={s.id} className="bg-black/30 border border-white/5 rounded px-2.5 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <button onClick={() => toggle(s.id)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0 border" style={{ background: active ? s.color : 'transparent', borderColor: s.color, boxShadow: active ? `0 0 8px ${s.color}` : 'none' }} />
                              <span className="text-[11px] font-mono text-white/85 truncate">{s.label}</span>
                              <span className="text-[9px] font-mono text-white/30 truncate">{s.url}</span>
                              {s.error && <span className="text-[9px] font-mono text-[var(--alert-red)]">ERROR</span>}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => runTest(s.url, s.jsonPath)} className="p-1 text-white/40 hover:text-[var(--gold-primary)]" title="Test"><FlaskConical className="w-3.5 h-3.5" /></button>
                              <button onClick={() => edit(s)} className="p-1 text-white/40 hover:text-[var(--cyan-primary)]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                              <button onClick={() => handleRemoveSource(s.id)} className="p-1 text-white/40 hover:text-[var(--alert-red)]" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                          {tests[s.url] && <TestResultLine r={tests[s.url]} />}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ── Add / test source ── */}
              <section ref={formRef}>
                <SectionTitle icon={FlaskConical}>{draft.id ? 'EDIT SOURCE' : 'ADD / TEST A SOURCE'}</SectionTitle>
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2"><label className={labelCls}>Name</label><input className={inputCls} value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="My camera feed" /></div>
                  <div className="col-span-2">
                    <label className={labelCls}>Feed URL <span className="text-white/25 normal-case">(the editable source field)</span></label>
                    <div className="flex gap-1.5">
                      <input className={inputCls} value={draft.url} onChange={(e) => set('url', e.target.value)} placeholder="/api/... or https://..." />
                      <button onClick={() => runTest(draft.url, draft.jsonPath)} className={`${btnCls} shrink-0`}><FlaskConical className="w-3.5 h-3.5" /> TEST</button>
                    </div>
                    {draft.url && tests[draft.url] && <TestResultLine r={tests[draft.url]} />}
                  </div>
                  <div><label className={labelCls}>Color</label>
                    <div className="flex gap-1.5 items-center">
                      <input className={inputCls} value={draft.color} onChange={(e) => set('color', e.target.value)} />
                      <input type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10 shrink-0" />
                    </div>
                  </div>
                  <div><label className={labelCls}>JSON path → array</label><input className={inputCls} value={draft.jsonPath ?? ''} onChange={(e) => set('jsonPath', e.target.value)} placeholder="cameras (blank = auto)" /></div>
                  <div><label className={labelCls}>Lat property</label><input className={inputCls} value={draft.latProp} onChange={(e) => set('latProp', e.target.value)} /></div>
                  <div><label className={labelCls}>Lng property</label><input className={inputCls} value={draft.lngProp} onChange={(e) => set('lngProp', e.target.value)} /></div>
                  <div><label className={labelCls}>Label property</label><input className={inputCls} value={draft.labelProp ?? ''} onChange={(e) => set('labelProp', e.target.value)} placeholder="name (optional)" /></div>
                  <div><label className={labelCls}>Poll (ms)</label><input className={inputCls} type="number" value={draft.intervalMs ?? ''} onChange={(e) => set('intervalMs', e.target.value ? Number(e.target.value) : undefined)} placeholder="once" /></div>
                </div>

                {formError && <div className="mt-2 text-[10px] font-mono text-[var(--alert-red)] flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{formError}</div>}

                <div className="flex items-center gap-2 mt-3">
                  <button onClick={save} className={btnCls}><Plus className="w-3.5 h-3.5" /> {draft.id ? 'UPDATE SOURCE' : 'ADD SOURCE'}</button>
                  {draft.id && <button onClick={() => { setDraft(EMPTY_DRAFT); setFormError(null); }} className="text-[9px] font-mono text-white/40 hover:text-white/80">CANCEL EDIT</button>}
                </div>
                <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
                  Test a URL to see its HTTP status, record count, and field names — then map the right Lat/Lng/Label
                  properties. Saved sources persist locally and become toggleable layers (also under SURVEIL in the rail).
                </p>
              </section>

              {/* ── Builtin sources — test for dead feeds ── */}
              <section>
                <SectionTitle icon={MapPin}>BUILT-IN SOURCES</SectionTitle>
                <div className="space-y-1">
                  {BUILTIN_SOURCES.map((s) => (
                    <div key={s.url} className="bg-black/20 border border-white/5 rounded px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[11px] font-mono text-white/80 truncate">{s.label}</div>
                          <div className="text-[9px] font-mono text-white/30 truncate">{s.url}</div>
                        </div>
                        <button onClick={() => runTest(s.url)} className={`${btnCls} shrink-0`}><FlaskConical className="w-3.5 h-3.5" /> TEST</button>
                      </div>
                      {tests[s.url] && <TestResultLine r={tests[s.url]} />}
                    </div>
                  ))}
                </div>
              </section>

              {/* ── Address intel (compiled on demand: search + local LLM) ── */}
              <section>
                <SectionTitle icon={Navigation}>ADDRESS INTEL</SectionTitle>
                <div className="flex gap-1.5">
                  <input
                    className={inputCls}
                    value={addrQuery}
                    onChange={(e) => setAddrQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') runAddressIntel(); }}
                    placeholder="Address or place — e.g. Trafalgar Square, London"
                  />
                  <button onClick={runAddressIntel} className={`${btnCls} shrink-0`}><FlaskConical className="w-3.5 h-3.5" /> INTEL</button>
                </div>
                <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
                  Compiles a dossier on the fly — occupant/business, postcode, and the nearby cameras, ALPR, and
                  police that can observe the spot.
                </p>
              </section>

              {/* ── Route exposure (compiled on demand: routing + Overpass corridor + local LLM) ── */}
              <RoutePlanner />
            </div>

            {/* Footer status */}
            <div className="px-5 py-2.5 border-t border-[var(--border-primary)] text-[9px] font-mono text-white/30 flex items-center justify-between">
              <span>{anyCctv ? 'CAMERAS ACTIVE' : 'CAMERAS OFF'}</span>
              {onLocate && <span className="text-white/20">click a marker on the map for details</span>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default memo(SurveillancePanel);
