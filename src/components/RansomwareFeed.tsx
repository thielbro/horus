'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Skull, ChevronDown, ChevronUp, ExternalLink, MapPin, Search } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   HORUS — Ransomware Feed
   Live leak-site victim ticker (RansomLook). Geolocated victims
   carry a MapPin that flies the map to their server-IP location.
   ═══════════════════════════════════════════════════════════════ */

interface RansomwarePost {
  id: string;
  group: string;
  victim: string;
  sector?: string;
  discovered: string;
  country?: string;
  city?: string;
  lat?: number;
  lng?: number;
  link?: string;
  source?: string;
}

interface RansomwareFeedProps {
  data: any;
  onLocate?: (lat: number, lng: number) => void;
  /** A victim routed in from the map; opens the panel and highlights its post. `ts` lets a repeat click on the same victim re-trigger. */
  focus?: { id: string; ts: number } | null;
}

function timeAgo(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (!Number.isFinite(diff) || diff < 0) return '';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '';
  }
}

// Deterministic accent per group so the eye can track a campaign down the list.
function groupColor(group: string): string {
  let h = 0;
  for (let i = 0; i < group.length; i++) h = (h * 31 + group.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 62%)`;
}

export default function RansomwareFeed({ data, focus, onLocate }: RansomwareFeedProps) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState('');

  const rawPosts = data?.ransomware_posts;
  const focusId = focus?.id;
  const focusTs = focus?.ts;
  const posts: RansomwarePost[] = useMemo(
    () => (Array.isArray(rawPosts) ? rawPosts : []),
    [rawPosts],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter(
      (p) =>
        p.victim?.toLowerCase().includes(q) ||
        p.group?.toLowerCase().includes(q) ||
        p.sector?.toLowerCase().includes(q),
    );
  }, [posts, query]);

  const geoCount = useMemo(() => posts.filter((p) => p.lat != null).length, [posts]);

  // The rendered window. When a victim is routed in from the map but falls outside
  // the first 60 rows, splice it in at the top so its row exists to scroll to.
  const visible = useMemo(() => {
    const base = filtered.slice(0, 60);
    if (focusId && !base.some((p) => p.id === focusId)) {
      const extra = filtered.find((p) => p.id === focusId);
      if (extra) return [extra, ...base];
    }
    return base;
  }, [filtered, focusId]);

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // A map dot was clicked: expand, clear any filter, then scroll to and flash the post.
  useEffect(() => {
    if (!focusId) return;
    setExpanded(true);
    setQuery('');
    setHighlightId(focusId);
    const scrollT = setTimeout(() => {
      rowRefs.current[focusId]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 160);
    const clearT = setTimeout(() => setHighlightId(null), 2600);
    return () => { clearTimeout(scrollT); clearTimeout(clearT); };
  }, [focusId, focusTs]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5 }}
      className="glass-panel flex flex-col overflow-hidden pointer-events-auto"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Skull className="w-3.5 h-3.5 text-[#FF6B6B]" />
          <span className="hud-text text-[12px] text-[var(--text-primary)]">RANSOMWARE FEED</span>
          <span className="gotham-tag gotham-tag--critical" style={{ fontSize: '8px', padding: '1px 5px' }}>{posts.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#FF3D3D] animate-horus-pulse" />
          {expanded ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            {/* Search + geo summary */}
            <div className="px-3 pb-2 flex items-center gap-2">
              <div className="flex items-center gap-1.5 flex-1 bg-[var(--bg-tertiary)] rounded px-2 py-1">
                <Search className="w-3 h-3 text-[var(--text-muted)]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter victim / group / sector"
                  className="bg-transparent outline-none text-[10px] font-mono text-[var(--text-primary)] w-full placeholder:text-[var(--text-muted)]"
                />
              </div>
              <span className="text-[8px] font-mono text-[var(--text-muted)] whitespace-nowrap" title="victims placed on the map by server IP">
                {geoCount} mapped
              </span>
            </div>

            <div className="max-h-[420px] overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]">
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <span className="text-[11px] font-mono text-[var(--text-muted)] tracking-widest">
                    {posts.length === 0 ? 'AWAITING LEAK-SITE POSTS…' : 'NO MATCHES'}
                  </span>
                </div>
              ) : (
                visible.map((p) => {
                  const placed = p.lat != null && p.lng != null;
                  return (
                    <div
                      key={p.id}
                      ref={(el) => { rowRefs.current[p.id] = el; }}
                      role="button"
                      tabIndex={0}
                      className="px-4 py-2.5 hover:bg-[var(--hover-accent)] transition-colors cursor-pointer"
                      style={highlightId === p.id ? { background: 'rgba(255,107,107,0.10)', boxShadow: 'inset 0 0 0 1px rgba(255,107,107,0.55)' } : undefined}
                      onClick={() => { if (p.link) window.open(p.link, '_blank', 'noopener,noreferrer'); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && p.link) window.open(p.link, '_blank', 'noopener,noreferrer'); }}
                    >
                      {/* Top row: group + geo/time */}
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="text-[9px] font-mono font-bold tracking-widest uppercase truncate max-w-[120px]"
                          style={{ color: groupColor(p.group) }}
                          title={p.group}
                        >
                          {p.group}
                        </span>
                        {placed && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onLocate?.(p.lat as number, p.lng as number); }}
                            className="text-[var(--text-muted)] hover:text-[var(--cyan-primary)] transition-colors"
                            title={[p.city, p.country].filter(Boolean).join(', ') || 'Locate on map'}
                          >
                            <MapPin className="w-2.5 h-2.5" />
                          </button>
                        )}
                        <span className="text-[8px] font-mono text-[var(--text-muted)] ml-auto">{timeAgo(p.discovered)}</span>
                      </div>

                      {/* Victim */}
                      <h4 className="text-[11px] text-[var(--text-primary)] leading-tight line-clamp-2 break-words">{p.victim}</h4>

                      {/* Sector / location / link */}
                      <div className="mt-1 flex items-center gap-2 flex-wrap">
                        {p.sector && (
                          <span className="text-[8px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
                            {p.sector}
                          </span>
                        )}
                        {(p.city || p.country) && (
                          <span className="text-[8px] font-mono text-[var(--text-muted)]">
                            {[p.city, p.country].filter(Boolean).join(', ')}
                          </span>
                        )}
                        {p.link && (
                          <span className="flex items-center gap-1 text-[8px] font-mono text-[#FF6B6B]/80 ml-auto">
                            <ExternalLink className="w-2.5 h-2.5" /> LEAK
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
