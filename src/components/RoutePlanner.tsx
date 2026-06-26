'use client';

// HORUS — route exposure planner. Collects a start + end (address or "lat,lng") and triggers
// an on-the-go `route` dossier via the global openHorusDossier hook. The result (route line,
// surveillance corridor, on-route cameras/ALPR/police) is rendered by DossierPanel and drawn on
// the map by the route overlay — this component is only the entry point.

import { memo, useState } from 'react';
import { Route, Crosshair, ArrowRight } from 'lucide-react';

const inputCls = 'w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-[11px] font-mono text-white/85 focus:border-[var(--gold-primary)]/40 outline-none';
const labelCls = 'text-[9px] font-mono tracking-widest text-white/40 mb-1 block uppercase';

interface OpenDossier {
  (ref: { kind: string; id: string; label: string }): void;
}

function RoutePlanner() {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const run = () => {
    const a = start.trim();
    const b = end.trim();
    if (!a || !b) return;
    const open = (window as unknown as { openHorusDossier?: OpenDossier }).openHorusDossier;
    open?.({ kind: 'route', id: `${a}|${b}`, label: `${a} → ${b}` });
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') run(); };
  const ready = start.trim().length > 0 && end.trim().length > 0;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3 text-[11px] font-mono font-bold tracking-widest text-[var(--gold-primary)] border-b border-[var(--border-primary)] pb-2">
        <Route className="w-3.5 h-3.5" />
        ROUTE EXPOSURE
      </div>

      <div className="space-y-2">
        <div>
          <label className={labelCls}>Start</label>
          <input className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} onKeyDown={onKey} placeholder="Address or lat,lng — e.g. Buckingham Palace" />
        </div>
        <div className="flex justify-center text-white/20">
          <ArrowRight className="w-3.5 h-3.5 rotate-90" />
        </div>
        <div>
          <label className={labelCls}>End</label>
          <input className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} onKeyDown={onKey} placeholder="Address or lat,lng — e.g. Tower Bridge" />
        </div>
        <button
          onClick={run}
          disabled={!ready}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-[var(--gold-primary)]/30 text-[10px] font-mono tracking-wider text-[var(--gold-primary)] hover:bg-[var(--gold-primary)]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Crosshair className="w-3.5 h-3.5" /> MAP SURVEILLANCE EXPOSURE
        </button>
      </div>

      <p className="text-[9px] font-mono text-white/30 leading-relaxed mt-2">
        Plots a driving route and the cameras, ALPR readers, and police within ~150 m of it —
        with the densest segments and ALPR chokepoints called out. Requires a routing endpoint
        (Settings → Routing URL).
      </p>
    </section>
  );
}

export default memo(RoutePlanner);
