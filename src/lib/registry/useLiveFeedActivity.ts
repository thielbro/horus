'use client';

import { useEffect, useRef } from 'react';
import type { DataBuckets } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type Bounds = [number, number, number, number]; // [south, west, north, east]

const HEARTBEAT_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 600_000;
const FIRST_SAMPLE_READ_POLL_MS = 10_000;
const FIRST_SAMPLE_READ_STOP_MS = 50_000;

function viewportPayload(bounds?: Bounds) {
  if (!bounds) return null;
  const [south, west, north, east] = bounds;
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return { south, west, north, east };
}

function postActivity(active: boolean, viewport: ReturnType<typeof viewportPayload>) {
  return fetch('/api/live-feed/activity', {
    method: 'POST',
    cache: 'no-store',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feed: 'maritime', active, viewport }),
  }).catch((err) => {
    console.warn('[HORUS] Live feed activity signal failed', err instanceof Error ? err.message : err);
  });
}

const maritimeTransform = (d: any) => ({
  maritime_ports: Array.isArray(d?.ports) ? d.ports : [],
  maritime_chokepoints: Array.isArray(d?.chokepoints) ? d.chokepoints : [],
  maritime_ships: Array.isArray(d?.ships) ? d.ships : [],
});

export function useLiveFeedActivity(
  activeLayers: Record<string, boolean>,
  mapView: { bounds?: Bounds },
  fetchEndpoint: FetchEndpoint,
): void {
  const viewportRef = useRef<ReturnType<typeof viewportPayload>>(null);

  useEffect(() => {
    viewportRef.current = viewportPayload(mapView.bounds);
  }, [mapView.bounds]);

  useEffect(() => {
    const wantsContext = !!activeLayers.maritime || !!activeLayers.maritime_ships;
    const wantsLiveShips = !!activeLayers.maritime_ships;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let snapshotPoll: ReturnType<typeof setInterval> | null = null;
    let sampleReadPoll: ReturnType<typeof setInterval> | null = null;
    let sampleReadStop: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (snapshotPoll) clearInterval(snapshotPoll);
      if (sampleReadPoll) clearInterval(sampleReadPoll);
      if (sampleReadStop) clearTimeout(sampleReadStop);
      heartbeat = null;
      snapshotPoll = null;
      sampleReadPoll = null;
      sampleReadStop = null;
    };

    const fetchSnapshot = () => {
      fetchEndpoint('/api/maritime', maritimeTransform);
    };

    const activate = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchSnapshot();
      if (wantsLiveShips) {
        void postActivity(true, viewportRef.current);
        heartbeat = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) void postActivity(true, viewportRef.current);
        }, HEARTBEAT_MS);
        sampleReadPoll = setInterval(fetchSnapshot, FIRST_SAMPLE_READ_POLL_MS);
        sampleReadStop = setTimeout(() => {
          if (sampleReadPoll) clearInterval(sampleReadPoll);
          sampleReadPoll = null;
          fetchSnapshot();
        }, FIRST_SAMPLE_READ_STOP_MS);
        snapshotPoll = setInterval(fetchSnapshot, SNAPSHOT_INTERVAL_MS);
      }
    };

    const deactivate = () => {
      clearTimers();
      if (wantsLiveShips) void postActivity(false, viewportRef.current);
    };

    const onVisibilityChange = () => {
      if (!wantsContext) return;
      if (document.hidden) {
        deactivate();
      } else {
        clearTimers();
        activate();
      }
    };

    if (wantsContext) activate();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      if (wantsContext) deactivate();
      else clearTimers();
    };
  }, [activeLayers.maritime, activeLayers.maritime_ships, fetchEndpoint]);
}
