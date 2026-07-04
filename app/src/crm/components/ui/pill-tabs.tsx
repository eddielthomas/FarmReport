// =============================================================================
// PillTabs — pill-style tab control (S7A)
// -----------------------------------------------------------------------------
// Matches the "Overview / Analytics / Companies / Documents / Calculator" tab
// row from the Sales Dashboard concept. The active tab gets a solid pill
// (black on light, white on dark) with inverted text; inactive tabs are quiet
// labels.
//
// Keyboard: ArrowLeft / ArrowRight cycles focus; Home / End jumps to ends.
// Roles: `tablist` + `tab` per ARIA Authoring Practices.
// =============================================================================

import * as React from 'react';
import { cn } from '@crm/lib/utils';

export interface PillTabItem<TKey extends string = string> {
  key:    TKey;
  label:  React.ReactNode;
  icon?:  React.ReactNode;
  disabled?: boolean;
}

export interface PillTabsProps<TKey extends string = string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value:    TKey;
  onChange: (key: TKey) => void;
  items:    ReadonlyArray<PillTabItem<TKey>>;
  /** "lg" (default) — concept-board size · "sm" — compact rows */
  size?: 'sm' | 'md' | 'lg';
  /** "ink" (default) — solid `--fg` pill · "accent" — lime pill */
  tone?: 'ink' | 'accent';
  /** ARIA label for the tablist. */
  'aria-label'?: string;
}

export function PillTabs<TKey extends string = string>({
  value,
  onChange,
  items,
  size = 'lg',
  tone = 'ink',
  className,
  ...rest
}: PillTabsProps<TKey>) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  function focusAt(idx: number) {
    const next = ((idx % items.length) + items.length) % items.length;
    refs.current[next]?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = items.findIndex((it) => it.key === value);
    if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(i + 1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); focusAt(i - 1); }
    if (e.key === 'Home')       { e.preventDefault(); focusAt(0); }
    if (e.key === 'End')        { e.preventDefault(); focusAt(items.length - 1); }
  }

  const dims = {
    sm: 'h-8 px-3 text-[12px]',
    md: 'h-9 px-4 text-[13px]',
    lg: 'h-10 px-5 text-[14px]',
  }[size];

  return (
    <div
      role="tablist"
      onKeyDown={onKey}
      // max-w-full + overflow-x-auto: on narrow viewports the strip swipes
      // horizontally instead of clipping tabs past the screen edge (vendor /
      // sales at 375px). Scrollbar hidden — touch/keyboard still scroll it.
      className={cn(
        'inline-flex items-center gap-1 max-w-full overflow-x-auto overscroll-x-contain',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...rest}
    >
      {items.map((it, idx) => {
        const active = it.key === value;
        return (
          <button
            key={it.key}
            ref={(el) => { refs.current[idx] = el; }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={it.disabled}
            onClick={() => !it.disabled && onChange(it.key)}
            className={cn(
              'inline-flex items-center gap-2 rounded-[var(--radius-full)]',
              'shrink-0 whitespace-nowrap',
              'font-medium tracking-normal',
              'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
              dims,
              active
                ? tone === 'accent'
                  ? 'bg-[var(--accent)] text-[var(--fg-on-accent)] shadow-[var(--shadow-card)] focus-visible:ring-[var(--ring-accent)]'
                  : 'bg-[var(--fg)] text-[var(--fg-inverted)] shadow-[var(--shadow-card)] focus-visible:ring-[var(--ring)]'
                : 'bg-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] focus-visible:ring-[var(--ring)]',
              it.disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
