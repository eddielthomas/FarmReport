// =============================================================================
// TaskCard — Workspace day-task tile (S7B)
// -----------------------------------------------------------------------------
// The "Today's tasks" row item from the Workspace concept:
//   [avatar] [title + sub-line] [amount/time] [status select] [✉] [📹]
//
// `active` variant fills with --accent (matches the focused task in the concept
// image). Both light and dark surfaces supported.
// =============================================================================

import * as React from 'react';
import { Mail, Video, ChevronDown, User } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export interface TaskCardProps {
  title:    string;
  subtitle?: string;
  /** Right-aligned figure (e.g. "$118k" or "10:30") */
  trailing?: React.ReactNode;
  status?:   string;
  avatar?:  string | null;
  active?:  boolean;
  onClick?: () => void;
  onEmail?: () => void;
  onVideo?: () => void;
  className?: string;
}

export function TaskCard({
  title, subtitle, trailing, status = 'In Progress', avatar, active, onClick, onEmail, onVideo, className,
}: TaskCardProps) {
  return (
    <div
      className={cn(
        'group w-full flex items-center gap-3 p-2.5 pr-3',
        'rounded-[var(--radius-xl)] border',
        'transition-colors duration-[var(--duration-fast)]',
        active
          ? 'bg-[var(--accent)] text-[var(--fg-on-accent)] border-transparent shadow-[var(--shadow-accent)]'
          : 'bg-[var(--surface)] text-[var(--fg)] border-[var(--border)] shadow-[var(--shadow-soft)] hover:bg-[var(--surface-sunken)]',
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-3 flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-md)]"
      >
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center size-9 rounded-[var(--radius-full)] overflow-hidden shrink-0 text-[12px] font-medium',
            active
              ? 'bg-[var(--fg-on-accent)]/12 text-[var(--fg-on-accent)]'
              : 'bg-[var(--surface-sunken)] text-[var(--fg)]',
          )}
        >
          {avatar
            ? <img src={avatar} alt="" className="size-full object-cover" />
            : (title?.[0] ?? <User className="size-4" />)
          }
        </span>
        <span className="flex-1 min-w-0">
          <span className={cn(
            'block text-[13px] font-medium truncate',
            active ? 'text-[var(--fg-on-accent)]' : 'text-[var(--fg)]',
          )}>{title}</span>
          {subtitle && (
            <span className={cn(
              'block text-[11px] truncate',
              active ? 'text-[var(--fg-on-accent)]/75' : 'text-[var(--fg-muted)]',
            )}>{subtitle}</span>
          )}
        </span>
      </button>

      {trailing != null && (
        <span className={cn(
          'shrink-0 text-[13px] font-semibold tabular-nums',
          active ? 'text-[var(--fg-on-accent)]' : 'text-[var(--fg)]',
        )}>{trailing}</span>
      )}

      <span
        className={cn(
          'inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-full)] text-[11px] font-medium',
          active
            ? 'bg-[var(--fg-on-accent)]/14 text-[var(--fg-on-accent)]'
            : 'bg-[var(--surface-sunken)] text-[var(--fg-muted)]',
        )}
      >
        {status} <ChevronDown className="size-3" />
      </span>

      <button
        type="button"
        onClick={onEmail}
        aria-label="Send email"
        className={cn(
          'grid place-items-center size-7 rounded-[var(--radius-full)]',
          active
            ? 'bg-[var(--fg-on-accent)]/12 text-[var(--fg-on-accent)] hover:bg-[var(--fg-on-accent)]/20'
            : 'bg-[var(--surface-sunken)] text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)]',
        )}
      >
        <Mail className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onVideo}
        aria-label="Start video call"
        className={cn(
          'grid place-items-center size-7 rounded-[var(--radius-full)]',
          active
            ? 'bg-[var(--fg-on-accent)] text-[var(--accent)] hover:bg-[var(--fg-on-accent)]/85'
            : 'bg-[var(--fg)] text-[var(--fg-inverted)] hover:bg-[var(--fg)]/85',
        )}
      >
        <Video className="size-3.5" />
      </button>
    </div>
  );
}
