// =============================================================================
// MetricArc — semicircle gauge (S7A)
// -----------------------------------------------------------------------------
// The 71,74% arc gauge from the Synced Records concept tile. Pure SVG, no
// chart-library dependency. The fill animates on mount with a single CSS
// transition and respects `prefers-reduced-motion` because the duration token
// it consumes collapses to 0 ms under that media query.
//
// Props
//   value   — number, 0..max
//   max     — number, default 100
//   label   — optional caption rendered under the arc
//   tint    — token name (default `'accent'`)
//   size    — px (default 160) — gauge is square; the bottom-half is the arc
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';
import type { TintToken } from '@crm/theme/tokens.types';

export interface MetricArcProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  label?: React.ReactNode;
  tint?: TintToken;
  /** Outer width / height (the arc occupies the lower half). Default 160px. */
  size?: number;
  /** Stroke width in px. Default 12. */
  thickness?: number;
  /** Render the percentage label inside the arc. Default true. */
  showValue?: boolean;
}

export function MetricArc({
  value,
  max = 100,
  label,
  tint = 'accent',
  size = 160,
  thickness = 12,
  showValue = true,
  className,
  ...rest
}: MetricArcProps) {
  const clamped = Math.max(0, Math.min(value, max));
  const pct = clamped / max;

  // Half-circle path math — render an arc from 180° → 360° (top-left → top-right
  // travelling through the bottom). Path length must be stable so the
  // strokeDashoffset interpolation is deterministic.
  const radius   = (size - thickness) / 2;
  const cx       = size / 2;
  const cy       = size / 2;
  const arcLen   = Math.PI * radius;                  // half-circumference

  const arcPath = `M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`;
  const offset  = arcLen * (1 - pct);
  const accent  = `var(--${tint})`;

  return (
    <div
      className={cn('inline-flex flex-col items-center', className)}
      role="img"
      aria-label={typeof label === 'string' ? label : `${Math.round(pct * 100)}%`}
      style={{ width: size, height: size / 2 + (showValue ? 28 : 8) }}
      {...rest}
    >
      <svg
        width={size}
        height={size / 2 + thickness / 2}
        viewBox={`0 0 ${size} ${size / 2 + thickness}`}
        className="overflow-visible"
        aria-hidden="true"
      >
        {/* Track */}
        <path
          d={arcPath}
          stroke="var(--surface-sunken)"
          strokeWidth={thickness}
          fill="none"
          strokeLinecap="round"
        />
        {/* Filled portion (animated via stroke-dashoffset) */}
        <path
          d={arcPath}
          stroke={accent}
          strokeWidth={thickness}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={arcLen}
          strokeDashoffset={offset}
          style={{
            transition: `stroke-dashoffset var(--duration-slow) var(--easing-emphasis)`,
          }}
        />
        {/* Tip dot — matches the "ball at the arc's end" detail from the concepts */}
        <circle
          cx={cx + Math.cos(Math.PI + pct * Math.PI) * radius}
          cy={cy + Math.sin(Math.PI + pct * Math.PI) * radius}
          r={thickness * 0.5}
          fill={accent}
        />
      </svg>
      {showValue && (
        <div className="-mt-2 flex items-baseline gap-0.5">
          <span className="text-[28px] sm:text-[34px] leading-none font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
            {(pct * 100).toFixed(2).replace('.', ',')}
          </span>
          <span className="text-[12px] font-medium text-[var(--fg-muted)]">%</span>
        </div>
      )}
      {label && <div className="mt-1 text-[11px] text-[var(--fg-muted)]">{label}</div>}
    </div>
  );
}
