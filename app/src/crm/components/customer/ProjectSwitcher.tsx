// =============================================================================
// ProjectSwitcher — chip strip at the top of the customer portal.
// -----------------------------------------------------------------------------
// Sprint 14C.  Renders one chip per project the caller can see.  We only
// render when projects.length > 1 — the parent skips this component when the
// customer has a single project (no decision to make) or zero (fall-through to
// legacy lead lookup).
//
// Keyboard / a11y:
//   • role="tablist" with the chips as role="tab"
//   • arrow-key navigation moves focus along the strip
//   • Enter / Space activates a chip
//   • ≥44 px tap targets for mobile, horizontal touch scroll
// =============================================================================

import { useRef } from 'react';
import { cn } from '@crm/lib/utils';
import type { CustomerProject } from '@crm/lib/customer-scenes';

interface ProjectSwitcherProps {
  projects:  CustomerProject[];
  activeId?: string;
  onPick:    (id: string) => void;
}

export function ProjectSwitcher({ projects, activeId, onPick }: ProjectSwitcherProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = projects.length;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % n;
    if (e.key === 'ArrowLeft')  next = (i - 1 + n) % n;
    if (e.key === 'Home')       next = 0;
    if (e.key === 'End')        next = n - 1;
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Your projects"
      className={cn(
        'flex gap-2 overflow-x-auto -mx-1 px-1 pb-1',
        '[&::-webkit-scrollbar]:h-1.5',
        '[&::-webkit-scrollbar-thumb]:bg-[var(--border)] [&::-webkit-scrollbar-thumb]:rounded-full',
        '[scrollbar-width:thin]',
      )}
      data-coachmark="customer.projects"
    >
      {projects.map((p, i) => {
        const active = p.id === activeId;
        return (
          <button
            key={p.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onPick(p.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'shrink-0 min-h-[44px] inline-flex items-center gap-2 px-3 py-2',
              'rounded-[var(--radius-full)] border transition-colors',
              'text-[12px] font-medium tracking-[var(--tracking-tight)]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-strong)] focus-visible:ring-offset-2',
              active
                ? 'border-[var(--accent-strong)] bg-[color-mix(in_oklch,var(--accent)_18%,var(--surface))] text-[var(--fg)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--accent-strong)]/60',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'w-2 h-2 rounded-full',
                active ? 'bg-[var(--accent-strong)]' : 'bg-[var(--fg-subtle)] opacity-60',
              )}
            />
            <span className="max-w-[180px] truncate">{p.title || 'Untitled project'}</span>
            {p.status && (
              <span className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-subtle)]">
                {p.status}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
