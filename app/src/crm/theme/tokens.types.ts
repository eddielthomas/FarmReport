// =============================================================================
// RWR CRM — Token types (S7A)
// -----------------------------------------------------------------------------
// String-literal unions over every token name declared in `tokens.css` so
// primitives that reference tokens (e.g. KpiCard's `tint` prop) get typed
// autocomplete and can't drift from the source of truth.
// =============================================================================

export type SurfaceMode = 'light' | 'dark';

// ---- COLOR ------------------------------------------------------------------
export type ColorToken =
  | 'bg' | 'bg-elevated'
  | 'surface' | 'surface-elevated' | 'surface-sunken' | 'surface-inverted'
  | 'fg' | 'fg-muted' | 'fg-subtle' | 'fg-inverted' | 'fg-on-accent'
  | 'accent' | 'accent-strong' | 'accent-soft' | 'accent-glow'
  | 'cyan' | 'cyan-soft'
  | 'red' | 'red-soft' | 'orange' | 'yellow' | 'green' | 'blue'
  | 'border' | 'border-strong' | 'border-inverted'
  | 'ring' | 'ring-accent' | 'overlay';

// Subset usable as the `tint` prop on KpiCard / MetricArc / BrandMark — these
// are the brand-significant accents only.
export type TintToken = 'accent' | 'cyan' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'fg';

// ---- TYPOGRAPHY -------------------------------------------------------------
export type FontFamilyToken = 'font-sans' | 'font-mono' | 'font-display';

export type FontWeightToken =
  | 'font-weight-300' | 'font-weight-400' | 'font-weight-500'
  | 'font-weight-600' | 'font-weight-700' | 'font-weight-800';

export type FontSizeToken =
  | 'font-size-2xs' | 'font-size-xs'  | 'font-size-sm'
  | 'font-size-base' | 'font-size-md' | 'font-size-lg'
  | 'font-size-xl' | 'font-size-2xl' | 'font-size-3xl'
  | 'font-size-4xl' | 'font-size-5xl' | 'font-size-6xl'
  | 'font-size-7xl' | 'font-size-8xl' | 'font-size-9xl';

export type LineHeightToken = 'line-height-tight' | 'line-height-snug' | 'line-height-normal' | 'line-height-relaxed';

export type TrackingToken = 'tracking-tight' | 'tracking-normal' | 'tracking-wide' | 'tracking-wider' | 'tracking-widest';

// ---- LAYOUT -----------------------------------------------------------------
export type SpaceToken =
  | 'space-0' | 'space-1' | 'space-2' | 'space-3' | 'space-4' | 'space-5'
  | 'space-6' | 'space-7' | 'space-8' | 'space-9' | 'space-10'
  | 'space-12' | 'space-14' | 'space-16' | 'space-20' | 'space-24';

export type RadiusToken =
  | 'radius-none' | 'radius-sm' | 'radius-md' | 'radius-lg'
  | 'radius-xl' | 'radius-2xl' | 'radius-3xl' | 'radius-full';

export type ShadowToken =
  | 'shadow-soft' | 'shadow-card' | 'shadow-popover' | 'shadow-overlay' | 'shadow-accent';

// ---- MOTION -----------------------------------------------------------------
export type DurationToken =
  | 'duration-instant' | 'duration-fast' | 'duration-normal'
  | 'duration-slow' | 'duration-slower';

export type EasingToken =
  | 'easing-standard' | 'easing-emphasis' | 'easing-enter' | 'easing-exit' | 'easing-linear';

// ---- Z-INDEX ----------------------------------------------------------------
export type ZIndexToken =
  | 'z-base' | 'z-raised' | 'z-sticky'
  | 'z-dropdown' | 'z-overlay' | 'z-modal' | 'z-toast' | 'z-tooltip';

// ---- Union of every token name (used for sanity assertions) ------------------
export type AnyToken =
  | ColorToken | FontFamilyToken | FontWeightToken | FontSizeToken
  | LineHeightToken | TrackingToken | SpaceToken | RadiusToken
  | ShadowToken | DurationToken | EasingToken | ZIndexToken;

/**
 * Build a `var(--token)` CSS reference string in a type-safe way.
 *
 * ```ts
 * import { tokenVar } from '@crm/theme/tokens.types';
 * const style = { background: tokenVar('accent') };
 * ```
 */
export function tokenVar<T extends AnyToken>(name: T): string {
  return `var(--${name})`;
}
