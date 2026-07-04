// =============================================================================
// TechMarker — pulsing marker for a live technician position (S9B).
// -----------------------------------------------------------------------------
// Renders as a positioned <div> with a colored pulsing dot. Used by:
//   * FieldOpsPanel mini-map (managers)
//   * MapTab (techs) — for OTHER techs visible on shared jobs
//
// Color encodes inferred_status (see field-types). Pulse animates only when
// the tech is actively moving (en_route / on_site / in_progress).
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';
import { type FieldTechPosition } from '@crm/lib/field-types';

export function techStatusColor(status: FieldTechPosition['inferred_status'] | undefined): string {
  switch (status) {
    case 'en_route':            return 'var(--blue)';
    case 'on_site':             return 'var(--green)';
    case 'far_drift':           return 'var(--orange)';
    case 'spoofing_suspected':  return 'var(--red)';
    case 'idle':
    default:                    return 'var(--fg-subtle)';
  }
}

interface TechMarkerProps {
  position:    FieldTechPosition;
  size?:       number;
  pulse?:      boolean;
  showLabel?:  boolean;
  onClick?:    () => void;
}

export function TechMarker({
  position, size = 14, pulse = true, showLabel = false, onClick,
}: TechMarkerProps) {
  const color   = techStatusColor(position.inferred_status);
  const initial = (position.display_name ?? position.email ?? '?').trim().charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${position.display_name ?? 'Technician'} — ${position.inferred_status ?? 'idle'}`}
      className={cn(
        'relative inline-flex items-center gap-2 group',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-accent)]',
      )}
    >
      <span
        aria-hidden="true"
        className="block rounded-[var(--radius-full)]"
        style={{
          width: size,
          height: size,
          background: color,
          boxShadow: `0 0 0 ${Math.max(2, Math.floor(size / 6))}px color-mix(in oklch, ${color} 24%, transparent), 0 0 0 ${Math.max(4, Math.floor(size / 3))}px color-mix(in oklch, ${color} 10%, transparent)`,
          animation: pulse ? `tech-pulse 1800ms ease-in-out infinite` : undefined,
        }}
      />
      {showLabel && (
        <span className="grid place-items-center size-5 rounded-[var(--radius-full)] bg-[var(--surface)] border border-[var(--border)] text-[10px] font-semibold text-[var(--fg)]">
          {initial}
        </span>
      )}
      <style>{`
        @keyframes tech-pulse {
          0%   { transform: scale(1);   opacity: 1;   }
          50%  { transform: scale(1.18); opacity: 0.85; }
          100% { transform: scale(1);   opacity: 1;   }
        }
      `}</style>
    </button>
  );
}
