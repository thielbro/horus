'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Palette, Globe, KeyRound, RotateCw, Save, Monitor, Server } from 'lucide-react';
import { DEFAULT_SETTINGS, getSettings, useSettings, type ApiKeys, type CustomThemeTokens } from '@/lib/settings';
import type { WorkspaceSnapshot } from '@/lib/workspaces';
import ExtensionsSettings from '@/components/ExtensionsSettings';
import WorkspacesSettings from '@/components/WorkspacesSettings';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  getWorkspaceSnapshot: () => WorkspaceSnapshot;
  onApplyWorkspace: (snapshot: WorkspaceSnapshot) => void;
}

type SettingsField = { key: keyof ApiKeys; label: string; type: 'text' | 'password'; hint?: string };

const SERVICE_URL_FIELDS: SettingsField[] = [
  { key: 'INTEL_URL', label: 'Intel URL', type: 'text', hint: 'entity graph backend base URL' },
  { key: 'SCANNER_URL', label: 'Scanner URL', type: 'text', hint: 'RECON backend base URL' },
  { key: 'SURVEILLANCE_FEED_URL', label: 'Surveillance Feed URL', type: 'text', hint: 'fixed surveillance layer backend' },
  { key: 'LLM_URL', label: 'Local LLM URL', type: 'text', hint: 'OpenAI-compatible (Ollama: http://127.0.0.1:11434/v1)' },
  { key: 'FIRECRAWL_URL', label: 'Firecrawl URL', type: 'text', hint: 'self-hosted search/scrape (http://127.0.0.1:3002)' },
  { key: 'ROUTING_URL', label: 'Routing URL', type: 'text', hint: 'OSRM for route exposure (self-host, or https://router.project-osrm.org)' },
];

const KEY_FIELDS: SettingsField[] = [
  { key: 'SCANNER_KEY', label: 'Scanner Key', type: 'password', hint: 'must match backend HORUS_KEY' },
  { key: 'FIRMS_API_KEY', label: 'NASA FIRMS Key', type: 'password' },
  { key: 'OPENSKY_CLIENT_ID', label: 'OpenSky Client ID', type: 'text' },
  { key: 'OPENSKY_CLIENT_SECRET', label: 'OpenSky Secret', type: 'password' },
  { key: 'N2YO_API_KEY', label: 'N2YO Key', type: 'password' },
  { key: 'AIS_API_KEY', label: 'AISStream Key', type: 'password' },
  { key: 'LLM_MODEL', label: 'Local LLM Model', type: 'text', hint: 'e.g. llama3.1' },
  { key: 'FIRECRAWL_KEY', label: 'Firecrawl Key', type: 'password', hint: 'optional' },
  { key: 'MAPILLARY_TOKEN', label: 'Mapillary Token', type: 'password', hint: 'street-level imagery' },
];

const COLOR_ROWS: Array<{ token: keyof CustomThemeTokens; label: string }> = [
  { token: 'bg-void', label: 'Background' },
  { token: 'gold-primary', label: 'Gold Accent' },
  { token: 'cyan-primary', label: 'Cyan Accent' },
  { token: 'text-primary', label: 'Text' },
];

const APPEARANCE_OPTIONS: Array<{ value: 'core' | 'ghost' | 'custom'; label: string }> = [
  { value: 'core', label: 'CORE' },
  { value: 'ghost', label: 'GHOST' },
  { value: 'custom', label: 'CUSTOM' },
];

const PROJECTION_OPTIONS: Array<{ value: 'globe' | 'mercator'; label: string }> = [
  { value: 'globe', label: '3D GLOBE' },
  { value: 'mercator', label: '2D MAP' },
];

