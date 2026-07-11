'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Plane, Radar, Ship, Trash2, X } from 'lucide-react';
import {
  detectionLabel,
  findTrackedEntity,
  normalizeTrackingIdentifier,
  trackedEntityId,
  type TrackedDetection,
  type TrackedEntity,
  type TrackedEntityKind,
} from '@/lib/entity-tracking';

const STORAGE_KEY = 'horus.entity-watchlist.v1';

export interface EntityTrackerController {
  watches: TrackedEntity[];
  detections: Record<string, TrackedDetection>;
  addWatch: (kind: TrackedEntityKind, identifier: string, label?: string) => boolean;
  removeWatch: (id: string) => void;
  requestNotifications: () => Promise<NotificationPermission | 'unsupported'>;
  notificationPermission: NotificationPermission | 'unsupported';
}

function loadWatches(): TrackedEntity[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TrackedEntity =>
      (item?.kind === 'aircraft' || item?.kind === 'vessel') &&
      typeof item.identifier === 'string' && typeof item.id === 'string'
    ).slice(0, 100);
  } catch {
    return [];
  }
}

export function useEntityTracker(data: Record<string, any>): EntityTrackerController {
  const [watches, setWatches] = useState<TrackedEntity[]>([]);
  const [detections, setDetections] = useState<Record<string, TrackedDetection>>({});
  const [storageReady, setStorageReady] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const previouslySeen = useRef(new Set<string>());
  const hydrated = useRef(false);

  useEffect(() => {
    setWatches(loadWatches());
    setNotificationPermission('Notification' in window ? Notification.permission : 'unsupported');
    hydrated.current = true;
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(watches));
  }, [storageReady, watches]);

  useEffect(() => {
    if (!hydrated.current || watches.length === 0) {
      previouslySeen.current.clear();
      setDetections({});
      return;
    }

    const seenNow = new Set<string>();
    const nextDetections: Record<string, TrackedDetection> = {};
    for (const watch of watches) {
      const entity = findTrackedEntity(watch, data);
      if (!entity) continue;
      seenNow.add(watch.id);
      const detection: TrackedDetection = { watch, entity, detectedAt: Date.now() };
      nextDetections[watch.id] = detection;
      if (!previouslySeen.current.has(watch.id) && 'Notification' in window && Notification.permission === 'granted') {
        const name = detectionLabel(detection);
        const position = Number.isFinite(entity.lat) && Number.isFinite(entity.lng)
          ? ` at ${Number(entity.lat).toFixed(3)}, ${Number(entity.lng).toFixed(3)}` : '';
        new Notification(`HORUS detected ${name}`, {
          body: `${watch.kind === 'aircraft' ? 'Aircraft' : 'Vessel'} ${watch.identifier}${position}`,
          icon: '/horus-icon.png',
          tag: `horus-track-${watch.id}`,
        });
      }
    }
    previouslySeen.current = seenNow;
    setDetections(nextDetections);
  }, [data, watches]);

  const addWatch = useCallback((kind: TrackedEntityKind, rawIdentifier: string, rawLabel?: string) => {
    const identifier = normalizeTrackingIdentifier(rawIdentifier);
    if (!identifier) return false;
    const id = trackedEntityId(kind, identifier);
    setWatches((current) => current.some((watch) => watch.id === id) ? current : [
      ...current,
      { id, kind, identifier, label: rawLabel?.trim() || identifier, createdAt: Date.now() },
    ]);
    return true;
  }, []);

  const removeWatch = useCallback((id: string) => {
    previouslySeen.current.delete(id);
    setWatches((current) => current.filter((watch) => watch.id !== id));
    setDetections((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const requestNotifications = useCallback(async () => {
    if (!('Notification' in window)) return 'unsupported' as const;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    return permission;
  }, []);

  return { watches, detections, addWatch, removeWatch, requestNotifications, notificationPermission };
}

export function TrackingPanel({ tracker, onLocate }: { tracker: EntityTrackerController; onLocate: (lat: number, lng: number) => void }) {
  const [kind, setKind] = useState<TrackedEntityKind>('aircraft');
  const [identifier, setIdentifier] = useState('');

  const submit = () => {
    if (tracker.addWatch(kind, identifier)) setIdentifier('');
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[#2A2A28] bg-[#111111]/70 p-3">
        <div className="mb-2 flex gap-1">
          {(['aircraft', 'vessel'] as const).map((value) => (
            <button key={value} onClick={() => setKind(value)} className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[9px] font-mono uppercase ${kind === value ? 'border border-[var(--cyan-primary)]/50 bg-[var(--cyan-primary)]/15 text-[var(--cyan-primary)]' : 'text-[#8A8880]'}`}>
              {value === 'aircraft' ? <Plane className="h-3 w-3" /> : <Ship className="h-3 w-3" />}{value}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} placeholder={kind === 'aircraft' ? 'ICAO24, registration or callsign' : 'MMSI, IMO, callsign or name'} className="min-w-0 flex-1 rounded border border-[#343432] bg-black/50 px-2 py-1.5 text-[10px] font-mono text-white outline-none focus:border-[var(--cyan-primary)]" />
          <button onClick={submit} disabled={!identifier.trim()} className="rounded border border-[var(--cyan-primary)]/50 bg-[var(--cyan-primary)]/15 px-3 text-[9px] font-mono text-[var(--cyan-primary)] disabled:opacity-40">TRACK</button>
        </div>
        <p className="mt-2 text-[8px] font-mono leading-relaxed text-[#6F6D67]">Aircraft coverage follows the live flight feed. Vessel detections follow the active AIS map area.</p>
        {tracker.notificationPermission !== 'granted' && tracker.notificationPermission !== 'unsupported' && (
          <button onClick={() => void tracker.requestNotifications()} className="mt-2 text-[9px] font-mono text-[#FFD700] underline decoration-dotted">Enable system notifications</button>
        )}
      </div>

      {tracker.watches.length === 0 ? (
        <div className="py-8 text-center text-[9px] font-mono text-[#6F6D67]">NO TRACKED ENTITIES</div>
      ) : tracker.watches.map((watch) => {
        const detection = tracker.detections[watch.id];
        const entity = detection?.entity;
        const locatable = Number.isFinite(entity?.lat) && Number.isFinite(entity?.lng);
        return (
          <div key={watch.id} className={`rounded-lg border p-2.5 ${detection ? 'border-[#00E676]/40 bg-[#00E676]/5' : 'border-[#2A2A28] bg-[#111111]/60'}`}>
            <div className="flex items-center gap-2">
              {watch.kind === 'aircraft' ? <Plane className="h-3.5 w-3.5 text-[var(--cyan-primary)]" /> : <Ship className="h-3.5 w-3.5 text-[#26C6DA]" />}
              <div className="min-w-0 flex-1"><div className="truncate text-[10px] font-mono text-[#E8E6E0]">{detection ? detectionLabel(detection) : watch.label}</div><div className="text-[8px] font-mono text-[#6F6D67]">{watch.identifier} · {detection ? 'DETECTED' : 'SCANNING'}</div></div>
              {detection && <Radar className="h-3.5 w-3.5 animate-pulse text-[#00E676]" />}
              {locatable && <button onClick={() => onLocate(entity.lat, entity.lng)} title="Locate"><Crosshair className="h-3.5 w-3.5 text-[#8A8880] hover:text-white" /></button>}
              <button onClick={() => tracker.removeWatch(watch.id)} title="Stop tracking"><Trash2 className="h-3.5 w-3.5 text-[#8A8880] hover:text-[#FF3D3D]" /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TrackingToasts({ tracker, onLocate }: { tracker: EntityTrackerController; onLocate: (lat: number, lng: number) => void }) {
  const [dismissed, setDismissed] = useState(new Set<string>());
  useEffect(() => {
    const detectedIds = new Set(Object.keys(tracker.detections));
    setDismissed((current) => {
      if ([...current].every((id) => detectedIds.has(id))) return current;
      return new Set([...current].filter((id) => detectedIds.has(id)));
    });
  }, [tracker.detections]);
  const visible = Object.values(tracker.detections).filter((detection) => !dismissed.has(detection.watch.id));
  if (visible.length === 0) return null;
  return <div className="pointer-events-none fixed right-4 top-4 z-[10000] flex w-80 flex-col gap-2">{visible.slice(0, 3).map((detection) => {
    const entity = detection.entity;
    const locatable = Number.isFinite(entity.lat) && Number.isFinite(entity.lng);
    return <div key={detection.watch.id} className="pointer-events-auto rounded-lg border border-[#00E676]/50 bg-[#07110b]/95 p-3 shadow-2xl backdrop-blur-xl">
      <div className="flex items-start gap-2"><Radar className="mt-0.5 h-4 w-4 animate-pulse text-[#00E676]" /><div className="min-w-0 flex-1"><div className="text-[9px] font-mono font-bold tracking-widest text-[#00E676]">TRACKED {detection.watch.kind.toUpperCase()} DETECTED</div><div className="mt-1 truncate text-xs font-mono text-white">{detectionLabel(detection)}</div><div className="text-[9px] font-mono text-[#8A8880]">{detection.watch.identifier}</div>{locatable && <button onClick={() => onLocate(entity.lat, entity.lng)} className="mt-2 text-[9px] font-mono text-[var(--cyan-primary)]">LOCATE ON MAP →</button>}</div><button onClick={() => setDismissed((current) => new Set(current).add(detection.watch.id))}><X className="h-3.5 w-3.5 text-[#8A8880]" /></button></div>
    </div>;
  })}</div>;
}
