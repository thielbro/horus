'use client';

// HORUS — Stream Wall. Freeform multi-livestream tiles floating over the map.
//
// The wall layer is pointer-events-none so the map stays interactive between
// tiles; each tile re-enables pointer events on itself. Tile list + geometry
// persist to settings (streamWall.tiles); audio focus is session-only.

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Plus, Tv, ChevronDown } from 'lucide-react';
import { useSettings, type StreamTileState } from '@/lib/settings';
import { classifyStreamUrl } from '@/lib/streams';
import StreamTile from './StreamTile';

const MAX_TILES = 9;

export interface StreamAddRequest {
  url: string;
  name?: string;
  embedAllowed?: boolean;
  ts: number;
}

interface StreamWallProps {
  open: boolean;
  onClose: () => void;
  addRequest: StreamAddRequest | null;
}

interface PresetFeed {
  id: string;
  name: string;
  city?: string;
  country?: string;
  url: string;
  embed_allowed?: boolean;
}

export default function StreamWall({ open, onClose, addRequest }: StreamWallProps) {
  const { settings, update, ready } = useSettings();
  const [tiles, setTiles] = useState<StreamTileState[]>([]);
  const [audioFocusId, setAudioFocusId] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [presets, setPresets] = useState<PresetFeed[] | null>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const zCounter = useRef(1);
  const hydrated = useRef(false);

  // ── Hydrate tiles from settings once ──
  useEffect(() => {
    if (!ready || hydrated.current) return;
    hydrated.current = true;
    const saved = settings.streamWall?.tiles ?? [];
    setTiles(saved);
    zCounter.current = saved.reduce((m, t) => Math.max(m, t.z), 0) + 1;
  }, [ready, settings.streamWall]);

  // ── Persist (debounced; deepMerge replaces arrays wholesale — write full array) ──
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hydrated.current) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => { void update({ streamWall: { tiles } }); }, 500);
    return () => { if (persistTimer.current) clearTimeout(persistTimer.current); };
  }, [tiles, update]);

  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const addTile = useCallback((url: string, name?: string, embedAllowed?: boolean): string | null => {
    const classified = classifyStreamUrl(url, { parentHost: window.location.hostname });
    if (!classified) return 'Invalid URL — must be http(s)';
    if (tilesRef.current.length >= MAX_TILES) return `Tile limit reached (${MAX_TILES})`;
    const cascade = (tilesRef.current.length * 28) % 224;
    const tile: StreamTileState = {
      id: crypto.randomUUID(),
      url,
      name: name || classified.suggestedName,
      kind: classified.kind,
      x: 96 + cascade,
      y: 96 + cascade,
      w: 420,
      h: 270,
      z: zCounter.current++,
      embedBlocked: embedAllowed === false || undefined,
    };
    setTiles((prev) => [...prev, tile]);
    return null;
  }, []);

  // ── External add requests (map news-dot clicks, plugins) ──
  const lastAddTs = useRef(0);
  useEffect(() => {
    if (!addRequest || addRequest.ts === lastAddTs.current) return;
    lastAddTs.current = addRequest.ts;
    addTile(addRequest.url, addRequest.name, addRequest.embedAllowed);
  }, [addRequest, addTile]);

  // ── Presets (quick-add from /api/live-news; lazy-fetched on first open) ──
  useEffect(() => {
    if (!showPresets || presets !== null) return;
    let cancelled = false;
    fetch('/api/live-news')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPresets(Array.isArray(d?.feeds) ? d.feeds : []); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [showPresets, presets]);

  const handleUpdate = useCallback((id: string, patch: Partial<StreamTileState>) => {
    setTiles((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);
  const handleRemove = useCallback((id: string) => {
    setTiles((prev) => prev.filter((t) => t.id !== id));
    setAudioFocusId((f) => (f === id ? null : f));
  }, []);
  const handleBringToFront = useCallback((id: string) => {
    setTiles((prev) => {
      const top = Math.max(...prev.map((t) => t.z), 0);
      const target = prev.find((t) => t.id === id);
      if (!target || target.z === top) return prev;
      zCounter.current = top + 2;
      return prev.map((t) => (t.id === id ? { ...t, z: top + 1 } : t));
    });
  }, []);

  const submitUrl = useCallback(() => {
    const url = urlInput.trim();
    if (!url) return;
    const err = addTile(url);
    setInputError(err);
    if (!err) setUrlInput('');
  }, [urlInput, addTile]);

  if (!open) return null;

  return (
    <div ref={wallRef} className="fixed inset-0 z-[400] pointer-events-none overflow-hidden">
      {/* ── Add bar ── */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col items-center gap-1">
        <div className="flex items-center gap-1.5 bg-black/85 backdrop-blur-xl border border-[var(--border-primary)] px-2 py-1.5">
          <Tv className="w-3.5 h-3.5 text-[var(--gold-primary)] shrink-0" />
          <span className="text-[9px] font-mono font-bold tracking-[0.2em] text-[var(--gold-primary)] mr-1">STREAM WALL</span>
          <input
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setInputError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
            placeholder="Paste stream URL (YouTube / Twitch / .m3u8 / any)"
            className="w-72 bg-black/60 border border-white/10 px-2 py-1 text-[10px] font-mono text-white placeholder:text-white/30 focus:border-[var(--gold-primary)]/50 focus:outline-none"
          />
          <button
            onClick={submitUrl}
            className="flex items-center gap-1 px-2 py-1 border border-[var(--gold-primary)]/40 text-[var(--gold-primary)] font-mono text-[9px] font-bold hover:bg-[var(--gold-primary)]/10 transition-colors tracking-wider"
          >
            <Plus className="w-3 h-3" /> ADD
          </button>
          <div className="relative">
            <button
              onClick={() => setShowPresets((s) => !s)}
              className={`flex items-center gap-1 px-2 py-1 border font-mono text-[9px] font-bold transition-colors tracking-wider ${showPresets ? 'border-[var(--cyan-primary)]/60 text-[var(--cyan-primary)] bg-[var(--cyan-primary)]/10' : 'border-white/20 text-white/60 hover:text-white'}`}
            >
              PRESETS <ChevronDown className="w-3 h-3" />
            </button>
            <AnimatePresence>
              {showPresets && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full mt-1 w-64 max-h-72 overflow-y-auto bg-black/95 backdrop-blur-xl border border-[var(--border-primary)] z-10"
                >
                  {presets === null && <div className="px-3 py-2 text-[9px] font-mono text-white/40">LOADING…</div>}
                  {presets?.length === 0 && <div className="px-3 py-2 text-[9px] font-mono text-white/40">NO PRESETS AVAILABLE</div>}
                  {presets?.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => { setInputError(addTile(f.url, f.name, f.embed_allowed)); setShowPresets(false); }}
                      className="w-full text-left px-3 py-1.5 hover:bg-white/5 transition-colors flex items-center justify-between gap-2"
                    >
                      <span className="text-[10px] font-mono text-white truncate">{f.name}</span>
                      <span className="text-[8px] font-mono text-white/40 shrink-0">
                        {f.embed_allowed === false ? 'EXT' : (f.country || '')}
                      </span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button onClick={onClose} className="p-1 text-white/50 hover:text-white transition-colors" title="Close Stream Wall">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {inputError && <div className="text-[9px] font-mono text-[#FF3D3D] bg-black/80 px-2 py-0.5">{inputError}</div>}
        {tiles.length === 0 && (
          <div className="text-[9px] font-mono text-white/40 bg-black/70 px-2 py-0.5 tracking-wider">
            PASTE A URL OR PICK A PRESET — TILES ARE DRAGGABLE + RESIZABLE
          </div>
        )}
      </div>

      {/* ── Tiles ── */}
      <AnimatePresence>
        {tiles.map((tile) => (
          <StreamTile
            key={tile.id}
            tile={tile}
            focused={audioFocusId === tile.id}
            interacting={interacting}
            embedBlocked={tile.embedBlocked}
            constraintsRef={wallRef}
            onFocusAudio={setAudioFocusId}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
            onBringToFront={handleBringToFront}
            onInteractingChange={setInteracting}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
