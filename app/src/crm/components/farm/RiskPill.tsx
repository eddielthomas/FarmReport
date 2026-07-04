// =============================================================================
// RiskPill / RiskLegend — semantic vegetation/risk severity chips.
// -----------------------------------------------------------------------------
// HARD RULE (from DESIGN_SYSTEM.md): a risk color NEVER carries meaning alone.
// Every pill ships color + icon + text label. Adjacent ramp stops sit in the
// colorblind "floor" band by design, so the label/icon pairing is enforced
// here at the component boundary — callers cannot render color-only.
// =============================================================================

import * as React from 'react';
import { Sprout, Leaf, TriangleAlert, Flame, OctagonAlert, CircleDashed } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import type { RiskBand } from '@crm/lib/farm-types';

interface BandMeta {
  label: string;
  token: string;       // --risk-* (text/stroke-safe)
  fill: string;        // --risk-*-fill (saturated chip)
  Icon: React.FC<{ className?: string }>;
}

const BAND: Record<RiskBand, BandMeta> = {
  healthy:  { label: 'Healthy',  token: 'var(--risk-healthy)',  fill: 'var(--risk-healthy-fill)',  Icon: Sprout },
  watch:    { label: 'Watch',    token: 'var(--risk-watch)',    fill: 'var(--risk-watch-fill)',    Icon: Leaf },
  stress:   { label: 'Stress',   token: 'var(--risk-stress)',   fill: 'var(--risk-stress-fill)',   Icon: TriangleAlert },
  high:     { label: 'High',     token: 'var(--risk-high)',     fill: 'var(--risk-high-fill)',     Icon: Flame },
  critical: { label: 'Critical', token: 'var(--risk-critical)', fill: 'var(--risk-critical-fill)', Icon: OctagonAlert },
};

export function RiskPill({
  band,
  score,
  className,
  size = 'md',
}: {
  band: RiskBand | null;
  score?: number | null;
  className?: string;
  size?: 'sm' | 'md';
}) {
  // No band yet → honest "unmonitored" state, never a fake healthy green.
  if (!band) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--border)]',
          'bg-[var(--surface-sunken)] text-[var(--fg-subtle)] font-medium',
          size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]',
          className,
        )}
      >
        <CircleDashed className="size-3.5" />
        Unmonitored
      </span>
    );
  }

  const m = BAND[band];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] font-semibold',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]',
        className,
      )}
      style={{
        color: m.token,
        background: `color-mix(in oklch, ${m.fill} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${m.token} 34%, transparent)`,
      }}
      title={score != null ? `${m.label} · risk ${Math.round(score)}/100` : m.label}
    >
      <m.Icon className="size-3.5" />
      {m.label}
      {score != null && (
        <span className="tabular-nums opacity-70">{Math.round(score)}</span>
      )}
    </span>
  );
}

/** Ordered legend — makes the ramp meaning explicit on any map/heatmap surface. */
export function RiskLegend({ className }: { className?: string }) {
  const order: RiskBand[] = ['healthy', 'watch', 'stress', 'high', 'critical'];
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
      {order.map((b) => {
        const m = BAND[b];
        return (
          <span key={b} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ background: m.fill, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${m.token} 40%, transparent)` }}
            />
            {m.label}
          </span>
        );
      })}
    </div>
  );
}
