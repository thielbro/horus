'use client';

// HORUS — Stream Wall tile. One draggable/resizable floating video tile.
//
// Drag starts only from the header bar (dragListener={false} + useDragControls) —
// iframes swallow pointer events, so the drag surface must be tile chrome. While
// ANY tile is being dragged/resized the wall sets `interacting`, which turns off
// pointer events on every tile's media element so mid-drag pointermoves survive
// crossing another tile's iframe.

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, useDragControls, useMotionValue } from 'framer-motion';
import { X, ExternalLink, Volume2, VolumeX, GripHorizontal } from 'lucide-react';
import Hls from 'hls.js';
import type { RefObject } from 'react';
import type { StreamTileState } from '@/lib/settings';
import { classifyStreamUrl, getYouTubeWatchUrl } from '@/lib/streams';

const MIN_W = 280;
const MIN_H = 180;

interface StreamTileProps {
  tile: StreamTileState;
  /** This tile holds the wall's single audio focus (unmuted). */
  focused: boolean;
  /** Some tile (any) is mid-drag/resize — media must not eat pointer events. */
  interacting: boolean;
  /** YouTube channels that block embedding render an external-only card. */
  embedBlocked?: boolean;
  constraintsRef: RefObject<HTMLDivElement | null>;
  onFocusAudio: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<StreamTileState>) => void;
  onRemove: (id: string) => void;
  onBringToFront: (id: string) => void;
  onInteractingChange: (v: boolean) => void;
}

