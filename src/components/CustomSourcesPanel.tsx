'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Braces, Camera, CheckCircle2, FileJson, FlaskConical, Layers, Pencil, Plus, Search, Trash2, Video, X } from 'lucide-react';
import { getGroups, type CustomSourceSpec, type CustomSourceType } from '@/lib/registry';
import { formatValidationErrors, removeCustomSource, upsertCustomSource, useCustomSources, validateCustomSourceSpec } from '@/lib/plugins';

interface Props { open: boolean; onClose: () => void; activeLayers: Record<string, boolean>; setActiveLayers: React.Dispatch<React.SetStateAction<any>> }
type Draft = Partial<CustomSourceSpec> & Pick<CustomSourceSpec, 'version' | 'sourceType' | 'label' | 'group' | 'color' | 'url'>;
type TestResult = { loading?: boolean; ok?: boolean; status?: number; contentType?: string; detectedType?: string; count?: number | null; arrayPath?: string | null; sampleKeys?: string[] | null; message?: string; error?: string };

const TYPES: Array<{ id: CustomSourceType; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'live-camera', label: 'Live Camera / Video Stream', icon: Video },
  { id: 'snapshot-camera', label: 'Snapshot Camera', icon: Camera },
  { id: 'json-points', label: 'JSON Map Feed', icon: Braces },
  { id: 'geojson', label: 'GeoJSON Feed', icon: FileJson },
  { id: 'tile-layer', label: 'Tile Layer', icon: Layers },
];
const groups = getGroups();
const input = 'w-full border border-white/10 bg-black/35 px-3 py-2 text-[11px] font-mono text-white outline-none focus:border-[var(--cyan-primary)]/60';
const label = 'mb-1 block text-[8px] font-mono uppercase tracking-[.16em] text-white/40';
const button = 'inline-flex items-center justify-center gap-2 border border-white/15 px-4 py-2 text-[10px] font-mono tracking-widest text-white/75 transition hover:border-[var(--cyan-primary)]/60 hover:text-white disabled:opacity-40';

function blank(sourceType: CustomSourceType = 'live-camera'): Draft {
  return { version: 2, sourceType, label: '', group: groups[0]?.id || 'SURVEIL', color: '#4FC3F7', url: '', streamFormat: 'auto', intervalMs: sourceType === 'snapshot-camera' ? 30_000 : undefined, latProp: 'lat', lngProp: 'lng', labelProp: 'name', markerType: 'circle', radius: 5, tileKind: 'raster', minZoom: 0, maxZoom: 22 };
}

