import { NextResponse } from 'next/server';

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  POLYBOLOS SDK — SSE Stream Endpoint                            ║
 * ║  Server-Sent Events for real-time entity streaming              ║
 * ║                                                                 ║
 * ║  GET /api/sdk/stream → Opens an SSE connection that pushes      ║
 * ║  normalized Polybolos entities to the client in real-time.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// In-memory entity store shared across the SDK endpoints
const globalForSDK = globalThis as unknown as {
  sdkEntityStore: Map<string, any>;
  sdkLastUpdate: number;
  sdkActiveStreamConnections: number;
};

if (!globalForSDK.sdkEntityStore) {
  globalForSDK.sdkEntityStore = new Map();
  globalForSDK.sdkLastUpdate = Date.now();
}
if (globalForSDK.sdkActiveStreamConnections == null) {
  globalForSDK.sdkActiveStreamConnections = 0;
}

export const dynamic = 'force-dynamic';
const MAX_SDK_STREAM_CONNECTIONS = 100;
const MAX_SDK_STREAM_LIFETIME_MS = 30 * 60 * 1000;

export async function GET() {
  if (globalForSDK.sdkActiveStreamConnections >= MAX_SDK_STREAM_CONNECTIONS) {
    return NextResponse.json({ error: 'Too many SDK stream connections' }, { status: 429 });
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let entityPush: ReturnType<typeof setInterval> | undefined;
  let maxLifetime: ReturnType<typeof setTimeout> | undefined;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (heartbeat) clearInterval(heartbeat);
    if (entityPush) clearInterval(entityPush);
    if (maxLifetime) clearTimeout(maxLifetime);
    globalForSDK.sdkActiveStreamConnections = Math.max(0, globalForSDK.sdkActiveStreamConnections - 1);
  };

  const stream = new ReadableStream({
    start(controller) {
      globalForSDK.sdkActiveStreamConnections++;
      maxLifetime = setTimeout(() => {
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the client.
        } finally {
          cleanup();
        }
      }, MAX_SDK_STREAM_LIFETIME_MS);

      // Send initial status
      const statusEvent = {
        type: 'status',
        timestamp: new Date().toISOString(),
        payload: {
          connected: true,
          entityCount: globalForSDK.sdkEntityStore.size,
          feedCount: 9,
          latticeStatus: 'disconnected',
          lastUpdate: new Date().toISOString(),
          uptime: Date.now() - globalForSDK.sdkLastUpdate,
        },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(statusEvent)}\n\n`));

      // Send heartbeat every 15 seconds
      heartbeat = setInterval(() => {
        try {
          const hb = {
            type: 'heartbeat',
            timestamp: new Date().toISOString(),
            payload: { entityCount: globalForSDK.sdkEntityStore.size },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(hb)}\n\n`));
        } catch {
          cleanup();
        }
      }, 15000);

      // Send entity updates every 5 seconds if data has changed
      let lastSentVersion = 0;
      entityPush = setInterval(() => {
        try {
          if (globalForSDK.sdkLastUpdate > lastSentVersion) {
            lastSentVersion = globalForSDK.sdkLastUpdate;
            const entities = Array.from(globalForSDK.sdkEntityStore.values()).slice(0, 500);
            const event = {
              type: 'entity_update',
              timestamp: new Date().toISOString(),
              payload: entities,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        } catch {
          cleanup();
        }
      }, 5000);
    },
    // Clear the timers when the client disconnects — without this, every dropped SSE
    // connection leaks two intervals that run forever server-side.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
