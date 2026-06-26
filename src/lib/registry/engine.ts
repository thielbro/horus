'use client';

// Feed engine — drives data loading from the registry's FeedDefs. This is a faithful
// replacement for the three hand-written effects that used to live in page.tsx
// (core startup+poll, lazy once-load on layer activation, and the lazy polling subset).
// Behavior is identical; only the source of truth moved into the registry.

import { useCallback, useEffect, useRef } from 'react';
import { getFeeds } from './feeds';
import { useRegistryVersion } from './reactive';
import type { DataBuckets, FeedDef } from './types';

type FetchEndpoint = (url: string, transform?: (d: any) => DataBuckets, options?: RequestInit) => unknown;
type IfVisible = (fn: () => void) => () => void;
type IntervalEntry = { interval: ReturnType<typeof setInterval>; signature: string };
type StartupEntry = { timer: ReturnType<typeof setTimeout>; signature: string };
type AnyFunction = (...args: any[]) => unknown;

const functionIds = new WeakMap<AnyFunction, number>();
let nextFunctionId = 1;
function functionSignature(fn: AnyFunction | undefined): string {
  if (!fn) return 'none';
  let id = functionIds.get(fn);
  if (!id) {
    id = nextFunctionId++;
    functionIds.set(fn, id);
  }
  return String(id);
}

function getFeedSignature(feed: FeedDef, runFetch?: AnyFunction, ifVisible?: AnyFunction): string {
  return [
    feed.url,
    feed.intervalMs ?? '',
    feed.startupDelayMs ?? '',
    feed.priority ?? 'lazy',
    functionSignature(feed.transform),
    functionSignature(runFetch),
    functionSignature(ifVisible),
  ].join('|');
}

export function useFeedEngine(
  activeLayers: Record<string, boolean>,
  fetchEndpoint: FetchEndpoint,
  ifVisible: IfVisible,
): void {
  // Re-run the feed effects when feeds are added/removed at runtime (custom sources, plugins).
  const registryVersion = useRegistryVersion();
  const controllersRef = useRef<Set<AbortController> | null>(null);
  const coreStartupTimersRef = useRef<Map<string, StartupEntry> | null>(null);
  const coreIntervalsRef = useRef<Map<string, IntervalEntry> | null>(null);
  const coreSignaturesRef = useRef<Map<string, string> | null>(null);
  const lazyIntervalsRef = useRef<Map<string, IntervalEntry> | null>(null);
  const lazySignaturesRef = useRef<Map<string, string> | null>(null);
  const fetched = useRef<Set<string> | null>(null);
  if (!controllersRef.current) controllersRef.current = new Set();
  if (!coreStartupTimersRef.current) coreStartupTimersRef.current = new Map();
  if (!coreIntervalsRef.current) coreIntervalsRef.current = new Map();
  if (!coreSignaturesRef.current) coreSignaturesRef.current = new Map();
  if (!lazyIntervalsRef.current) lazyIntervalsRef.current = new Map();
  if (!lazySignaturesRef.current) lazySignaturesRef.current = new Map();
  if (!fetched.current) fetched.current = new Set();

  const runFetch = useCallback((url: string, transform?: (d: any) => DataBuckets) => {
    const controller = new AbortController();
    controllersRef.current?.add(controller);
    void Promise.resolve(fetchEndpoint(url, transform, { signal: controller.signal }))
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[HORUS] Registry feed fetch failed', { url, err });
        }
      })
      .finally(() => controllersRef.current?.delete(controller));
  }, [fetchEndpoint]);

  useEffect(() => () => {
    controllersRef.current?.forEach((controller) => controller.abort());
    controllersRef.current?.clear();
    coreStartupTimersRef.current?.forEach((entry) => clearTimeout(entry.timer));
    coreStartupTimersRef.current?.clear();
    coreIntervalsRef.current?.forEach((entry) => clearInterval(entry.interval));
    coreIntervalsRef.current?.clear();
    lazyIntervalsRef.current?.forEach((entry) => clearInterval(entry.interval));
    lazyIntervalsRef.current?.clear();
  }, []);

  // ── Core feeds: startup (optionally delayed) + poll, always ──
  useEffect(() => {
    const liveCoreIds = new Set<string>();
    for (const f of getFeeds()) {
      if (f.priority !== 'core') continue;
      liveCoreIds.add(f.id);
      const signature = getFeedSignature(f, runFetch, ifVisible);
      const existingSignature = coreSignaturesRef.current?.get(f.id);
      if (existingSignature === signature) continue;

      const existingStartup = coreStartupTimersRef.current?.get(f.id);
      if (existingStartup) clearTimeout(existingStartup.timer);
      coreStartupTimersRef.current?.delete(f.id);
      const existingInterval = coreIntervalsRef.current?.get(f.id);
      if (existingInterval) clearInterval(existingInterval.interval);
      coreIntervalsRef.current?.delete(f.id);
      coreSignaturesRef.current?.set(f.id, signature);

      const run = () => runFetch(f.url, f.transform);
      if (f.startupDelayMs) {
        const timer = setTimeout(() => {
          coreStartupTimersRef.current?.delete(f.id);
          run();
        }, f.startupDelayMs);
        coreStartupTimersRef.current?.set(f.id, { timer, signature });
      }
      else run();
      if (f.intervalMs) {
        coreIntervalsRef.current?.set(f.id, { interval: setInterval(ifVisible(run), f.intervalMs), signature });
      }
    }

    for (const id of [...(coreSignaturesRef.current?.keys() ?? [])]) {
      if (liveCoreIds.has(id)) continue;
      const startup = coreStartupTimersRef.current?.get(id);
      if (startup) clearTimeout(startup.timer);
      coreStartupTimersRef.current?.delete(id);
      const interval = coreIntervalsRef.current?.get(id);
      if (interval) clearInterval(interval.interval);
      coreIntervalsRef.current?.delete(id);
      coreSignaturesRef.current?.delete(id);
    }
  }, [ifVisible, runFetch, registryVersion]);

  // ── Lazy feeds: fetch once when any activating layer first turns on ──
  useEffect(() => {
    const liveLazyIds = new Set<string>();
    for (const f of getFeeds()) {
      if (f.priority === 'core') continue;
      liveLazyIds.add(f.id);
      const signature = getFeedSignature(f, runFetch);
      if (lazySignaturesRef.current?.get(f.id) !== signature) {
        fetched.current?.delete(f.id);
        lazySignaturesRef.current?.set(f.id, signature);
      }
      const active = (f.activatedBy ?? []).some((k) => activeLayers[k]);
      if (active && !fetched.current?.has(f.id)) {
        runFetch(f.url, f.transform);
        fetched.current?.add(f.id);
      }
    }

    for (const id of [...(lazySignaturesRef.current?.keys() ?? [])]) {
      if (liveLazyIds.has(id)) continue;
      fetched.current?.delete(id);
      lazySignaturesRef.current?.delete(id);
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
      const signature = getFeedSignature(f, runFetch, ifVisible);
      const entry = lazyIntervalsRef.current?.get(f.id);
      if (!entry || entry.signature !== signature) {
        if (entry) clearInterval(entry.interval);
        lazyIntervalsRef.current?.set(
          f.id,
          { interval: setInterval(ifVisible(() => runFetch(f.url, f.transform)), f.intervalMs), signature },
        );
      }
    }
    for (const [id, entry] of lazyIntervalsRef.current ?? []) {
      if (!activeIntervalIds.has(id)) {
        clearInterval(entry.interval);
        lazyIntervalsRef.current?.delete(id);
      }
    }
  }, [activeLayers, ifVisible, runFetch, registryVersion]);
}
