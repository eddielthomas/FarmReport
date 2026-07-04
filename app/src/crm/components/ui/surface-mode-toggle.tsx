// =============================================================================
// SurfaceModeToggle — light ↔ dark toggle button (S7A)
// -----------------------------------------------------------------------------
// Drops into TopNav or the user menu. Reads + writes the surface store, so it
// also persists across reloads via the store's `persist` middleware.
//
// Renders Sun (light mode) or Moon (dark mode) — pressing the button always
// switches to the OTHER mode, so the visible icon represents the active mode.
//
// ARIA: `role="switch"` with `aria-checked` reflecting dark state. Native
// keyboard activation (Space / Enter) works because we keep the underlying
// element a real `<button>`.
// =============================================================================

import * as React from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { useSurfaceMode } from '@crm/lib/surface-store';

export interface SurfaceModeToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Compact icon-only variant (matches TopNav). */
  compact?: boolean;
}

export function SurfaceModeToggle({
  compact = true,
  className,
  ...rest
}: SurfaceModeToggleProps) {
  const { mode, toggle } = useSurfaceMode();
  const isDark = mode === 'dark';
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={label}
      title={label}
      onClick={(e) => {
        toggle();
        rest.onClick?.(e);
      }}
      className={cn(
        'inline-flex items-center justify-center gap-2',
        'rounded-[var(--radius-full)]',
        'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        'hover:bg-[var(--surface-sunken)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        compact ? 'size-9' : 'h-9 px-3 text-[12px]',
        className,
      )}
    >
      {/* Sun is "currently light"; Moon is "currently dark" */}
      {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      {!compact && <span>{isDark ? 'Dark' : 'Light'}</span>}
    </button>
  );
}