const STYLE_OPTIONS: Array<{ value: 'dark' | 'satellite'; label: string }> = [
  { value: 'dark', label: 'DARK' },
  { value: 'satellite', label: 'SATELLITE' },
];

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3 text-[11px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-2">
      <Icon className="w-3.5 h-3.5" />
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-black/40 border border-white/5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 px-3 py-1.5 rounded text-[10px] font-mono tracking-wider transition-colors ${
            value === o.value ? 'bg-[var(--gold-primary)]/20 text-[var(--gold-primary)]' : 'text-white/50 hover:text-white/80'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SettingsFieldRow({ field, value, onChange }: { field: SettingsField; value: string; onChange: (key: keyof ApiKeys, value: string) => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-[10px] font-mono tracking-wider text-white/60 uppercase">{field.label}</label>
        {field.hint && <span className="text-[8px] font-mono text-white/25 text-right">{field.hint}</span>}
      </div>
      <input
        type={field.type}
        value={value}
        onChange={(e) => onChange(field.key, e.target.value)}
        autoComplete="off"
        className="w-full mt-1 bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none"
      />
    </div>
  );
}

function DesktopSettingsUnavailable() {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-white/40 bg-black/30 border border-white/5 rounded px-3 py-2.5">
      <Monitor className="w-3.5 h-3.5 shrink-0" />
      Service URLs and API keys are configured in the desktop app or environment variables.
    </div>
  );
}

function usePrevious<T>(value: T, initial: T): T {
  const ref = useRef(initial);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

function SettingsPanel({ open, onClose, getWorkspaceSnapshot, onApplyWorkspace }: SettingsPanelProps) {
  const { settings, update } = useSettings();
  const [isDesktop, setIsDesktop] = useState(false);
  const [keys, setKeys] = useState<ApiKeys>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const previousOpen = usePrevious(open, false);

  useEffect(() => {
    setIsDesktop(typeof window !== 'undefined' && !!(window as unknown as { horus?: { isDesktop?: boolean } }).horus?.isDesktop);
  }, []);

  useEffect(() => {
    if (open && !previousOpen) {
      setKeys(getSettings().apiKeys || {});
      setSaved(false);
      setSaveError(null);
    }
  }, [open, previousOpen]);

  const theme = settings.appearance.theme;
  const custom = useMemo(
    () => ({ ...DEFAULT_SETTINGS.appearance.custom, ...(settings.appearance.custom ?? {}) }),
    [settings.appearance.custom],
  );

  const setColor = useCallback((token: keyof CustomThemeTokens, value: string) => {
    void update({ appearance: { theme: 'custom', custom: { ...custom, [token]: value } } });
  }, [custom, update]);

  const saveKeys = useCallback(async (restart: boolean) => {
    setSaveError(null);
    const persisted = await update({ apiKeys: keys });
    if (!persisted) {
      setSaved(false);
      setSaveError('SAVE FAILED');
      return;
    }
    setSaved(true);
    if (restart) {
      (window as unknown as { horus?: { relaunch?: () => void } }).horus?.relaunch?.();
    }
  }, [keys, update]);

  const setKeyValue = useCallback((key: keyof ApiKeys, value: string) => {
    setKeys((k) => ({ ...k, [key]: value }));
  }, []);

  const saveControls = (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={() => { void saveKeys(false); }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-[10px] font-mono tracking-wider text-white/70 hover:border-[var(--gold-primary)]/40 hover:text-white transition-colors"
      >
        <Save className="w-3.5 h-3.5" /> SAVE
      </button>
      <button
        onClick={() => { void saveKeys(true); }}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--cyan-primary)]/30 text-[10px] font-mono tracking-wider text-[var(--cyan-primary)] hover:bg-[var(--cyan-primary)]/10 transition-colors"
      >
        <RotateCw className="w-3.5 h-3.5" /> SAVE &amp; RESTART ENGINE
      </button>
      {saved && <span className="text-[9px] font-mono text-[var(--alert-green)]">SAVED</span>}
      {saveError && <span className="text-[9px] font-mono text-[var(--alert-red)]">{saveError}</span>}
    </div>
  );

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
              <span className="text-sm font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)]">SETTINGS</span>
              <button onClick={onClose} className="text-[var(--text-muted)] hover:text-white transition-colors p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-7">
              {/* ── Appearance ── */}
              <section>
                <SectionTitle icon={Palette}>APPEARANCE</SectionTitle>
                <Segmented
                  value={theme}
                  onChange={(t) => { void update({ appearance: { theme: t } }); }}
                  options={APPEARANCE_OPTIONS}
                />
                {theme === 'custom' && (
                  <div className="mt-3 space-y-2">
                    {COLOR_ROWS.map(({ token, label }) => (
                      <div key={token} className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-mono tracking-wider text-white/60 uppercase">{label}</span>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={custom[token]}
                            onChange={(e) => setColor(token, e.target.value)}
                            className="w-24 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-white/80 focus:border-[var(--gold-primary)]/40 outline-none"
                          />
                          <input
                            type="color"
                            value={custom[token]}
                            onChange={(e) => setColor(token, e.target.value)}
                            className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ── Map defaults ── */}
              <section>
                <SectionTitle icon={Globe}>MAP DEFAULTS</SectionTitle>
                <div className="space-y-3">
                  <div>
                    <div className="text-[9px] font-mono tracking-widest text-white/40 mb-1.5">PROJECTION</div>
                    <Segmented
                      value={settings.map.defaultProjection}
                      onChange={(v) => { void update({ map: { defaultProjection: v } }); }}
                      options={PROJECTION_OPTIONS}
                    />
                  </div>
                  <div>
                    <div className="text-[9px] font-mono tracking-widest text-white/40 mb-1.5">BASE STYLE</div>
                    <Segmented
                      value={settings.map.defaultStyle}
                      onChange={(v) => { void update({ map: { defaultStyle: v } }); }}
                      options={STYLE_OPTIONS}
                    />
                  </div>
                  <p className="text-[9px] font-mono text-white/30 leading-relaxed">Applied on next launch / reload.</p>
                </div>
              </section>

              {/* ── Service URLs (desktop only) ── */}
              <section>
                <SectionTitle icon={Server}>SERVICE URLS</SectionTitle>
                {isDesktop ? (
                  <div className="space-y-2.5">
                    {SERVICE_URL_FIELDS.map((field) => (
                      <SettingsFieldRow key={field.key} field={field} value={keys[field.key] || ''} onChange={setKeyValue} />
                    ))}
                    {saveControls}
                  </div>
                ) : <DesktopSettingsUnavailable />}
              </section>

              {/* ── API keys (desktop only) ── */}
              <section>
                <SectionTitle icon={KeyRound}>API KEYS</SectionTitle>
                {isDesktop ? (
                  <div className="space-y-2.5">
                    {KEY_FIELDS.map((field) => (
                      <SettingsFieldRow key={field.key} field={field} value={keys[field.key] || ''} onChange={setKeyValue} />
                    ))}
                    {saveControls}
                    <p className="text-[9px] font-mono text-white/30 leading-relaxed">
                      Keys are injected into the embedded engine on launch. Stored locally in plain text.
                    </p>
                  </div>
                ) : <DesktopSettingsUnavailable />}
              </section>

              {/* ── Saved workspaces / layouts ── */}
              <WorkspacesSettings getCurrentSnapshot={getWorkspaceSnapshot} onApply={onApplyWorkspace} />

              {/* ── Extensions: custom sources + plugins ── */}
              <ExtensionsSettings />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default memo(SettingsPanel);
