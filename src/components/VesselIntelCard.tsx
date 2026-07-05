'use client';

import { memo, useEffect, useState } from 'react';
import { Ship, Anchor, ExternalLink } from 'lucide-react';
import { flagFromMmsi } from '@/lib/mmsi-flags';

/**
 * MarineTraffic-style vessel dossier for the Entity Intel panel.
 * Renders from the live-feed AIS properties threaded through the map click;
 * every field is optional and degrades to an em dash.
 */

interface Props {
  label: string;
  properties?: Record<string, any>;
}

const CYAN = '#00BCD4';

function num(v: any): number | null {
  if (v == null || v === '' || v === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: any): string | null {
  if (v == null || v === 'null' || v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-black/30 border border-white/5 px-2.5 py-2">
      <div className="text-[8px] font-mono text-white/40 uppercase tracking-[0.15em]">{label}</div>
      <div className="text-[11px] font-mono mt-0.5 truncate" style={{ color: accent ? CYAN : 'rgba(255,255,255,0.9)' }}>
        {value}
      </div>
    </div>
  );
}

interface VesselPhoto {
  url: string;
  pageUrl: string | null;
  credit: string | null;
  license: string | null;
}

function VesselIntelCard({ label, properties }: Props) {
  const p = properties || {};
  const mmsi = num(p.mmsi);
  const imo = num(p.imo);
  const photoName = str(p.name) || label;
  const [photo, setPhoto] = useState<VesselPhoto | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);

  // Best-effort free-license photo (Wikimedia Commons, keyed by IMO/MMSI/name).
  // Coverage is notable ships only; misses fall back to the type glyph silently.
  useEffect(() => {
    setPhoto(null);
    setPhotoFailed(false);
    if (imo == null && mmsi == null && (!photoName || photoName.length < 4)) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (imo != null) params.set('imo', String(imo));
    if (mmsi != null) params.set('mmsi', String(mmsi));
    if (photoName) params.set('name', photoName);
    fetch(`/api/vessel-photo?${params}`, { cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!controller.signal.aborted && json?.photo?.url) setPhoto(json.photo);
      })
      .catch(() => { /* best effort */ });
    return () => controller.abort();
  }, [imo, mmsi, photoName]);
  const flag = str(p.flag) ? { code: str(p.flag)!, name: str(p.flag)! } : flagFromMmsi(mmsi);
  const shipType = (str(p.type) || 'vessel').toUpperCase();
  const speed = num(p.speed);
  const heading = num(p.heading);
  const draught = num(p.draught);
  const length = num(p.length);
  const width = num(p.width);
  const lat = num(p.lat);
  const lng = num(p.lng);
  const destination = str(p.destination);
  const eta = str(p.eta);
  const navStatus = str(p.nav_status);
  const callsign = str(p.callsign);
  const ts = num(p.timestamp);
  const ageMin = ts != null ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : null;
  const typeColor = shipType === 'MILITARY' ? '#FF1744' : shipType === 'TANKER' ? '#FF9500' : CYAN;

  return (
    <div className="space-y-3">
      {/* PHOTO BANNER — Wikimedia Commons, when a free-license shot exists */}
      {photo && !photoFailed && (
        <div className="relative border border-white/10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={label}
            className="w-full h-32 object-cover"
            onError={() => setPhotoFailed(true)}
          />
          <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-between gap-2">
            <span className="text-[7px] font-mono text-white/60 truncate">
              {photo.credit ? `© ${photo.credit}` : 'WIKIMEDIA COMMONS'}{photo.license ? ` · ${photo.license}` : ''}
            </span>
            {photo.pageUrl && (
              <a href={photo.pageUrl} target="_blank" rel="noreferrer"
                className="text-[7px] font-mono shrink-0 hover:underline" style={{ color: `${CYAN}B0` }}>
                SOURCE ↗
              </a>
            )}
          </div>
        </div>
      )}

      {/* IDENT HEADER — flag chip + name + type */}
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center justify-center w-11 h-11 border shrink-0"
          style={{ borderColor: `${typeColor}50`, background: `${typeColor}10` }}>
          <Ship className="w-4 h-4" style={{ color: typeColor }} />
          <span className="text-[8px] font-mono font-bold tracking-widest mt-0.5" style={{ color: typeColor }}>
            {flag?.code || '??'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-mono font-bold text-white tracking-[0.08em] uppercase truncate">{label}</div>
          <div className="text-[9px] font-mono text-white/50 tracking-widest uppercase truncate">
            {shipType}{flag ? ` · ${flag.name}` : ''}{callsign ? ` · CS ${callsign}` : ''}
          </div>
        </div>
      </div>

      {/* VOYAGE STRIP — current position → destination, ETA */}
      <div className="bg-black/30 border border-white/5 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[8px] font-mono text-white/40 uppercase tracking-[0.15em]">POSITION</div>
            <div className="text-[10px] font-mono text-white/90 truncate">
              {lat != null && lng != null ? `${lat.toFixed(3)}°, ${lng.toFixed(3)}°` : 'AT SEA'}
            </div>
          </div>
          <div className="flex items-center flex-1 min-w-[60px]">
            <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: CYAN }} />
            <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, ${CYAN}, ${CYAN}30)` }} />
            <div className="w-0 h-0 shrink-0 border-y-[3px] border-y-transparent border-l-[6px]" style={{ borderLeftColor: CYAN }} />
            <div className="flex-1 h-px bg-white/15" />
            <div className="w-1.5 h-1.5 rounded-full border shrink-0 border-white/40" />
          </div>
          <div className="min-w-0 flex-1 text-right">
            <div className="text-[8px] font-mono text-white/40 uppercase tracking-[0.15em]">DESTINATION</div>
            <div className="text-[10px] font-mono truncate" style={{ color: destination ? CYAN : 'rgba(255,255,255,0.4)' }}>
              {destination || 'UNKNOWN'}
            </div>
          </div>
        </div>
        {eta && (
          <div className="text-[8px] font-mono text-white/40 tracking-[0.15em] text-right mt-1.5">
            REPORTED ETA <span className="text-white/80">{eta}</span>
          </div>
        )}
      </div>

      {/* STATUS ROW — nav status / speed-course / draught (MarineTraffic triple) */}
      <div className="grid grid-cols-3 gap-2">
        <Cell label="Nav Status" value={navStatus || '—'} accent />
        <Cell label="Speed / Course" value={`${speed != null ? `${speed.toFixed(1)} kn` : '—'} / ${heading != null ? `${heading.toFixed(0)}°` : '—'}`} />
        <Cell label="Draught" value={draught != null ? `${draught.toFixed(1)} m` : '—'} />
      </div>

      {/* IDENTITY GRID */}
      <div className="grid grid-cols-2 gap-2">
        <Cell label="MMSI" value={mmsi != null ? String(mmsi) : '—'} />
        <Cell label="IMO" value={imo != null ? String(imo) : '—'} />
        <Cell label="Flag State" value={flag ? flag.name : '—'} />
        <Cell label="Size" value={length != null ? `${length} m × ${width != null ? `${width} m` : '?'}` : '—'} />
      </div>

      {/* SOURCE LINE + DETAILS LINK */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[8px] font-mono text-white/40 tracking-[0.15em] uppercase min-w-0">
          <Anchor className="w-3 h-3 shrink-0" style={{ color: `${CYAN}80` }} />
          <span className="truncate">
            {ageMin != null ? `RECEIVED ${ageMin === 0 ? 'JUST NOW' : `${ageMin} MIN AGO`} · ` : ''}AIS / AISSTREAM
          </span>
        </div>
        {mmsi != null && (
          <a
            href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`}
            target="_blank" rel="noreferrer"
            className="flex items-center gap-1 px-2 py-1 border text-[9px] font-mono font-bold tracking-[0.15em] shrink-0 transition-colors hover:bg-white/5"
            style={{ color: CYAN, borderColor: `${CYAN}40`, background: `${CYAN}10` }}
          >
            VESSEL DETAILS <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
      </div>
    </div>
  );
}

export default memo(VesselIntelCard);
