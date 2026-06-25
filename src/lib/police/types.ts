import type { BBox } from '@/lib/overpass';

/**
 * A curated police-station record. Shape is the API contract for the `police`
 * map layer (see src/lib/registry/builtins.ts → toFeatures), so it deliberately
 * mirrors the OpenStreetMap mapper's output: `operator`/`osm_url` stay present
 * (null for curated rows) so the frontend reads both sources identically.
 */
export interface PoliceStation {
  id: string;
  lat: number;
  lng: number;
  name: string;
  operator: string | null;
  source: string;
  osm_url: string | null;
}

/**
 * A curated, authoritative police dataset for one country/territory. When a
 * request's viewport intersects `coverage`, the curated `stations` replace live
 * OpenStreetMap results inside that area (see src/lib/police/curated.ts).
 */
export interface CuratedPoliceDataset {
  id: string;
  country: string;
  /** Bounding box(es) this dataset is authoritative for — [south, west, north, east]. */
  coverage: BBox[];
  stations: PoliceStation[];
}
