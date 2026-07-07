import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/**
 * HORUS — MarineTraffic scraper sidecar manager.
 *
 * The Pro-level vessel dossier comes from a local Python/Playwright sidecar
 * (mt_server.py at the repo root) that keeps a logged-in MarineTraffic session
 * alive. This module lazily spawns it on first use and exposes its base URL.
 *
 * Env:
 *   MT_SCRAPER_URL      — point at an externally managed sidecar (disables spawning)
 *   MT_SCRAPER_PORT     — port for the auto-spawned sidecar (default 8477)
 *   MT_PYTHON           — python executable (default "python")
 *   MT_SCRAPER_DISABLED — set to "1" to turn the feature off entirely
 */

const PORT = Number(process.env.MT_SCRAPER_PORT || 8477);
const EXTERNAL_URL = process.env.MT_SCRAPER_URL?.replace(/\/$/, '') || null;
export const MT_BASE = EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

let sidecar: ChildProcess | null = null;
let startPromise: Promise<boolean> | null = null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function healthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${MT_BASE}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ensure the sidecar is reachable, spawning it if we manage it. */
export async function ensureMtSidecar(): Promise<boolean> {
  if (process.env.MT_SCRAPER_DISABLED === '1') return false;
  if (await healthy()) return true;
  if (EXTERNAL_URL) return false; // externally managed — nothing to spawn

  if (!startPromise) {
    startPromise = (async () => {
      const script = path.join(process.cwd(), 'mt_server.py');
      if (!fs.existsSync(script)) {
        console.warn('[HORUS] mt_server.py not found — MarineTraffic enrichment disabled');
        return false;
      }
      const py = process.env.MT_PYTHON || 'python';
      try {
        sidecar = spawn(py, [script, '--port', String(PORT)], {
          cwd: process.cwd(),
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (err) {
        console.warn('[HORUS] failed to spawn MarineTraffic sidecar:', err);
        return false;
      }
      sidecar.on('error', (err) => {
        console.warn('[HORUS] MarineTraffic sidecar error:', err.message);
        sidecar = null;
      });
      sidecar.on('exit', () => {
        sidecar = null;
        startPromise = null; // allow a later retry
      });
      // First boot includes Playwright launch + MarineTraffic login.
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (!sidecar) return false;
        if (await healthy()) return true;
      }
      return false;
    })();
    // A failed start should not poison future requests forever.
    startPromise.then((ok) => {
      if (!ok) startPromise = null;
    });
  }
  return startPromise;
}
