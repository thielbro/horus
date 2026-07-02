'use client';

import { useEffect, useRef } from 'react';
import type { DataBuckets } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type Bounds = [number, number, number, number]; // [south, west, north, east]

const HEARTBEAT_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 600_000;
const FIRST_SAMPLE_READ_MS = 50_000;

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
    const isActive = !!activeLayers.maritime;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let snapshotPoll: ReturnType<typeof setInterval> | null = null;
    let firstSampleRead: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (snapshotPoll) clearInterval(snapshotPoll);
      if (firstSampleRead) clearTimeout(firstSampleRead);
      heartbeat = null;
      snapshotPoll = null;
      firstSampleRead = null;
    };

    const fetchSnapshot = () => {
      fetchEndpoint('/api/maritime', maritimeTransform);
    };

    const activate = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void postActivity(true, viewportRef.current);
      fetchSnapshot();
      heartbeat = setInterval(() => {
        if (typeof document === 'undefined' || !document.hidden) void postActivity(true, viewportRef.current);
      }, HEARTBEAT_MS);
      firstSampleRead = setTimeout(fetchSnapshot, FIRST_SAMPLE_READ_MS);
      snapshotPoll = setInterval(fetchSnapshot, SNAPSHOT_INTERVAL_MS);
    };

    const deactivate = () => {
      clearTimers();
      void postActivity(false, viewportRef.current);
    };

    const onVisibilityChange = () => {
      if (!isActive) return;
      if (document.hidden) {
        deactivate();
      } else {
        clearTimers();
        activate();
      }
    };

    if (isActive) activate();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      if (isActive) deactivate();
      else clearTimers();
    };
  }, [activeLayers.maritime, fetchEndpoint]);
}
