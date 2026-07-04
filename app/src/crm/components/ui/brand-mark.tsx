// =============================================================================
// BrandMark — 4-pointed spark / star logo (S7A)
// -----------------------------------------------------------------------------
// Inline SVG mark used in TopNav, login page, and the AI-Assistant "Daxa"
// avatar bubble in the concept boards. Tint defaults to `--accent`. The shape
// is a 4-pointed "spark" (two crossed leaves) inscribed in a rounded square.
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';

export interface BrandMarkProps extends React.SVGAttributes<SVGElement> {
  /** Pixel size of the square mark. Default 28. */
  size?: number;
  /** Token name or raw CSS color. Defaults to `var(--accent)`. */
  tint?: string;
  /** Render the spark inside a rounded-square plate (matches the concept). */
  plated?: boolean;
}

export function BrandMark({
  size = 28,
  tint = 'var(--accent)',
  plated = true,
  className,
  ...rest
}: BrandMarkProps) {
  const r = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Report.Farm"
      className={cn('shrink-0', className)}
      {...rest}
    >
      {plated && (
        <rect x="2" y="2" width="96" height="96" rx="24" ry="24" fill={tint} />
      )}
      {/* 4-pointed spark: two diamond leaves rotated 45deg */}
      <g
        fill={plated ? 'var(--fg-on-accent)' : tint}
        transform={`translate(${plated ? 0 : 0} ${plated ? 0 : 0})`}
      >
        <path d="M50 14 C50 32, 68 50, 86 50 C68 50, 50 68, 50 86 C50 68, 32 50, 14 50 C32 50, 50 32, 50 14 Z" />
      </g>
      {/* Subtle inner highlight on the plate */}
      {plated && (
        <rect
          x="2"
          y="2"
          width="96"
          height="96"
          rx="24"
          ry="24"
          fill="none"
          stroke="var(--fg)"
          strokeOpacity="0.06"
          strokeWidth="1"
        />
      )}
      {/* anchor for accessibility — circular radius accent */}
      <circle cx="80" cy="20" r="3" fill="var(--fg)" opacity={plated ? 0.18 : 0} />
      <title>Report.Farm</title>
      <desc>Report.Farm brand mark — {r * 2}px</desc>
    </svg>
  );
}
