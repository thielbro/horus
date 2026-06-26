'use client';

// HORUS — live location tracker. Opt-in GPS via navigator.geolocation.watchPosition.
//
// Privacy: never auto-prompts; the user explicitly enables it. The position stays on the
// device — only lat/lng leave the client, and only when the user runs "intel on my location"
// (which compiles an address dossier for the current spot). Follow-me re-centres the map.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LocateFixed, Navigation, Crosshair, X, Loader2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { haversineMeters } from '@/lib/geo';

interface Pos { lat: number; lng: number; accuracy?: number; heading?: number | null; ts: number; }

interface Props {
  onUpdate: (pos: { lat: number; lng: number; accuracy?: number }) => void;
  onClear: () => void;
  onIntel: (lat: number, lng: number) => void;
  onFollow: (lat: number, lng: number) => void;
}

type Status = 'idle' | 'locating' | 'active' | 'denied' | 'unavailable' | 'error';

const FOLLOW_MIN_MOVE_M = 15;     // re-centre only after meaningful movement
const GEOCODE_MIN_MOVE_M = 40;    // re-label only after meaningful movement
const GEOCODE_MIN_INTERVAL_MS = 8_000;
const NOMINATIM_MIN_INTERVAL_MS = 1_100;

function LocationTracker({ onUpdate, onClear, onIntel, onFollow }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [pos, setPos] = useState<Pos | null>(null);
  const [followMe, setFollowMe] = useState(true);
  const [address, setAddress] = useState<string | null>(null);

  const watchId = useRef<number | null>(null);
  const followRef = useRef(true);
  const lastFollow = useRef<{ lat: number; lng: number } | null>(null);
  const lastGeocode = useRef<{ lat: number; lng: number; at: number } | null>(null);
  const geocodeAbort = useRef<AbortController | null>(null);

  useEffect(() => { followRef.current = followMe; }, [followMe]);

  const reverseGeocode = useCallback(async (lat: number, lng: number) => {
    const last = lastGeocode.current;
    const now = Date.now();
    if (last && now - last.at < NOMINATIM_MIN_INTERVAL_MS) return;
    if (last && now - last.at < GEOCODE_MIN_INTERVAL_MS && haversineMeters(last.lat, last.lng, lat, lng) < GEOCODE_MIN_MOVE_M) return;
    lastGeocode.current = { lat, lng, at: now };
    geocodeAbort.current?.abort();
    const controller = new AbortController();
    geocodeAbort.current = controller;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=16&addressdetails=1`, {
        headers: { 'Accept-Language': 'en' }, signal: controller.signal,
      });
      if (!res.ok) return;
      const d = await res.json();
      const a = d.address || {};
      const label = [a.road || a.neighbourhood, a.suburb || a.city || a.town || a.village, a.postcode].filter(Boolean).join(', ');
      if (!controller.signal.aborted) setAddress(label || d.display_name || null);
    } catch { /* keep prior label */ }
    finally {
      if (geocodeAbort.current === controller) geocodeAbort.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (watchId.current != null && typeof navigator !== 'undefined') navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    geocodeAbort.current?.abort();
    geocodeAbort.current = null;
    lastFollow.current = null;
    lastGeocode.current = null;
    setEnabled(false);
    setStatus('idle');
    setPos(null);
    setAddress(null);
    onClear();
  }, [onClear]);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setStatus('unavailable'); return; }
    setEnabled(true);
    setStatus('locating');
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        const next: Pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, ts: p.timestamp };
        setPos(next);
        setStatus('active');
        onUpdate({ lat: next.lat, lng: next.lng, accuracy: next.accuracy });
        if (followRef.current) {
          const lf = lastFollow.current;
          if (!lf || haversineMeters(lf.lat, lf.lng, next.lat, next.lng) >= FOLLOW_MIN_MOVE_M) {
            lastFollow.current = { lat: next.lat, lng: next.lng };
            onFollow(next.lat, next.lng);
          }
        }
        reverseGeocode(next.lat, next.lng);
      },
      (err) => { setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'); },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  }, [onUpdate, onFollow, reverseGeocode]);

  // Clean up the watch on unmount.
  useEffect(() => () => {
    if (watchId.current != null && typeof navigator !== 'undefined') navigator.geolocation.clearWatch(watchId.current);
    geocodeAbort.current?.abort();
    geocodeAbort.current = null;
  }, []);

  const toggleFollow = () => {
    const nextFollow = !followMe;
    setFollowMe(nextFollow);
    if (nextFollow && pos) { lastFollow.current = { lat: pos.lat, lng: pos.lng }; onFollow(pos.lat, pos.lng); }
  };

  return (
    <div className="fixed left-3 bottom-24 z-[300] pointer-events-auto md:bottom-20">
      {!enabled ? (
        <button
          onClick={start}
          className="glass-panel-sm flex items-center gap-1.5 px-3 py-2 text-[9px] font-mono tracking-[0.15em] text-[var(--text-muted)] hover:text-[var(--cyan-primary)] hover:border-[var(--border-active)] transition-all"
          title="Track my live location"
        >
          <LocateFixed className="w-3.5 h-3.5" /> LOCATE ME
        </button>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="glass-panel w-[240px] p-3 border border-[var(--cyan-primary)]/30"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              {status === 'active'
                ? <span className="w-1.5 h-1.5 rounded-full bg-[var(--cyan-primary)] animate-horus-pulse" />
                : <Loader2 className="w-3 h-3 text-[var(--cyan-primary)] animate-spin" />}
              <span className="text-[10px] font-mono font-bold tracking-widest text-[var(--cyan-primary)]">
                {status === 'active' ? 'LIVE POSITION' : status === 'locating' ? 'LOCATING…' : status.toUpperCase()}
              </span>
            </div>
            <button onClick={stop} className="p-0.5 text-white/40 hover:text-[var(--alert-red)]" title="Stop tracking"><X className="w-3.5 h-3.5" /></button>
          </div>

          {(status === 'denied' || status === 'unavailable' || status === 'error') && (
            <div className="text-[9px] font-mono text-[var(--alert-red)] flex items-start gap-1.5 mb-2">
              <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
              <span>{status === 'denied' ? 'Location permission denied. Enable it in your browser/OS settings.' : status === 'unavailable' ? 'Geolocation is not available on this device.' : 'Could not get a location fix.'}</span>
            </div>
          )}

          {pos && (
            <>
              <div className="text-[10px] font-mono text-white/80 tabular-nums">{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</div>
              {pos.accuracy != null && <div className="text-[9px] font-mono text-white/40">±{Math.round(pos.accuracy)} m{address ? ` · ${address}` : ''}</div>}

              <div className="flex items-center justify-between mt-2.5 mb-2">
                <span className="text-[9px] font-mono tracking-wider text-white/50">FOLLOW ME</span>
                <button
                  onClick={toggleFollow}
                  className="relative w-9 h-5 rounded-full transition-colors border flex items-center px-0.5"
                  style={{ backgroundColor: followMe ? 'rgba(0,229,255,0.15)' : 'rgba(0,0,0,0.4)', borderColor: followMe ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.1)' }}
                >
                  <motion.div className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: followMe ? '#00E5FF' : 'rgba(255,255,255,0.4)' }} animate={{ x: followMe ? 16 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} />
                </button>
              </div>

              <button
                onClick={() => onIntel(pos.lat, pos.lng)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-[var(--gold-primary)]/30 text-[10px] font-mono tracking-wider text-[var(--gold-primary)] hover:bg-[var(--gold-primary)]/10 transition-colors"
              >
                <Crosshair className="w-3.5 h-3.5" /> INTEL ON MY LOCATION
              </button>
            </>
          )}

          <div className="flex items-start gap-1.5 mt-2.5 text-[8px] font-mono text-white/30 leading-relaxed">
            <ShieldCheck className="w-3 h-3 mt-px shrink-0 text-[var(--cyan-primary)]/50" />
            <span>Position stays on your device. Coordinates are only sent when you run intel.</span>
          </div>
        </motion.div>
      )}
    </div>
  );
}

export default memo(LocationTracker);
