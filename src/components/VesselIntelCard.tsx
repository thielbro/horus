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

interface MtPhoto {
  url: string;
  thumb?: string;
}

/** MarineTraffic Pro dossier from /api/marinetraffic (all fields optional strings). */
type MtDossier = Record<string, any> & { photos?: MtPhoto[] };

const mtProxied = (url: string) => `/api/marinetraffic/photo?url=${encodeURIComponent(url)}`;

function VesselIntelCard({ label, properties }: Props) {
  const p = properties || {};
  const mmsi = num(p.mmsi);
  const imo = num(p.imo);
  const photoName = str(p.name) || label;
  const [photo, setPhoto] = useState<VesselPhoto | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [mt, setMt] = useState<MtDossier | null>(null);
  const [mtLoading, setMtLoading] = useState(false);
  const [photoIdx, setPhotoIdx] = useState(0);

  // MarineTraffic Pro enrichment via the local scraper sidecar. Slow on cold
  // start (browser launch + login), so it streams in after the AIS fields.
  useEffect(() => {
    setMt(null);
    setPhotoIdx(0);
    if (mmsi == null && imo == null) return;
    const controller = new AbortController();
    setMtLoading(true);
    const params = new URLSearchParams();
    if (mmsi != null) params.set('mmsi', String(mmsi));
    if (imo != null) params.set('imo', String(imo));
    fetch(`/api/marinetraffic?${params}`, { cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!controller.signal.aborted && json?.vessel) setMt(json.vessel);
      })
      .catch(() => { /* best effort — AIS card stands alone */ })
      .finally(() => {
        if (!controller.signal.aborted) setMtLoading(false);
      });
    return () => controller.abort();
  }, [mmsi, imo]);

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
  const mtStr = (k: string): string | null => (mt ? str(mt[k]) : null);
  const mtPhotos: MtPhoto[] = Array.isArray(mt?.photos) ? (mt!.photos as MtPhoto[]).filter((ph) => ph?.url) : [];
  const activePhoto = mtPhotos[Math.min(photoIdx, mtPhotos.length - 1)] || null;

  const flag = str(p.flag) ? { code: str(p.flag)!, name: str(p.flag)! } : flagFromMmsi(mmsi);
  const shipType = (str(p.type) || mtStr('ship_type') || 'vessel').toUpperCase();
  const speed = num(p.speed);
  const heading = num(p.heading);
  const draught = num(p.draught);
  const length = num(p.length);
  const width = num(p.width);
  const lat = num(p.lat);
  const lng = num(p.lng);
  const destination = str(p.destination) || mtStr('destination') || mtStr('reported_destination');
  const eta = str(p.eta) || mtStr('eta') || mtStr('reported_eta');
  const navStatus = str(p.nav_status) || mtStr('navigational_status');
  const callsign = str(p.callsign) || mtStr('callsign');
  const ts = num(p.timestamp);

  // MarineTraffic Pro particulars — only non-empty fields render.
  const mtWind = [mtStr('current_wind_speed'), mtStr('current_wind_direction')].filter(Boolean).join(' ');
  const proRows: Array<[string, string]> = (
    [
      ['Year Built', mtStr('year_built')],
      ['Gross Tonnage', mtStr('gross_tonnage')],
      ['Deadweight', mtStr('deadweight')],
      ['Length Overall', mtStr('length_overall')],
      ['Beam', mtStr('width')],
      ['AIS Class', mtStr('ais_class')],
      ['Departure Port', mtStr('departure_port')],
      ['Departed (ATD)', mtStr('actual_departure_time')],
      ['Arrival Port', mtStr('arrival_port')],
      ['Calculated ETA', mtStr('calculated_eta')],
      ['Dist. Travelled', mtStr('distance_travelled')],
      ['Dist. To Go', mtStr('distance_to_go')],
      ['Time To Dest.', mtStr('time_to_destination')],
      ['Sea Area', mtStr('current_position')],
      ['Wind', mtWind || null],
      ['Air Temp', mtStr('current_air_temperature')],
      ['Sea State', mtStr('current_sea_state')],
    ] as Array<[string, string | null]>
  ).filter((r): r is [string, string] => Boolean(r[1]));
  const ageMin = ts != null ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : null;
  const typeColor = shipType === 'MILITARY' ? '#FF1744' : shipType === 'TANKER' ? '#FF9500' : CYAN;

  return (
    <div className="space-y-3">
      {/* PHOTO GALLERY — MarineTraffic Pro, all photos when the sidecar answers */}
      {activePhoto && (
        <div className="space-y-1.5">
          <div className="relative border border-white/10 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mtProxied(activePhoto.url)}
              alt={label}
              className="w-full h-36 object-cover"
            />
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/90 to-transparent flex items-center justify-between gap-2">
              <span className="text-[7px] font-mono text-white/60 truncate">
                MARINETRAFFIC · {photoIdx + 1}/{mtPhotos.length}
              </span>
              <span className="text-[7px] font-mono font-bold tracking-widest shrink-0" style={{ color: CYAN }}>
                PRO
              </span>
            </div>
          </div>
          {mtPhotos.length > 1 && (
            <div className="flex gap-1 overflow-x-auto pb-0.5">
              {mtPhotos.map((ph, i) => (
                <button
                  key={ph.url}
                  onClick={() => setPhotoIdx(i)}
                  className="shrink-0 border overflow-hidden"
                  style={{ borderColor: i === photoIdx ? CYAN : 'rgba(255,255,255,0.1)' }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mtProxied(ph.thumb || ph.url)} alt="" className="w-12 h-8 object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* PHOTO BANNER — Wikimedia Commons fallback, when MT has nothing yet */}
      {!activePhoto && photo && !photoFailed && (
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
        <Cell label="MMSI" value={mmsi != null ? String(mmsi) : mtStr('mmsi') || '—'} />
        <Cell label="IMO" value={imo != null ? String(imo) : mtStr('imo') || '—'} />
        <Cell label="Flag State" value={flag ? flag.name : mtStr('flag') || '—'} />
        <Cell label="Size" value={length != null ? `${length} m × ${width != null ? `${width} m` : '?'}` : '—'} />
      </div>

      {/* MARINETRAFFIC PRO PARTICULARS */}
      {mtLoading && (
        <div className="flex items-center gap-2 bg-black/30 border border-white/5 px-3 py-2">
          <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: CYAN }} />
          <span className="text-[8px] font-mono tracking-[0.2em] uppercase animate-pulse" style={{ color: `${CYAN}B0` }}>
            MARINETRAFFIC PRO · PULLING DOSSIER…
          </span>
        </div>
      )}
      {proRows.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[8px] font-mono font-bold tracking-[0.25em] uppercase" style={{ color: CYAN }}>
            ▸ MARINETRAFFIC PRO
          </div>
          <div className="grid grid-cols-2 gap-2">
            {proRows.map(([k, v]) => (
              <Cell key={k} label={k} value={v} />
            ))}
          </div>
        </div>
      )}

      {/* SOURCE LINE + DETAILS LINK */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[8px] font-mono text-white/40 tracking-[0.15em] uppercase min-w-0">
          <Anchor className="w-3 h-3 shrink-0" style={{ color: `${CYAN}80` }} />
          <span className="truncate">
            {ageMin != null ? `RECEIVED ${ageMin === 0 ? 'JUST NOW' : `${ageMin} MIN AGO`} · ` : ''}AIS / AISSTREAM{mt ? ' + MT PRO' : ''}
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