export default function CustomSourcesPanel({ open, onClose, activeLayers, setActiveLayers }: Props) {
  const sources = useCustomSources();
  const [draft, setDraft] = useState<Draft>(() => blank());
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.toLowerCase());
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const filtered = useMemo(() => sources.filter(source => `${source.label} ${source.url} ${source.sourceType}`.toLowerCase().includes(deferredQuery)), [sources, deferredQuery]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const selectType = (sourceType: CustomSourceType) => { setDraft(blank(sourceType)); setAdvanced(false); setRaw(''); setTest(null); setError(null); };
  const edit = (source: CustomSourceSpec) => { setDraft({ ...source }); setAdvanced(false); setRaw(JSON.stringify(source, null, 2)); setTest(null); setError(null); };

  const runTest = async () => {
    setTest({ loading: true });
    try {
      const params = new URLSearchParams({ url: draft.url }); if (draft.jsonPath) params.set('jsonPath', draft.jsonPath);
      const response = await fetch(`/api/source-test?${params}`); setTest(await response.json());
    } catch (cause) { setTest({ error: cause instanceof Error ? cause.message : 'Test failed' }); }
  };
  const save = () => {
    setError(null);
    try {
      const candidate: any = advanced ? JSON.parse(raw) : { ...draft, id: draft.id || `custom_${draft.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'source'}` };
      const validation = validateCustomSourceSpec(candidate, { groupIds: groups.map(group => group.id), existingIds: sources.map(source => source.id), currentId: candidate.id });
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      const result = upsertCustomSource(validation.value as CustomSourceSpec); if (!result.ok) throw new Error(result.error);
      setDraft(blank()); setRaw(''); setAdvanced(false); setTest(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <AnimatePresence>{open ? <motion.div className="fixed inset-0 z-[650] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="dialog" aria-modal="true" aria-label="Custom Sources">
    <motion.div className="flex h-[min(880px,94vh)] w-[min(1320px,96vw)] flex-col overflow-hidden border border-white/15 bg-[#0a0d10]/95 shadow-2xl" initial={{ scale: .98, y: 12 }} animate={{ scale: 1, y: 0 }}>
      <header className="flex h-16 items-center justify-between border-b border-white/10 px-5">
        <div className="flex items-center gap-3"><Layers className="h-5 w-5 text-[var(--gold-primary)]"/><h2 className="font-mono text-lg tracking-[.08em] text-[var(--gold-primary)]">CUSTOM SOURCES</h2></div>
        <button onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close custom sources"><X className="h-5 w-5"/></button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[340px_1fr]">
        <aside className="flex min-h-0 flex-col border-b border-white/10 bg-black/20 lg:border-b-0 lg:border-r">
          <div className="space-y-3 border-b border-white/10 p-4">
            <button onClick={() => selectType('live-camera')} className={`${button} w-full border-[var(--cyan-primary)]/60 text-[var(--cyan-primary)]`}><Plus className="h-4 w-4"/> ADD SOURCE</button>
            <div className="flex items-center border border-white/10 bg-black/30 px-3"><Search className="h-4 w-4 text-white/30"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter sources…" className="w-full bg-transparent px-2 py-2 text-[11px] font-mono text-white outline-none"/></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 styled-scrollbar"><div className="mb-2 text-[9px] font-mono text-white/35">{filtered.length} SOURCES</div>
            {filtered.length === 0 ? <div className="border border-dashed border-white/10 p-5 text-center text-[10px] font-mono text-white/30">No custom sources yet.</div> : filtered.map(source => {
              const def = TYPES.find(type => type.id === source.sourceType); const Icon = def?.icon || Braces; const active = !!activeLayers[source.id];
              return <div key={source.id} className="mb-1.5 flex items-center gap-2 border border-white/10 bg-white/[.025] p-2.5">
                <Icon className="h-4 w-4 shrink-0 text-white/55"/><button className="min-w-0 flex-1 text-left" onClick={() => edit(source)}><div className="truncate text-[11px] font-mono text-white/85">{source.label}</div><div className="truncate text-[8px] font-mono text-white/35">{def?.label}</div></button>
                <button onClick={() => setActiveLayers((current: any) => ({ ...current, [source.id]: !active }))} className={`h-4 w-8 rounded-full border p-0.5 ${active ? 'border-[var(--cyan-primary)] bg-[var(--cyan-primary)]/25' : 'border-white/20'}`} aria-label={`${active ? 'Disable' : 'Enable'} ${source.label}`}><span className={`block h-2.5 w-2.5 rounded-full transition-transform ${active ? 'translate-x-4 bg-[var(--cyan-primary)]' : 'bg-white/35'}`}/></button>
                <button onClick={() => edit(source)} className="text-white/35 hover:text-white" aria-label={`Edit ${source.label}`}><Pencil className="h-3.5 w-3.5"/></button><button onClick={() => removeCustomSource(source.id)} className="text-white/35 hover:text-red-400" aria-label={`Remove ${source.label}`}><Trash2 className="h-3.5 w-3.5"/></button>
              </div>;
            })}
          </div>
        </aside>
        <main className="min-h-0 overflow-y-auto p-5 md:p-7 styled-scrollbar">
          <div className="mb-6 text-[9px] font-mono tracking-[.18em] text-white/45">SELECT SOURCE TYPE</div>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-5">{TYPES.map(type => <button key={type.id} onClick={() => selectType(type.id)} className={`flex min-h-28 flex-col items-center justify-center gap-3 border p-3 text-center font-mono text-[10px] transition ${draft.sourceType === type.id ? 'border-[var(--cyan-primary)] bg-[var(--cyan-primary)]/5 text-white' : 'border-white/15 text-white/65 hover:border-white/35'}`}><type.icon className={`h-7 w-7 ${draft.sourceType === type.id ? 'text-[var(--cyan-primary)]' : ''}`}/>{type.label}</button>)}</div>
          <div className="my-5 flex items-center gap-4"><div className="h-px flex-1 bg-white/10"/><button onClick={() => { setAdvanced(value => !value); setRaw(JSON.stringify(draft, null, 2)); }} className={button}><Braces className="h-3.5 w-3.5"/> ADVANCED JSON</button></div>
          {advanced ? <textarea value={raw} onChange={event => setRaw(event.target.value)} rows={20} className={`${input} resize-y`}/> : <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Field title="Name"><input className={input} value={draft.label} onChange={event => set('label', event.target.value)} placeholder="Port of Rotterdam Cam"/></Field>
            <Field title={draft.sourceType === 'tile-layer' ? 'Tile URL template' : draft.sourceType.includes('camera') ? 'Stream / image URL' : 'Feed URL'}><input className={input} value={draft.url} onChange={event => set('url', event.target.value)} placeholder="https://…"/></Field>
            {(draft.sourceType === 'live-camera') ? <Field title="Stream format"><select className={input} value={draft.streamFormat} onChange={event => set('streamFormat', event.target.value as any)}><option value="auto">Auto detect</option><option value="hls">HLS</option><option value="mp4">MP4</option><option value="mjpeg">MJPEG</option><option value="iframe">iframe / embed</option></select></Field> : null}
            {draft.sourceType.includes('camera') ? <><Field title="Latitude"><input className={input} type="number" value={draft.lat ?? ''} onChange={event => set('lat', Number(event.target.value))}/></Field><Field title="Longitude"><input className={input} type="number" value={draft.lng ?? ''} onChange={event => set('lng', Number(event.target.value))}/></Field><Field title="Refresh / poll (ms)"><input className={input} type="number" value={draft.intervalMs ?? ''} onChange={event => set('intervalMs', event.target.value ? Number(event.target.value) : undefined)}/></Field></> : null}
            {draft.sourceType === 'json-points' ? <><Field title="JSON path → array"><input className={input} value={draft.jsonPath || ''} onChange={event => set('jsonPath', event.target.value)}/></Field><Field title="Latitude property"><input className={input} value={draft.latProp || ''} onChange={event => set('latProp', event.target.value)}/></Field><Field title="Longitude property"><input className={input} value={draft.lngProp || ''} onChange={event => set('lngProp', event.target.value)}/></Field><Field title="Label property"><input className={input} value={draft.labelProp || ''} onChange={event => set('labelProp', event.target.value)}/></Field></> : null}
            {draft.sourceType === 'geojson' ? <Field title="JSON path (optional)"><input className={input} value={draft.jsonPath || ''} onChange={event => set('jsonPath', event.target.value)}/></Field> : null}
            {draft.sourceType === 'tile-layer' ? <><Field title="Tile kind"><select className={input} value={draft.tileKind} onChange={event => set('tileKind', event.target.value as any)}><option value="raster">Raster XYZ</option><option value="vector">Vector</option></select></Field>{draft.tileKind === 'vector' ? <Field title="Source layer"><input className={input} value={draft.sourceLayer || ''} onChange={event => set('sourceLayer', event.target.value)}/></Field> : null}<Field title="Attribution"><input className={input} value={draft.attribution || ''} onChange={event => set('attribution', event.target.value)}/></Field></> : null}
            <Field title="Group"><select className={input} value={draft.group} onChange={event => set('group', event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.fullLabel}</option>)}</select></Field>
            <Field title="Color"><div className="flex gap-2"><input className={input} value={draft.color} onChange={event => set('color', event.target.value)}/><input type="color" value={draft.color} onChange={event => set('color', event.target.value)} className="h-9 w-12 border border-white/10 bg-transparent"/></div></Field>
          </div>}
          {test ? <div className={`mt-5 border p-4 font-mono text-[10px] ${test.loading ? 'border-white/15 text-white/50' : test.ok ? 'border-green-500/40 text-green-400' : 'border-red-500/40 text-red-400'}`}>{test.loading ? 'TESTING SOURCE…' : test.error || <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4"/> HTTP {test.status} · {test.detectedType || (test.count != null ? `${test.count} records` : test.message)}</span>}{test.sampleKeys?.length ? <div className="mt-2 text-white/45">Fields: {test.sampleKeys.join(', ')}</div> : null}</div> : null}
          {error ? <div className="mt-4 whitespace-pre-line border border-red-500/30 bg-red-500/5 p-3 text-[10px] font-mono text-red-400">{error}</div> : null}
          <div className="mt-6 flex justify-end gap-3"><button className={button} onClick={runTest} disabled={!draft.url}><FlaskConical className="h-4 w-4"/> TEST SOURCE</button><button className={`${button} border-[var(--cyan-primary)] bg-[var(--cyan-primary)] text-black hover:text-black`} onClick={save}>SAVE SOURCE</button></div>
        </main>
      </div>
    </motion.div>
  </motion.div> : null}</AnimatePresence>;
}

function Field({ title, children }: { title: string; children: React.ReactNode }) { return <label><span className={label}>{title}</span>{children}</label>; }
