export type BBox = [south: number, west: number, north: number, east: number];

export type WazeAlertKind = 'police' | 'camera';

export type WazeTransportMode = 'auto' | 'http' | 'browser';

export interface WazePoliceCameraAlert {
  id: string;
  provider: 'waze';
  kind: WazeAlertKind;
  lat: number;
  lng: number;
  type: string | null;
  subtype: string | null;
  reportTime: string | null;
  reliability: number | null;
  confidence: number | null;
  description: string | null;
  raw: Record<string, unknown>;
}

export interface WazeScrapeError {
  message: string;
  status?: number;
  tile?: BBox;
  transport?: string;
}

export interface WazeScrapeResult {
  timestamp: string;
  provider: 'waze';
  alerts: WazePoliceCameraAlert[];
  errors: WazeScrapeError[];
}

export interface WazeGeoRssTransport {
  fetchGeoRss: (url: string, context: { bbox: BBox; env: string; signal?: AbortSignal }) => Promise<unknown>;
  close?: () => Promise<void>;
}

export interface ScrapeWazePoliceCameraAlertsOptions {
  bbox: BBox | string;
  transport?: WazeTransportMode | WazeGeoRssTransport;
  browserHeadless?: boolean;
  maxTileSpanDegrees?: number;
  concurrency?: number;
  signal?: AbortSignal;
}
