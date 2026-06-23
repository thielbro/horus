'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Palette, Globe, KeyRound, RotateCw, Save, Monitor } from 'lucide-react';
import { useSettings, type ApiKeys, type CustomThemeTokens } from '@/lib/settings';
import ExtensionsSettings from '@/components/ExtensionsSettings';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

const KEY_FIELDS: Array<{ key: keyof ApiKeys; label: string; type: 'text' | 'password'; hint?: string }> = [
  { key: 'INTEL_URL', label: 'Intel URL', type: 'text', hint: 'entity graph backend base URL' },
  { key: 'SCANNER_URL', label: 'Scanner URL', type: 'text', hint: 'RECON backend base URL' },
  { key: 'SCANNER_KEY', label: 'Scanner Key', type: 'password', hint: 'must match backend OSIRIS_KEY' },
  { key: 'FIRMS_API_KEY', label: 'NASA FIRMS Key', type: 'password' },
  { key: 'OPENSKY_CLIENT_ID', label: 'OpenSky Client ID', type: 'text' },
  { key: 'OPENSKY_CLIENT_SECRET', label: 'OpenSky Secret', type: 'password' },
  { key: 'N2YO_API_KEY', label: 'N2YO Key', type: 'password' },
  { key: 'AIS_API_KEY', label: 'AISStream Key', type: 'password' },
];

const COLOR_ROWS: Array<{ token: keyof CustomThemeTokens; label: string }> = [
  { token: 'bg-void', label: 'Background' },
  { token: 'gold-primary', label: 'Gold Accent' },
  { token: 'cyan-primary', label: 'Cyan Accent' },
  { token: 'text-primary', label: 'Text' },
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

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { settings, update } = useSettings();
  const [isDesktop, setIsDesktop] = useState(false);
  const [keys, setKeys] = useState<ApiKeys>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setIsDesktop(typeof window !== 'undefined' && !!(window as unknown as { osiris?: { isDesktop?: boolean } }).osiris?.isDesktop);
  }, []);

  useEffect(() => {
    if (open) {
      setKeys(settings.apiKeys || {});
      setSaved(false);
    }
  }, [open, settings.apiKeys]);

  const theme = settings.appearance.theme;
  const custom = settings.appearance.custom;

  const setColor = (token: keyof CustomThemeTokens, value: string) =>
    update({ appearance: { theme: 'custom', custom: { [token]: value } as Partial<CustomThemeTokens> } });

  const saveKeys = (restart: boolean) => {
    update({ apiKeys: keys });
    setSaved(true);
    if (restart) {
      (window as unknown as { osiris?: { relaunch?: () => void } }).osiris?.relaunch?.();
    }
  };

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
                  onChange={(t) => update({ appearance: { theme: t } })}
                  options={[
                    { value: 'core', label: 'CORE' },
                    { value: 'ghost', label: 'GHOST' },
                    { value: 'custom', label: 'CUSTOM' },
                  ]}
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
                      onChange={(v) => update({ map: { defaultProjection: v } })}
                      options={[
                        { value: 'globe', label: '3D GLOBE' },
                        { value: 'mercator', label: '2D MAP' },
                      ]}
                    />
                  </div>
                  <div>
                    <div className="text-[9px] font-mono tracking-widest text-white/40 mb-1.5">BASE STYLE</div>
                    <Segmented
                      value={settings.map.defaultStyle}
                      onChange={(v) => update({ map: { defaultStyle: v } })}
                      options={[
                        { value: 'dark', label: 'DARK' },
                        { value: 'satellite', label: 'SATELLITE' },
                      ]}
                    />
                  </div>
                  <p className="text-[9px] font-mono text-white/30 leading-relaxed">Applied on next launch / reload.</p>
                </div>
              </section>

              {/* ── API keys (desktop only) ── */}
              <section>
                <SectionTitle icon={KeyRound}>API KEYS</SectionTitle>
                {isDesktop ? (
                  <div className="space-y-2.5">
                    {KEY_FIELDS.map(({ key, label, type, hint }) => (
                      <div key={key}>
                        <div className="flex items-baseline justify-between">
                          <label className="text-[10px] font-mono tracking-wider text-white/60 uppercase">{label}</label>
                          {hint && <span className="text-[8px] font-mono text-white/25">{hint}</span>}
                        </div>
                        <input
                          type={type}
                          value={keys[key] || ''}
                          onChange={(e) => setKeys((k) => ({ ...k, [key]: e.target.value }))}
                          autoComplete="off"
                          className="w-full mt-1 bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none"
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => saveKeys(false)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 text-[10px] font-mono tracking-wider text-white/70 hover:border-[var(--gold-primary)]/40 hover:text-white transition-colors"
                      >
                        <Save className="w-3.5 h-3.5" /> SAVE
                      </button>
                      <button
                        onClick={() => saveKeys(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--cyan-primary)]/30 text-[10px] font-mono tracking-wider text-[var(--cyan-primary)] hover:bg-[var(--cyan-primary)]/10 transition-colors"
                      >
                        <RotateCw className="w-3.5 h-3.5" /> SAVE &amp; RESTART ENGINE
                      </button>
                      {saved && <span className="text-[9px] font-mono text-[var(--alert-green)]">SAVED</span>}
                    </div>
                    <p className="text-[9px] font-mono text-white/30 leading-relaxed">
                      Keys are injected into the embedded engine on launch. Stored locally in plain text.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[10px] font-mono text-white/40 bg-black/30 border border-white/5 rounded px-3 py-2.5">
                    <Monitor className="w-3.5 h-3.5 shrink-0" />
                    API keys are configured in the desktop app (set via environment variables on the web).
                  </div>
                )}
              </section>

              {/* ── Extensions: custom sources + plugins ── */}
              <ExtensionsSettings />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
