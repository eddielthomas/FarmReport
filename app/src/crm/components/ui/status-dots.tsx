// =============================================================================
// StatusDots — 5-dot lead-score row (S7A)
// -----------------------------------------------------------------------------
// The 5-colored-dots row from the Workspace concept (red, orange, yellow, cyan,
// green — left → right) used to indicate lead interest level. Dots below the
// `score` index are filled; the rest are ghosted to the same hue at low alpha.
//
// Props
//   score    — number, 0..5  (0 = none filled, 5 = all filled)
//   palette  — array of 5 token names (defaults to the concept ramp)
//   size     — px, default 8
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';
import type { TintToken } from '@crm/theme/tokens.types';

export const DEFAULT_PALETTE: ReadonlyArray<TintToken> = [
  'red', 'orange', 'yellow', 'cyan', 'green',
];

export interface StatusDotsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of dots filled (0..5). Values outside the range are clamped. */
  score: number;
  /** 5 token names left-to-right. Defaults to red→orange→yellow→cyan→green. */
  palette?: ReadonlyArray<TintToken>;
  /** Pixel diameter of each dot. Default 8. */
  size?: number;
  /** ARIA label for the group. */
  'aria-label'?: string;
}

export function StatusDots({
  score,
  palette = DEFAULT_PALETTE,
  size = 8,
  className,
  'aria-label': ariaLabel,
  ...rest
}: StatusDotsProps) {
  const filled = Math.max(0, Math.min(palette.length, Math.round(score)));
  const label  = ariaLabel ?? `Score ${filled} of ${palette.length}`;

  return (
    <div
      role="meter"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={palette.length}
      aria-label={label}
      className={cn('inline-flex items-center gap-1', className)}
      {...rest}
    >
      {palette.map((tint, i) => {
        const on = i < filled;
        return (
          <span
            key={`${tint}-${i}`}
            aria-hidden="true"
            className="inline-block rounded-[var(--radius-full)] transition-colors duration-[var(--duration-fast)]"
            style={{
              width:  size,
              height: size,
              background: on
                ? `var(--${tint})`
                : `color-mix(in oklch, var(--${tint}) 14%, transparent)`,
              border: on ? 'none' : '1px solid var(--border)',
            }}
          />
        );
      })}
    </div>
  );
}
