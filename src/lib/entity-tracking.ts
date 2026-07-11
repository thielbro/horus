export type TrackedEntityKind = 'aircraft' | 'vessel';

export interface TrackedEntity {
  id: string;
  kind: TrackedEntityKind;
  identifier: string;
  label: string;
  createdAt: number;
}

export interface TrackedDetection {
  watch: TrackedEntity;
  entity: Record<string, any>;
  detectedAt: number;
}

const AIRCRAFT_BUCKETS = ['commercial_flights', 'private_flights', 'private_jets', 'military_flights'] as const;

export function normalizeTrackingIdentifier(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export function trackedEntityId(kind: TrackedEntityKind, identifier: string): string {
  return `${kind}:${normalizeTrackingIdentifier(identifier)}`;
}

export function findTrackedEntity(watch: TrackedEntity, data: Record<string, any>): Record<string, any> | null {
  const wanted = normalizeTrackingIdentifier(watch.identifier);
  if (!wanted) return null;

  const entities = watch.kind === 'aircraft'
    ? AIRCRAFT_BUCKETS.flatMap((bucket) => Array.isArray(data[bucket]) ? data[bucket] : [])
    : (Array.isArray(data.maritime_ships) ? data.maritime_ships : []);

  const fields = watch.kind === 'aircraft'
    ? ['icao24', 'registration', 'callsign']
    : ['mmsi', 'imo', 'callsign', 'name'];

  return entities.find((entity: Record<string, any>) =>
    fields.some((field) => normalizeTrackingIdentifier(entity?.[field]) === wanted)
  ) ?? null;
}

export function detectionLabel(detection: TrackedDetection): string {
  const entity = detection.entity;
  if (detection.watch.kind === 'aircraft') {
    return entity.callsign || entity.registration || entity.icao24 || detection.watch.label;
  }
  return entity.name || entity.callsign || entity.mmsi || detection.watch.label;
}
