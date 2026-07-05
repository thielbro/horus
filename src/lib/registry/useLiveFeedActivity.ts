'use client';

import { useEffect, useRef } from 'react';
import type { DataBuckets } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type Bounds = [number, number, number, number]; // [south, west, north, east]

const HEARTBEAT_MS = 60_000;
// The sidecar streams continuously while leased, so the renderer polls the
// snapshot on a short cadence instead of waiting on discrete sample windows.
const SNAPSHOT_POLL_MS = 15_000;
// Debounce for viewport-change reactions (re-subscribe + refetch) while panning.
const VIEWPORT_SETTLE_MS = 2_000;

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

function snapshotUrl(viewport: ReturnType<typeof viewportPayload>) {
  if (!viewport) return '/api/maritime';
  const params = new URLSearchParams({
    south: String(viewport.south),
    west: String(viewport.west),
    north: String(viewport.north),
    east: String(viewport.east),
  });
  return `/api/maritime?${params}`;
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
  const liveShipsActiveRef = useRef(false);
  const viewportSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchRef = useRef(fetchEndpoint);
  fetchRef.current = fetchEndpoint;

  useEffect(() => {
    viewportRef.current = viewportPayload(mapView.bounds);
    if (!liveShipsActiveRef.current) return;
    // Viewport moved while live ships are on: re-target the AIS subscription and
    // refresh the vessel list once panning settles.
    if (viewportSettle.current) clearTimeout(viewportSettle.current);
    viewportSettle.current = setTimeout(() => {
      viewportSettle.current = null;
      if (!liveShipsActiveRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      void postActivity(true, viewportRef.current);
      fetchRef.current(snapshotUrl(viewportRef.current), maritimeTransform);
    }, VIEWPORT_SETTLE_MS);
  }, [mapView.bounds]);

  useEffect(() => {
    const wantsContext = !!activeLayers.maritime || !!activeLayers.maritime_ships;
    const wantsLiveShips = !!activeLayers.maritime_ships;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let snapshotPoll: ReturnType<typeof setInterval> | null = null;

    const clearTimers = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (snapshotPoll) clearInterval(snapshotPoll);
      heartbeat = null;
      snapshotPoll = null;
    };

    const fetchSnapshot = () => {
      fetchRef.current(snapshotUrl(wantsLiveShips ? viewportRef.current : null), maritimeTransform);
    };

    const activate = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchSnapshot();
      if (wantsLiveShips) {
        liveShipsActiveRef.current = true;
        void postActivity(true, viewportRef.current);
        heartbeat = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) void postActivity(true, viewportRef.current);
        }, HEARTBEAT_MS);
        snapshotPoll = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) fetchSnapshot();
        }, SNAPSHOT_POLL_MS);
      }
    };

    const deactivate = () => {
      clearTimers();
      if (wantsLiveShips) {
        liveShipsActiveRef.current = false;
        void postActivity(false, viewportRef.current);
      }
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
      liveShipsActiveRef.current = false;
      if (viewportSettle.current) {
        clearTimeout(viewportSettle.current);
        viewportSettle.current = null;
      }
    };
  }, [activeLayers.maritime, activeLayers.maritime_ships]);
}
