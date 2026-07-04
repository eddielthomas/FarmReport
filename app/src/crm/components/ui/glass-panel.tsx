// =============================================================================
// GlassPanel — "Account Insights" frosted-glass hero (S7A)
// -----------------------------------------------------------------------------
// The signature green-frosted hero block from the Overview Panel concept. The
// front panel renders normally with a backdrop-filter blur and a lime tint;
// two ghosted backplanes offset by ~16-20 px give the stacked-cards-from-a-deck
// look. Works on both light and dark surfaces because the panel paints its own
// background via `color-mix` against `--surface`.
//
// Props
//   title      — bold header line ("Account Insights")
//   kicker     — small icon / label rendered above the title
//   stackSize  — how many ghost backplanes to draw (default 2 → 3 cards total)
//   tint       — accent color (default `--accent`)
//   onAction   — optional arrow-icon click handler (top-right launch)
// =============================================================================

import * as React from 'react';
import { ArrowUpRight, Zap } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  title: React.ReactNode;
  kicker?: React.ReactNode;
  /** Number of ghost backplanes drawn behind the main panel. Default 2. */
  stackSize?: number;
  /** Lime by default; pass any token-aware color (e.g. `var(--cyan)`) */
  tint?: string;
  onAction?: () => void;
}

export function GlassPanel({
  title,
  kicker,
  children,
  stackSize = 2,
  tint = 'var(--accent)',
  onAction,
  className,
  ...rest
}: GlassPanelProps) {
  // Pre-compute ghost offsets so they don't re-render on every paint.
  const ghosts = React.useMemo(
    () => Array.from({ length: Math.max(0, stackSize) }, (_, i) => i + 1),
    [stackSize],
  );

  return (
    <div className={cn('relative isolate', className)} {...rest}>
      {/* Ghost backplanes — each successive plane is offset diagonally and
          its opacity steps down so the stack reads as motion-blurred copies. */}
      {ghosts.map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="absolute rounded-[var(--radius-2xl)] pointer-events-none"
          style={{
            inset: 0,
            transform: `translate(${i * 18}px, -${i * 4}px)`,
            background: `linear-gradient(135deg, ${tint} 0%, color-mix(in oklch, ${tint} 22%, transparent) 100%)`,
            opacity: 0.55 - (i - 1) * 0.18,
            filter: 'blur(2px)',
            zIndex: 0,
          }}
        />
      ))}

      {/* Front panel */}
      <div
        className={cn(
          'relative z-10 rounded-[var(--radius-2xl)] p-5',
          'border border-[var(--border)]',
          'text-[var(--fg)]',
          'shadow-[var(--shadow-card)]',
        )}
        style={{
          background: `linear-gradient(135deg, ${tint} 0%, color-mix(in oklch, ${tint} 55%, var(--surface)) 100%)`,
          backdropFilter: 'blur(24px) saturate(140%)',
          WebkitBackdropFilter: 'blur(24px) saturate(140%)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-on-accent)]/85">
            {kicker ?? <Zap className="size-3.5" />}
            <span>{kicker == null ? 'Account Insights' : null}</span>
          </div>
          {onAction && (
            <button
              type="button"
              onClick={onAction}
              aria-label="Open insights"
              className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--fg)]/8 hover:bg-[var(--fg)]/16 transition-colors duration-[var(--duration-fast)]"
            >
              <ArrowUpRight className="size-3.5 text-[var(--fg-on-accent)]" />
            </button>
          )}
        </div>
        <h3 className="mt-3 text-[24px] leading-[1.2] font-semibold text-[var(--fg-on-accent)] tracking-[var(--tracking-tight)]">
          {title}
        </h3>
        {children && <div className="mt-2 text-[14px] text-[var(--fg-on-accent)]/85">{children}</div>}
      </div>
    </div>
  );
}
