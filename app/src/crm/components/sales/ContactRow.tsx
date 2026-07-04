// =============================================================================
// ContactRow — bottom-of-Overview contact card (S7B)
// -----------------------------------------------------------------------------
// Matches the "Eva Robinson · eva.r@syncdesk.co · →" tile at the bottom of the
// Overview Panel concept. Avatar (initial / image) on the left, name + email
// stacked, an arrow icon on the right.
// =============================================================================

import * as React from 'react';
import { ArrowUpRight, User } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export interface ContactRowProps {
  name:    string;
  email?:  string | null;
  avatar?: string | null;
  onClick?: () => void;
  className?: string;
}

export function ContactRow({ name, email, avatar, onClick, className }: ContactRowProps) {
  const initials = (name ?? '?').trim().charAt(0).toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 w-full text-left',
        'rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)]',
        'shadow-[var(--shadow-card)]',
        'p-3 pr-2.5',
        'transition-colors duration-[var(--duration-fast)] ease-[var(--easing-standard)]',
        'hover:bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
        className,
      )}
      aria-label={`Open contact ${name}`}
    >
      <span
        className="grid place-items-center size-9 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] overflow-hidden shrink-0 text-[var(--fg)] text-[12px] font-medium"
        aria-hidden="true"
      >
        {avatar ? (
          <img src={avatar} alt="" className="size-full object-cover" />
        ) : initials ? (
          initials
        ) : (
          <User className="size-4" />
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-[var(--fg)] truncate">{name}</span>
        {email && (
          <span className="block text-[11px] text-[var(--fg-muted)] truncate">{email}</span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)] group-hover:bg-[var(--fg)] group-hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
      >
        <ArrowUpRight className="size-3.5" />
      </span>
    </button>
  );
}