export default function StreamTile({
  tile, focused, interacting, embedBlocked, constraintsRef,
  onFocusAudio, onUpdate, onRemove, onBringToFront, onInteractingChange,
}: StreamTileProps) {
  const dragControls = useDragControls();
  const x = useMotionValue(tile.x);
  const y = useMotionValue(tile.y);
  const [size, setSize] = useState({ w: tile.w, h: tile.h });
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [streamError, setStreamError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Re-derive playback info from the persisted URL (parent host is runtime-only).
  const classified = classifyStreamUrl(tile.url, {
    parentHost: typeof window !== 'undefined' ? window.location.hostname : 'localhost',
  });
  const kind = classified?.kind ?? tile.kind;
  const embedUrl = classified?.embedUrl ?? tile.url;
  const watchUrl = classified?.watchUrl ?? tile.url;

  // ── HLS lifecycle (pattern from CameraViewer) ──
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (kind !== 'hls') return;
    const video = videoRef.current;
    setStreamError(false);
    destroyHls();

    let onLoadedMetadata: (() => void) | null = null;
    if (Hls.isSupported() && video) {
      const hls = new Hls({ enableWorker: false });
      hlsRef.current = hls;
      hls.loadSource(embedUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, errData) => {
        if (errData.fatal) {
          destroyHls();
          setStreamError(true);
        }
      });
    } else if (video?.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = embedUrl;
      onLoadedMetadata = () => { video.play().catch(() => {}); };
      video.addEventListener('loadedmetadata', onLoadedMetadata);
    }
    return () => {
      destroyHls();
      if (video) {
        if (onLoadedMetadata) video.removeEventListener('loadedmetadata', onLoadedMetadata);
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      }
    };
  }, [kind, embedUrl, retryKey, destroyHls]);

  // ── Audio focus ──
  useEffect(() => {
    if (kind === 'hls' || kind === 'file') {
      if (videoRef.current) videoRef.current.muted = !focused;
      return;
    }
    if (kind === 'youtube') {
      // enablejsapi=1 lets us toggle audio without remounting the stream.
      const win = iframeRef.current?.contentWindow;
      win?.postMessage(JSON.stringify({ event: 'command', func: focused ? 'unMute' : 'mute', args: '' }), '*');
    }
    // Twitch: handled by keying the iframe src on `focused` below (embed JS API
    // is a separate script — not worth it for v1).
  }, [focused, kind]);

  const twitchSrc = kind === 'twitch' ? embedUrl.replace('muted=true', `muted=${!focused}`) : embedUrl;

  // ── Resize (framer-motion has no resize — manual corner handle) ──
  const resizeStart = useRef<{ px: number; py: number; w: number; h: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeStart.current = { px: e.clientX, py: e.clientY, w: sizeRef.current.w, h: sizeRef.current.h };
    onInteractingChange(true);
  }, [onInteractingChange]);
  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    const maxW = typeof window !== 'undefined' ? window.innerWidth - 40 : 1600;
    const maxH = typeof window !== 'undefined' ? window.innerHeight - 40 : 900;
    setSize({
      w: Math.min(maxW, Math.max(MIN_W, start.w + (e.clientX - start.px))),
      h: Math.min(maxH, Math.max(MIN_H, start.h + (e.clientY - start.py))),
    });
  }, []);
  const onResizePointerUp = useCallback(() => {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    onInteractingChange(false);
    onUpdate(tile.id, { w: sizeRef.current.w, h: sizeRef.current.h });
  }, [onInteractingChange, onUpdate, tile.id]);

  const mediaClass = `absolute inset-0 w-full h-full ${interacting ? 'pointer-events-none' : ''}`;

  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={constraintsRef}
      onDragStart={() => onInteractingChange(true)}
      onDragEnd={() => {
        onInteractingChange(false);
        onUpdate(tile.id, { x: x.get(), y: y.get() });
      }}
      onPointerDownCapture={() => onBringToFront(tile.id)}
      style={{ x, y, width: size.w, height: size.h, zIndex: tile.z }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ duration: 0.2 }}
      className="absolute pointer-events-auto flex flex-col overflow-hidden bg-black/90 backdrop-blur-xl border border-[var(--border-primary)]"
      data-stream-tile={tile.id}
    >
      {/* Header — the drag surface */}
      <div
        onPointerDown={(e) => { e.preventDefault(); dragControls.start(e); }}
        className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-[var(--border-primary)] bg-black/70 cursor-grab active:cursor-grabbing select-none touch-none shrink-0"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <GripHorizontal className="w-3 h-3 text-white/30 shrink-0" />
          <div className="w-1.5 h-1.5 rounded-full bg-[#FF4081] animate-horus-pulse shrink-0" />
          <span className="text-[10px] font-mono font-bold text-white tracking-wider truncate">{tile.name}</span>
          {focused && <span className="px-1 py-px rounded bg-[var(--gold-primary)]/20 text-[var(--gold-primary)] font-mono text-[7px] font-bold shrink-0">AUDIO</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0" onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => onFocusAudio(focused ? null : tile.id)}
            className={`p-1 transition-colors ${focused ? 'text-[var(--gold-primary)]' : 'text-white/50 hover:text-white'}`}
            title={focused ? 'Mute' : 'Focus audio (mutes other tiles)'}
          >
            {focused ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
          </button>
          <a
            href={kind === 'youtube' ? getYouTubeWatchUrl(watchUrl) : watchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-white/50 hover:text-white transition-colors"
            title="Open externally"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
          <button onClick={() => onRemove(tile.id)} className="p-1 text-white/50 hover:text-[#FF3D3D] transition-colors" title="Remove">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Media */}
      <div className="relative flex-1 bg-black">
        {embedBlocked ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center px-4">
              <p className="text-[11px] font-mono font-bold text-white tracking-widest mb-1.5">EMBED RESTRICTED</p>
              <p className="text-[9px] font-mono text-white/50 mb-3">{tile.name} does not allow third-party embedding.</p>
              <a
                href={kind === 'youtube' ? getYouTubeWatchUrl(watchUrl) : watchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#39FF14]/40 text-[#39FF14] font-mono text-[10px] hover:bg-[#39FF14]/10 transition-colors tracking-wider"
              >
                <ExternalLink className="w-3 h-3" />
                OPEN LIVE STREAM
              </a>
            </div>
          </div>
        ) : kind === 'hls' ? (
          streamError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <p className="text-[10px] font-mono text-[#FF3D3D] tracking-widest">STREAM ERROR</p>
              <button
                onClick={() => setRetryKey((k) => k + 1)}
                className="px-3 py-1 border border-white/20 text-white/70 font-mono text-[9px] hover:bg-white/10 transition-colors tracking-wider"
              >
                RETRY
              </button>
            </div>
          ) : (
            <video ref={videoRef} muted autoPlay playsInline className={`${mediaClass} object-cover`} />
          )
        ) : kind === 'file' ? (
          <video ref={videoRef} src={embedUrl} muted autoPlay playsInline loop controls className={`${mediaClass} object-cover`} />
        ) : (
          <iframe
            ref={iframeRef}
            src={kind === 'twitch' ? twitchSrc : embedUrl}
            className={mediaClass}
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        )}
        {/* Invisible capture overlay while any tile is mid-drag/resize */}
        {interacting && <div className="absolute inset-0" />}
      </div>

      {/* Resize handle */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        className="absolute bottom-0 right-0 w-[14px] h-[14px] cursor-se-resize touch-none z-10"
        title="Resize"
      >
        <div className="absolute bottom-[3px] right-[3px] w-2 h-2 border-r-2 border-b-2 border-[var(--gold-primary)]/60" />
      </div>
    </motion.div>
  );
}
