'use client';

// Settings UI for the extension system: a no-code Custom Sources builder (form + raw spec)
// and a Plugins manager (in-app editor + file load + enable/disable/remove). Both write
// through the plugin subsystem, which registers into the live registry and persists.

import { useMemo, useRef, useState } from 'react';
import { Boxes, Puzzle, Plus, Trash2, Upload, Pencil, AlertTriangle, Power, Download, FileUp } from 'lucide-react';
import { getGroups } from '@/lib/registry';
import {
  useCustomSources, upsertCustomSource, removeCustomSource,
  usePlugins, installPlugin, uninstallPlugin, setPluginEnabled,
  exportExtensionBundle, importExtensionBundle, serializeExtensionBundle,
  validateCustomSourceSpec, formatValidationErrors,
  type CustomSourceSpec,
} from '@/lib/plugins';

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3 text-[11px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-2">
      <Icon className="w-3.5 h-3.5" />
      {children}
    </div>
  );
}

const inputCls = 'w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none';
const labelCls = 'text-[9px] font-mono tracking-widest text-white/40 mb-1 block uppercase';
const btnCls = 'flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-[10px] font-mono tracking-wider text-white/70 hover:border-[var(--gold-primary)]/40 hover:text-white transition-colors';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'source';

function ExtensionBundleSection() {
  const importRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<string[]>([]);

  const exportBundle = () => {
    setSummary(null);
    setItemErrors([]);
    const blob = new Blob([serializeExtensionBundle(exportExtensionBundle())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `horus-extensions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setSummary(null);
    setItemErrors([]);
    try {
      const result = await importExtensionBundle(await file.text());
      setSummary(`Imported ${result.imported.customSources} sources and ${result.imported.plugins} plugins.`);
      setItemErrors(result.skipped.map((issue) => `${issue.kind}${issue.id ? `:${issue.id}` : ''} - ${issue.error}`));
    } catch (err: any) {
      setItemErrors([String(err?.message ?? err)]);
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <section>
      <SectionTitle icon={Download}>EXTENSION BUNDLE</SectionTitle>
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={exportBundle} className={btnCls}><Download className="w-3.5 h-3.5" /> EXPORT BUNDLE</button>
        <button disabled={busy} onClick={() => importRef.current?.click()} className={`${btnCls} disabled:opacity-40`}><FileUp className="w-3.5 h-3.5" /> IMPORT BUNDLE</button>
        <input ref={importRef} type="file" accept=".json" className="hidden" onChange={onImport} />
      </div>
      {summary && <div className="mt-2 text-[10px] font-mono text-[var(--alert-green)]">{summary}</div>}
      {itemErrors.length > 0 && (
        <div className="mt-2 space-y-1">
          {itemErrors.map((item, i) => (
            <div key={`${item}-${i}`} className="text-[9px] font-mono text-[var(--alert-red)] break-words flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type Draft = Omit<CustomSourceSpec, 'id'> & { id?: string };
const EMPTY_DRAFT = (group: string): Draft => ({
  version: 2, sourceType: 'json-points', label: '', group, color: '#4FC3F7', url: '', jsonPath: '', latProp: 'lat', lngProp: 'lng',
  labelProp: '', markerType: 'circle', radius: 5, intervalMs: undefined,
});

function CustomSourcesSection() {
  const sources = useCustomSources();
  const groups = useMemo(() => getGroups(), []);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT(groups[0]?.id ?? 'THREAT'));
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const edit = (s: CustomSourceSpec) => { setDraft({ ...s }); setRaw(false); setError(null); };

  const removeSource = (id: string) => {
    setError(null);
    try {
      removeCustomSource(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = () => {
    setError(null);
    try {
      let spec: CustomSourceSpec;
      if (raw) {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Raw custom source JSON must be an object.');
        }
        spec = parsed;
        if (!spec.id) spec.id = `custom_${slug(spec.label || 'source')}`;
      } else {
        if (!draft.label.trim()) throw new Error('Name is required.');
        if (!draft.url.trim()) throw new Error('Feed URL is required.');
        spec = { ...draft, id: draft.id ?? `custom_${slug(draft.label)}` };
        if (!spec.intervalMs) delete (spec as any).intervalMs;
        if (!spec.labelProp) delete (spec as any).labelProp;
        if (!spec.jsonPath) delete (spec as any).jsonPath;
      }
      const validation = validateCustomSourceSpec(spec, {
        groupIds: groups.map((g) => g.id),
        existingIds: sources.map((s) => s.id),
        currentId: spec.id,
      });
      if (!validation.ok) throw new Error(formatValidationErrors(validation.errors));
      const result = upsertCustomSource(validation.value);
      if (!result.ok) throw new Error(result.error ?? 'Custom source could not be registered.');
      setDraft(EMPTY_DRAFT(groups[0]?.id ?? 'THREAT'));
      setRawText('');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  return (
    <section>
      <SectionTitle icon={Boxes}>CUSTOM SOURCES</SectionTitle>

      {sources.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {sources.map((s) => (
            <div key={s.id} className="bg-black/30 border border-white/5 rounded px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                  <span className="text-[11px] font-mono text-white/85 truncate">{s.label}</span>
                  <span className="text-[9px] font-mono text-white/30 truncate">{s.url}</span>
                  {s.error && <span className="text-[9px] font-mono text-[var(--alert-red)]">ERROR</span>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => edit(s)} className="p-1 text-white/40 hover:text-[var(--cyan-primary)]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => removeSource(s.id)} className="p-1 text-white/40 hover:text-[var(--alert-red)]" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              {s.error && <div className="mt-1 text-[9px] font-mono text-[var(--alert-red)] break-words">{s.error}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono tracking-wider text-white/50">{draft.id ? 'EDIT SOURCE' : 'NEW SOURCE'}</span>
        <button onClick={() => setRaw((r) => !r)} className="text-[9px] font-mono tracking-wider text-white/40 hover:text-white/80">{raw ? 'FORM' : 'ADVANCED (JSON)'}</button>
      </div>

      {raw ? (
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={'{\n  "label": "My Source",\n  "group": "THREAT",\n  "color": "#4FC3F7",\n  "url": "/api/whatever",\n  "jsonPath": "data.items",\n  "latProp": "lat",\n  "lngProp": "lng",\n  "labelProp": "name",\n  "markerType": "circle",\n  "intervalMs": 60000\n}'}
          rows={11}
          className={`${inputCls} resize-y`}
          spellCheck={false}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2"><label className={labelCls}>Name</label><input className={inputCls} value={draft.label} onChange={(e) => set('label', e.target.value)} /></div>
          <div className="col-span-2"><label className={labelCls}>Feed URL</label><input className={inputCls} value={draft.url} onChange={(e) => set('url', e.target.value)} placeholder="/api/... or https://..." /></div>
          <div><label className={labelCls}>Group</label>
            <select className={inputCls} value={draft.group} onChange={(e) => set('group', e.target.value)}>
              {groups.map((g) => <option key={g.id} value={g.id} className="bg-black">{g.fullLabel}</option>)}
            </select>
          </div>
          <div><label className={labelCls}>Color</label>
            <div className="flex gap-1.5 items-center">
              <input className={inputCls} value={draft.color} onChange={(e) => set('color', e.target.value)} />
              <input type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10 shrink-0" />
            </div>
          </div>
          <div><label className={labelCls}>JSON path → array</label><input className={inputCls} value={draft.jsonPath ?? ''} onChange={(e) => set('jsonPath', e.target.value)} placeholder="data.items (blank = root)" /></div>
          <div><label className={labelCls}>Marker</label>
            <select className={inputCls} value={draft.markerType} onChange={(e) => set('markerType', e.target.value as 'circle' | 'symbol')}>
              <option value="circle" className="bg-black">Dot</option>
              <option value="symbol" className="bg-black">Label</option>
            </select>
          </div>
          <div><label className={labelCls}>Lat property</label><input className={inputCls} value={draft.latProp} onChange={(e) => set('latProp', e.target.value)} /></div>
          <div><label className={labelCls}>Lng property</label><input className={inputCls} value={draft.lngProp} onChange={(e) => set('lngProp', e.target.value)} /></div>
          <div><label className={labelCls}>Label property</label><input className={inputCls} value={draft.labelProp ?? ''} onChange={(e) => set('labelProp', e.target.value)} placeholder="name (optional)" /></div>
          <div><label className={labelCls}>Poll (ms)</label><input className={inputCls} type="number" value={draft.intervalMs ?? ''} onChange={(e) => set('intervalMs', e.target.value ? Number(e.target.value) : undefined)} placeholder="once" /></div>
        </div>
      )}

      {error && <div className="mt-2 text-[10px] font-mono text-[var(--alert-red)] flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</div>}

      <div className="flex items-center gap-2 mt-3">
        <button onClick={save} className={btnCls}><Plus className="w-3.5 h-3.5" /> {draft.id ? 'UPDATE' : 'ADD SOURCE'}</button>
        {draft.id && <button onClick={() => { setDraft(EMPTY_DRAFT(groups[0]?.id ?? 'THREAT')); setError(null); }} className="text-[9px] font-mono text-white/40 hover:text-white/80">CANCEL EDIT</button>}
      </div>
      <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
        Adds a toggleable layer in the sidebar. Toggle it on to fetch the feed and plot each item; click a marker for its details.
      </p>
    </section>
  );
}

const SAMPLE_PLUGIN = `// Trusted in-process plugin. Default-export a definition.
export default {
  id: 'dogfood-local-incidents',
  name: 'Dogfood Local Incidents',
  version: '1.0.0',
  sdk: 1,
  activate(ctx) {
    const point = window.HorusSDK?.point ?? ((lng, lat, props = {}) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: props,
    }));

    ctx.registerGroup({
      id: 'DOGFOOD',
      label: 'DOG',
      fullLabel: 'DOGFOOD',
      color: '#00E5FF',
      order: 95,
    });

    ctx.registerFeed({
      id: 'local-incidents',
      fetch: {
        kind: 'endpoint',
        url: '/examples/extensions/incidents.json',
        transform: (raw) => ({ dogfood_incidents: Array.isArray(raw?.items) ? raw.items : [] }),
      },
      priority: 'lazy',
    });

    ctx.registerLayer({
      id: 'local_incidents',
      label: 'Local Incidents',
      group: 'DOGFOOD',
      color: '#00E5FF',
      icon: 'AlertTriangle',
      feeds: ['local-incidents'],
      countBuckets: ['dogfood_incidents'],
      styleLayers: [
        { id: 'dots', mapSource: 'incidents', type: 'circle', paint: {
          'circle-radius': 6, 'circle-color': '#00E5FF', 'circle-opacity': 0.9,
          'circle-stroke-width': 1.5, 'circle-stroke-color': '#000', 'circle-stroke-opacity': 0.6,
        } },
      ],
      render: [{
        mapSource: 'incidents',
        source: {
          bucket: 'dogfood_incidents',
          toFeatures: (items) => items.map((it) => point(it.lng, it.lat, it)),
        },
      }],
      interaction: { kind: 'popup', html: (p) => '<b>' + p.name + '</b><br/>' + p.status },
    });
    ctx.log.info('dogfood-local-incidents activated');
  },
};`;

function PluginsSection() {
  const plugins = usePlugins();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const install = async (src: string) => {
    setBusy(true); setError(null);
    try {
      const res = await installPlugin(src);
      if (!res.ok || res.error) setError(res.error ?? 'Install failed.');
      else setCode('');
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) { try { await install(await f.text()); } catch (err: any) { setError(String(err?.message ?? err)); } }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <section>
      <SectionTitle icon={Puzzle}>PLUGINS</SectionTitle>

      {plugins.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {plugins.map((p) => (
            <div key={p.id} className="bg-black/30 border border-white/5 rounded px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-mono text-white/85 truncate">{p.name}</span>
                  <span className="text-[9px] font-mono text-white/30">v{p.version}</span>
                  {p.error ? <span className="text-[9px] font-mono text-[var(--alert-red)]">ERROR</span>
                    : p.enabled ? <span className="text-[9px] font-mono text-[var(--alert-green)]">ON</span>
                    : <span className="text-[9px] font-mono text-white/30">OFF</span>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setPluginEnabled(p.id, !p.enabled)} className={`p-1 ${p.enabled ? 'text-[var(--alert-green)]' : 'text-white/40'} hover:text-white`} title={p.enabled ? 'Disable' : 'Enable'}><Power className="w-3.5 h-3.5" /></button>
                  <button onClick={() => uninstallPlugin(p.id)} className="p-1 text-white/40 hover:text-[var(--alert-red)]" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              {p.error && <div className="mt-1 text-[9px] font-mono text-[var(--alert-red)] break-words">{p.error}</div>}
            </div>
          ))}
        </div>
      )}

      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Paste or write plugin code here…  (export default { id, name, version, activate(ctx) {…} })"
        rows={9}
        className={`${inputCls} resize-y`}
        spellCheck={false}
      />
      {error && <div className="mt-2 text-[10px] font-mono text-[var(--alert-red)] flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /><span className="break-words">{error}</span></div>}

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button disabled={busy || !code.trim()} onClick={() => install(code)} className={`${btnCls} disabled:opacity-40`}><Plus className="w-3.5 h-3.5" /> INSTALL</button>
        <button onClick={() => fileRef.current?.click()} className={btnCls}><Upload className="w-3.5 h-3.5" /> LOAD FILE</button>
        <button onClick={() => setCode(SAMPLE_PLUGIN)} className="text-[9px] font-mono text-white/40 hover:text-white/80">INSERT SAMPLE</button>
        <input ref={fileRef} type="file" accept=".js,.mjs,.txt" multiple className="hidden" onChange={onFile} />
      </div>
      <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
        Plugins are trusted and run in-process (no sandbox). They register layers/sources/groups via <code className="text-white/50">ctx</code>. Stored locally and re-activated on launch.
      </p>
    </section>
  );
}

export default function ExtensionsSettings() {
  return (
    <>
      <ExtensionBundleSection />
      <PluginsSection />
    </>
  );
}
