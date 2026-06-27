'use client';

// Viewport-driven loading for the OSM "positions-only" point layers — police,
// Flock/ALPR, mass-surveillance, and surveillance(OSM). These layers are far too
// dense to fetch globally, so instead of the feed engine's fixed continent-scale
// defaults (which left, e.g., a New Zealand user with no data at all), they fetch
// `/api/<layer>?bbox=<current view>` and refresh as the map pans/zooms.
//
// Curated police are owned, viewport-independent data — loaded ONCE into their own
// `police_curated` bucket via `/api/police?curated=1` so the user's stations always
// render at any zoom, with live OSM (the viewport bucket) layered on top.

import { useEffect, useRef } from 'react';
import type { DataBuckets } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type Bounds = [number, number, number, number]; // [south, west, north, east]

interface ViewportLayer {
  /** activeLayers key that switches this layer on. */
  layer: string;
  route: string;
  bucket: string;
}

const VIEWPORT_LAYERS: ViewportLayer[] = [
  { layer: 'police', route: '/api/police', bucket: 'police' },
  { layer: 'flock', route: '/api/flock', bucket: 'flock' },
  { layer: 'mass_surveil', route: '/api/mass-surveillance', bucket: 'mass_surveil' },
  { layer: 'surveillance', route: '/api/surveillance', bucket: 'surveillance' },
];

// Server rejects a user bbox whose area exceeds MAX_BBOX_AREA_DEGREES (25). Stay
// safely under it: when the view is larger than this (zoomed too far out), skip the
// live OSM fetch — the query would 400 anyway, and these layers only read well close in.
const MAX_VIEW_AREA_DEG2 = 20;
const DEBOUNCE_MS = 400;

function bboxParam(b: Bounds): string {
  // Clamp to valid ranges; the API re-validates and rejects anything malformed.
  const s = Math.max(-90, b[0]);
  const n = Math.min(90, b[2]);
  const w = Math.max(-180, b[1]);
  const e = Math.min(180, b[3]);
  return `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
}

function viewAreaDeg2(b: Bounds): number {
  return Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);
}

export function useViewportLayers(
  activeLayers: Record<string, boolean>,
  mapView: { bounds?: Bounds },
  fetchEndpoint: FetchEndpoint,
  clearBucket?: (bucket: string) => void,
): void {
  const bounds = mapView.bounds;
  // Last bbox string fetched per layer — skip refetching an unchanged viewport.
  const lastFetched = useRef<Map<string, string>>(new Map());
  // In-flight fetch per layer — aborted when a newer viewport supersedes it (rapid pan/zoom)
  // so stale responses can't overwrite fresh data and sockets don't pile up.
  const controllers = useRef<Map<string, AbortController>>(new Map());
  // Whether the always-on curated police set has been loaded for this session.
  const curatedLoaded = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Abort any still-running viewport fetches on unmount.
  useEffect(() => {
    const live = controllers.current;
    return () => { live.forEach((c) => c.abort()); live.clear(); };
  }, []);

  // Always-on curated police — load once the first time Police is enabled.
  useEffect(() => {
    if (!activeLayers.police || curatedLoaded.current) return;
    curatedLoaded.current = true;
    fetchEndpoint('/api/police?curated=1', (d) => ({ police_curated: d.police ?? [] }));
  }, [activeLayers.police, fetchEndpoint]);

  // Viewport OSM — (re)fetch the in-view area for each active layer, debounced so
  // panning doesn't hammer Overpass.
  useEffect(() => {
    if (!bounds) return;
    const param = bboxParam(bounds);
    const tooLarge = viewAreaDeg2(bounds) > MAX_VIEW_AREA_DEG2;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      for (const { layer, route, bucket } of VIEWPORT_LAYERS) {
        if (!activeLayers[layer]) {
          lastFetched.current.delete(layer);
          controllers.current.get(layer)?.abort();
          controllers.current.delete(layer);
          continue;
        }
        // Zoomed too far out for a live query — leave the existing bucket as-is
        // (for police, the always-on curated set still shows).
        if (tooLarge) continue;
        if (lastFetched.current.get(layer) === param) continue;
        // Supersede any in-flight fetch for this layer before starting the new one.
        controllers.current.get(layer)?.abort();
        // Clear stale markers immediately so wrong-location data never lingers while
        // the new viewport fetch is in flight (or if it fails / rate-limits).
        clearBucket?.(bucket);
        lastFetched.current.set(layer, param);
        const ac = new AbortController();
        controllers.current.set(layer, ac);
        fetchEndpoint(`${route}?bbox=${param}`, (d) => ({ [bucket]: d[bucket] ?? [] }), { signal: ac.signal });
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // Re-run when the viewport changes or a layer is toggled.
  }, [bounds, activeLayers, fetchEndpoint]);
}
