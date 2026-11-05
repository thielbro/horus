// Shared transport failure for every Waze transport chain: the GeoRSS chain in
// waze.ts and the mobile-RT transport in waze-rt.ts. Extracted from waze.ts so
// both can throw and catch it without an import cycle. Shape unchanged.

export class WazeTransportError extends Error {
  readonly status: number;
  readonly transport: string;

  constructor(message: string, status: number, transport: string) {
    super(message);
    this.name = 'WazeTransportError';
    this.status = status;
    this.transport = transport;
  }
}
