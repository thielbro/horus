'use client';

import { useEffect, useState } from 'react';
import { Layers, Save, Download, Copy, Pencil, Trash2, Check, X } from 'lucide-react';
import { useSettings, type Workspace } from '@/lib/settings';
import type { WorkspaceSnapshot } from '@/lib/workspaces';

interface WorkspacesSettingsProps {
  /** Capture the live UI/map state as a snapshot (called on save / update). */
  getCurrentSnapshot: () => WorkspaceSnapshot;
  /** Apply a saved snapshot back onto the live app. */
  onApply: (snapshot: WorkspaceSnapshot) => void;
}

const MAX_WORKSPACES = 50;

function newId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function SectionTitle({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3 text-[11px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-2">
      <Icon className="w-3.5 h-3.5" />
      {children}
    </div>
  );
}

export default function WorkspacesSettings({ getCurrentSnapshot, onApply }: WorkspacesSettingsProps) {
  const { settings, update } = useSettings();
  const workspaces: Workspace[] = settings.workspaces || [];

  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // One transient message slot: an error persists until the next action; a flash
  // auto-dismisses. Unifying them avoids a stale flash resurfacing under an error.
  const [notice, setNotice] = useState<{ kind: 'error' | 'flash'; message: string } | null>(null);

  const fail = (message: string) => setNotice({ kind: 'error', message });
  const flashMsg = (message: string) => setNotice({ kind: 'flash', message });
  const captureSnapshot = (): WorkspaceSnapshot | null => {
    try {
      return getCurrentSnapshot();
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not capture current workspace.');
      return null;
    }
  };

  // Auto-dismiss success flashes; errors stay until cleared by the next action.
  useEffect(() => {
    if (notice?.kind !== 'flash') return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const persist = (next: Workspace[]) => update({ workspaces: next });

  // Case-insensitive name collision check, optionally ignoring one workspace (for rename).
  const nameTaken = (name: string, ignoreId?: string) =>
    workspaces.some((w) => w.id !== ignoreId && w.name.toLowerCase() === name.toLowerCase());

  // Derive a non-colliding "<base> copy" / "<base> copy N" name for duplication.
  const uniqueName = (base: string) => {
    let candidate = `${base} copy`;
    for (let n = 2; nameTaken(candidate); n++) candidate = `${base} copy ${n}`;
    return candidate;
  };

  const saveCurrent = () => {
    const name = newName.trim();
    if (!name) {
      fail('Name the workspace first.');
      return;
    }
    if (nameTaken(name)) {
      fail('A workspace with that name already exists.');
      return;
    }
    if (workspaces.length >= MAX_WORKSPACES) {
      fail(`Workspace limit reached (${MAX_WORKSPACES}).`);
      return;
    }
    const state = captureSnapshot();
    if (!state) return;
    persist([...workspaces, { id: newId(), name, state }]);
    setNewName('');
    flashMsg(`Saved “${name}”.`);
  };

  const updateExisting = (ws: Workspace) => {
    const state = captureSnapshot();
    if (!state) return;
    persist(workspaces.map((w) => (w.id === ws.id ? { ...w, state } : w)));
    flashMsg(`Updated “${ws.name}”.`);
  };

  const duplicate = (ws: Workspace) => {
    if (workspaces.length >= MAX_WORKSPACES) {
      fail(`Workspace limit reached (${MAX_WORKSPACES}).`);
      return;
    }
    const idx = workspaces.findIndex((w) => w.id === ws.id);
    const copy: Workspace = { id: newId(), name: uniqueName(ws.name), state: ws.state };
    const next = [...workspaces];
    next.splice(idx + 1, 0, copy);
    persist(next);
    flashMsg(`Duplicated “${ws.name}”.`);
  };

  const remove = (ws: Workspace) => {
    persist(workspaces.filter((w) => w.id !== ws.id));
    if (renamingId === ws.id) setRenamingId(null);
    flashMsg(`Deleted “${ws.name}”.`);
  };

  const load = (ws: Workspace) => {
    onApply(ws.state);
    flashMsg(`Loaded “${ws.name}”.`);
  };

  const beginRename = (ws: Workspace) => {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
    setNotice(null);
  };

  const commitRename = (ws: Workspace) => {
    const name = renameValue.trim();
    if (!name) {
      fail('Name cannot be empty.');
      return;
    }
    if (nameTaken(name, ws.id)) {
      fail('A workspace with that name already exists.');
      return;
    }
    persist(workspaces.map((w) => (w.id === ws.id ? { ...w, name } : w)));
    setRenamingId(null);
  };

  const iconBtn =
    'p-1.5 rounded border border-white/10 text-white/60 hover:text-white hover:border-[var(--gold-primary)]/40 transition-colors';

  return (
    <section>
      <SectionTitle icon={Layers}>WORKSPACES</SectionTitle>

      {/* Save current */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveCurrent();
          }}
          placeholder="New workspace name…"
          className="flex-1 bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none"
        />
        <button
          onClick={saveCurrent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--cyan-primary)]/30 text-[10px] font-mono tracking-wider text-[var(--cyan-primary)] hover:bg-[var(--cyan-primary)]/10 transition-colors shrink-0"
        >
          <Save className="w-3.5 h-3.5" /> SAVE CURRENT
        </button>
      </div>

      {notice && (
        <p
          className={`text-[9px] font-mono mb-2 ${
            notice.kind === 'error' ? 'text-[var(--alert-red,#ff5a5a)]' : 'text-[var(--alert-green)]'
          }`}
        >
          {notice.message}
        </p>
      )}

      {workspaces.length === 0 ? (
        <p className="text-[10px] font-mono text-white/30 leading-relaxed">
          No saved workspaces. Arrange your layers, view, and panels, then SAVE CURRENT to capture them.
        </p>
      ) : (
        <div className="space-y-1.5">
          {workspaces.map((ws) => {
            const activeCount = Object.values(ws.state.activeLayers || {}).filter(Boolean).length;
            const renaming = renamingId === ws.id;
            return (
              <div
                key={ws.id}
                className="flex items-center gap-2 bg-black/30 border border-white/5 rounded px-2.5 py-1.5"
              >
                {renaming ? (
                  <>
                    <input
                      autoFocus
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(ws);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none"
                    />
                    <button onClick={() => commitRename(ws)} className={iconBtn} title="Confirm">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setRenamingId(null)} className={iconBtn} title="Cancel">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => load(ws)}
                      className="flex-1 flex items-baseline gap-2 text-left min-w-0"
                      title="Load workspace"
                    >
                      <span className="text-[11px] font-mono text-white/85 truncate">{ws.name}</span>
                      <span className="text-[8px] font-mono text-white/30 tabular-nums shrink-0">
                        {activeCount} layer{activeCount === 1 ? '' : 's'}
                      </span>
                    </button>
                    <button onClick={() => load(ws)} className={iconBtn} title="Load">
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => updateExisting(ws)} className={iconBtn} title="Update to current state">
                      <Save className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => duplicate(ws)} className={iconBtn} title="Duplicate">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => beginRename(ws)} className={iconBtn} title="Rename">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(ws)}
                      className="p-1.5 rounded border border-white/10 text-white/60 hover:text-[var(--alert-red,#ff5a5a)] hover:border-[var(--alert-red,#ff5a5a)]/40 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
        A workspace captures active layers, map view, projection, base style, theme, and panel
        visibility. Loading drops layers from removed extensions.
      </p>
    </section>
  );
}
