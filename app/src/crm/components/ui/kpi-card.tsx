// =============================================================================
// KpiCard — the big-number KPI tile (S7A)
// -----------------------------------------------------------------------------
// Matches the "Processed Items / Anomalies / Utilization" tiles in the concept
// boards. Anatomy (top to bottom):
//   • Header row     — icon + label, optional top-right arrow action.
//   • Hero number    — large Urbanist 600 weight, ~56-64 px.
//   • Sub-stats row  — two-column primary/secondary stats.
//   • Footnote / strip — optional thin bar or sparkline.
//
// Props are intentionally composable so S7B can drop charts into `chart` or
// arc gauges into `aside`.
// =============================================================================

import * as React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import type { TintToken } from '@crm/theme/tokens.types';

export interface KpiSubStat {
  label: string;
  value: React.ReactNode;
  align?: 'left' | 'right';
}

export interface KpiCardProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  /** Optional superscript symbol after `value` (e.g. `%`). */
  unit?: React.ReactNode;
  primary?: KpiSubStat;
  secondary?: KpiSubStat;
  /** Bottom strip — pass a sparkline, progress bar, or null. */
  chart?: React.ReactNode;
  /** Right-side adornment (e.g. <MetricArc/>). Replaces the default layout. */
  aside?: React.ReactNode;
  /** Optional tint applied to chart fill, arrow icon, etc. */
  tint?: TintToken;
  onAction?: () => void;
  footnote?: React.ReactNode;
}

function tintVar(t?: TintToken): string {
  return `var(--${t ?? 'accent'})`;
}

export function KpiCard({
  icon,
  label,
  value,
  unit,
  primary,
  secondary,
  chart,
  aside,
  tint,
  onAction,
  footnote,
  className,
  ...rest
}: KpiCardProps) {
  const accent = tintVar(tint);

  return (
    <div
      className={cn(
        'group relative rounded-[var(--radius-2xl)] border border-[var(--border)]',
        'bg-[var(--surface)] text-[var(--fg)]',
        'shadow-[var(--shadow-card)] p-5 flex flex-col gap-4',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        className,
      )}
      role="group"
      aria-label={typeof label === 'string' ? label : undefined}
      {...rest}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-muted)]">
          {icon && (
            <span
              className="grid place-items-center size-6 rounded-[var(--radius-sm)]"
              style={{ color: 'var(--fg)' }}
            >
              {icon}
            </span>
          )}
          <span>{label}</span>
        </div>
        {onAction && (
          <button
            type="button"
            onClick={onAction}
            aria-label="Open details"
            className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
          >
            <ArrowUpRight className="size-3.5" />
          </button>
        )}
      </div>

      {/* Hero + optional aside */}
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-1">
          <span className="text-[44px] sm:text-[56px] leading-[1.0] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
            {value}
          </span>
          {unit && (
            <span className="text-[16px] font-medium text-[var(--fg-muted)] translate-y-[-12px]">
              {unit}
            </span>
          )}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>

      {/* Sub-stats row */}
      {(primary || secondary) && (
        <div className="flex items-end justify-between gap-4">
          {primary && (
            <div className={cn('flex flex-col', primary.align === 'right' && 'items-end ml-auto')}>
              <span className="text-[16px] font-semibold text-[var(--fg)] leading-tight">
                {primary.value}
              </span>
              <span className="text-[11px] text-[var(--fg-muted)]">{primary.label}</span>
            </div>
          )}
          {secondary && (
            <div className={cn('flex flex-col items-end', secondary.align === 'left' && 'items-start mr-auto')}>
              <span className="text-[16px] font-semibold text-[var(--fg)] leading-tight">
                {secondary.value}
              </span>
              <span className="text-[11px] text-[var(--fg-muted)]">{secondary.label}</span>
            </div>
          )}
        </div>
      )}

      {/* Optional bottom strip — sparkline / progress / hash marks */}
      {chart && (
        <div className="mt-1" style={{ color: accent }}>
          {chart}
        </div>
      )}

      {footnote && <div className="text-[11px] text-[var(--fg-subtle)]">{footnote}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------
// KpiStrip — small reusable progress strip (the "auto-processed / pending"
// black-and-lime bar at the bottom of each KPI card). Exported here so callers
// can drop one inline as `<KpiCard chart={<KpiStrip value={62} />} />`.
// -----------------------------------------------------------------------------
export function KpiStrip({
  value,
  max = 100,
  tint,
  className,
}: {
  value: number;
  max?: number;
  tint?: TintToken;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const accent = tintVar(tint);
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className={cn(
        'relative h-1.5 w-full rounded-[var(--radius-full)] bg-[var(--surface-sunken)] overflow-hidden',
        className,
      )}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-[var(--radius-full)]"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(90deg, var(--fg) 0%, var(--fg) 35%, ${accent} 35%, ${accent} 100%)`,
        }}
      />
    </div>
  );
}
