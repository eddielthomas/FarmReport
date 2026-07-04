// =============================================================================
// LeadCard — Workspace lead-pipeline card (S7B)
// -----------------------------------------------------------------------------
// The lead tile from the Workspace concept (dark mode). Anatomy:
//   • Top row    — Source pill(s) on the left, status dots on the right.
//   • Identity   — avatar + name + role @ company.
//   • Footer     — arrow CTA (active variant fills the whole card with --accent).
//
// Works on both light and dark surfaces (tokens flip via `data-surface`). The
// "active" variant is what makes a Workspace card pop as the focused lead.
// =============================================================================

import * as React from 'react';
import { ArrowUpRight, User } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { StatusDots } from '@crm/components/ui/status-dots';

export interface LeadCardProps {
  name:    string;
  /** Job title / position (e.g. "Sales Manager"). */
  role?:   string | null;
  company?: string | null;
  /** 0..5 — lead score (red → green). */
  score?:  number;
  /** Source pills (e.g. ["LinkedIn", "Webinar"]). */
  sources?: string[];
  avatar?: string | null;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

export function LeadCard({
  name, role, company, score = 3, sources = [], avatar, active, onClick, className,
}: LeadCardProps) {
  const initials = (name ?? '?').trim().charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active ? true : undefined}
      className={cn(
        'group w-full text-left flex flex-col gap-3 p-4',
        'rounded-[var(--radius-xl)] border',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--easing-standard)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        active
          ? 'bg-[var(--accent)] text-[var(--fg-on-accent)] border-transparent shadow-[var(--shadow-accent)]'
          : 'bg-[var(--surface)] text-[var(--fg)] border-[var(--border)] shadow-[var(--shadow-card)] hover:bg-[var(--surface-sunken)]',
        className,
      )}
    >
      {/* Top row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {sources.length === 0 && (
            <span className="text-[10px] uppercase tracking-[var(--tracking-wide)] opacity-70">Lead</span>
          )}
          {sources.slice(0, 2).map((s) => (
            <span
              key={s}
              className={cn(
                'inline-flex items-center h-5 px-2 rounded-[var(--radius-full)] text-[10px] font-medium',
                active
                  ? 'bg-[var(--fg-on-accent)]/10 text-[var(--fg-on-accent)]'
                  : 'bg-[var(--surface-sunken)] text-[var(--fg-muted)]',
              )}
            >
              {s}
            </span>
          ))}
        </div>
        <StatusDots score={score} aria-label={`${name} score ${score} of 5`} />
      </div>

      {/* Identity */}
      <div className="flex items-center gap-3 min-w-0">
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center size-10 rounded-[var(--radius-full)] overflow-hidden shrink-0 text-[13px] font-medium',
            active
              ? 'bg-[var(--fg-on-accent)]/15 text-[var(--fg-on-accent)]'
              : 'bg-[var(--surface-sunken)] text-[var(--fg)]',
          )}
        >
          {avatar
            ? <img src={avatar} alt="" className="size-full object-cover" />
            : initials || <User className="size-4" />
          }
        </span>
        <span className="flex-1 min-w-0">
          <span className={cn(
            'block text-[14px] font-semibold truncate',
            active ? 'text-[var(--fg-on-accent)]' : 'text-[var(--fg)]',
          )}>
            {name}
          </span>
          {(role || company) && (
            <span className={cn(
              'block text-[11px] truncate',
              active ? 'text-[var(--fg-on-accent)]/75' : 'text-[var(--fg-muted)]',
            )}>
              {[role, company].filter(Boolean).join(' @ ')}
            </span>
          )}
        </span>
      </div>

      {/* Footer arrow */}
      <div className="flex justify-end">
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center size-7 rounded-[var(--radius-full)] transition-colors duration-[var(--duration-fast)]',
            active
              ? 'bg-[var(--fg-on-accent)]/10 text-[var(--fg-on-accent)] group-hover:bg-[var(--fg-on-accent)]/20'
              : 'bg-[var(--surface-sunken)] text-[var(--fg)] group-hover:bg-[var(--fg)] group-hover:text-[var(--fg-inverted)]',
          )}
        >
          <ArrowUpRight className="size-3.5" />
        </span>
      </div>
    </button>
  );
}
