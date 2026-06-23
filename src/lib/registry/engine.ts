'use client';

// Feed engine — drives data loading from the registry's FeedDefs. This is a faithful
// replacement for the three hand-written effects that used to live in page.tsx
// (core startup+poll, lazy once-load on layer activation, and the lazy polling subset).
// Behavior is identical; only the source of truth moved into the registry.

import { useCallback, useEffect, useRef } from 'react';
import { getFeeds } from './feeds';
import { useRegistryVersion } from './reactive';
import type { DataBuckets } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type IfVisible = (fn: () => void) => () => void;

export function useFeedEngine(
  activeLayers: Record<string, boolean>,
  fetchEndpoint: FetchEndpoint,
  ifVisible: IfVisible,
): void {
  // Re-run the feed effects when feeds are added/removed at runtime (custom sources, plugins).
  const registryVersion = useRegistryVersion();
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const lazyIntervalsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const runFetch = useCallback((url: string, transform?: (d: any) => DataBuckets) => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    void Promise.resolve(fetchEndpoint(url, transform, { signal: controller.signal }))
      .finally(() => controllersRef.current.delete(controller));
  }, [fetchEndpoint]);

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    lazyIntervalsRef.current.forEach(clearInterval);
    lazyIntervalsRef.current.clear();
  }, []);

  // ── Core feeds: startup (optionally delayed) + poll, always ──
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    for (const f of getFeeds()) {
      if (f.priority !== 'core') continue;
      const run = () => runFetch(f.url, f.transform);
      if (f.startupDelayMs) timers.push(setTimeout(run, f.startupDelayMs));
      else run();
      if (f.intervalMs) intervals.push(setInterval(ifVisible(run), f.intervalMs));
    }
    return () => {
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
    };
  }, [ifVisible, runFetch, registryVersion]);

  // ── Lazy feeds: fetch once when any activating layer first turns on ──
  const fetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const f of getFeeds()) {
      if (f.priority === 'core') continue;
      const active = (f.activatedBy ?? []).some((k) => activeLayers[k]);
      if (active && !fetched.current.has(f.id)) {
        runFetch(f.url, f.transform);
        fetched.current.add(f.id);
      }
    }
  }, [activeLayers, runFetch, registryVersion]);

  // ── Lazy polling: poll active lazy feeds that declare an interval ──
  useEffect(() => {
    const activeIntervalIds = new Set<string>();
    for (const f of getFeeds()) {
      if (f.priority === 'core' || !f.intervalMs) continue;
      const active = (f.activatedBy ?? []).some((k) => activeLayers[k]);
      if (!active) continue;
      activeIntervalIds.add(f.id);
      if (!lazyIntervalsRef.current.has(f.id)) {
        lazyIntervalsRef.current.set(
          f.id,
          setInterval(ifVisible(() => runFetch(f.url, f.transform)), f.intervalMs),
        );
      }
    }
    for (const [id, interval] of lazyIntervalsRef.current) {
      if (!activeIntervalIds.has(id)) {
        clearInterval(interval);
        lazyIntervalsRef.current.delete(id);
      }
    }
  }, [activeLayers, ifVisible, runFetch, registryVersion]);
}
