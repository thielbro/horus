import type { ComponentType } from 'react';
import {
  Plane, Satellite, Activity, Sun, AlertTriangle, Camera, Flame,
  CloudLightning, Radiation, Tv, Anchor, Ship, Radio, Eye,
} from 'lucide-react';

type IconComponent = ComponentType<{ className?: string }>;

// Hand-rolled Shield — lucide-react @1.x in this project does not export it cleanly
// (LayerPanel inlines the same SVG), so we replicate it to guarantee visual parity.
function Shield(props: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

const ICONS: Record<string, IconComponent> = {
  Plane, Satellite, Activity, Sun, AlertTriangle, Camera, Flame,
  CloudLightning, Radiation, Tv, Anchor, Ship, Radio, Eye, Shield,
};

/** Resolve a registry icon name to a component; falls back to Shield for unknown names. */
export function resolveIcon(name?: string): IconComponent {
  return (name && ICONS[name]) || Shield;
}
