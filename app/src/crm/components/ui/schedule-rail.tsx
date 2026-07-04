// =============================================================================
// ScheduleRail — top "Your Schedule" pill rail (S7A)
// -----------------------------------------------------------------------------
// Mirrors the dark-workspace concept's horizontal schedule pill: a black
// rounded-full track punctuated by lime-green meeting slots, each showing
// time, optional icon, and attendee avatars. The "active" slot fills with a
// progress gradient to show how much time has elapsed.
//
// The rail itself is layout-agnostic — S7B will feed real meeting data; this
// primitive just renders the visual pattern.
// =============================================================================

import * as React from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '@crm/lib/utils';

export interface ScheduleAttendee {
  id:     string;
  name?:  string;
  avatar?: string;
}

export interface ScheduleSlot {
  id:        string;
  time:      string;
  label?:    React.ReactNode;
  icon?:     React.ReactNode;
  attendees?: ScheduleAttendee[];
  /** Mark this slot as "now". The bar fills proportionally to `progress`. */
  active?:   boolean;
  /** 0..1 — only consulted when active. */
  progress?: number;
}

export interface ScheduleRailProps extends React.HTMLAttributes<HTMLDivElement> {
  date:   React.ReactNode;
  slots:  ScheduleSlot[];
  onSlotClick?: (slot: ScheduleSlot) => void;
}

export function ScheduleRail({
  date,
  slots,
  onSlotClick,
  className,
  ...rest
}: ScheduleRailProps) {
  return (
    <div
      role="region"
      aria-label="Your schedule"
      className={cn(
        'inline-flex items-center gap-2 p-1.5 pl-3',
        'rounded-[var(--radius-full)]',
        'bg-[var(--surface-inverted)] text-[var(--fg-inverted)]',
        'shadow-[var(--shadow-card)]',
        className,
      )}
      {...rest}
    >
      {/* Date pill (white on dark, dark on white) */}
      <div className="inline-flex items-center gap-2 px-2 text-[12px] font-medium opacity-90">
        <Calendar className="size-3.5" />
        <span>{date}</span>
      </div>

      {/* Slots */}
      <div className="flex items-center gap-1.5">
        {slots.map((s) => (
          <SlotPill key={s.id} slot={s} onClick={onSlotClick} />
        ))}
      </div>
    </div>
  );
}

function SlotPill({
  slot,
  onClick,
}: {
  slot: ScheduleSlot;
  onClick?: (s: ScheduleSlot) => void;
}) {
  const { time, label, icon, attendees, active, progress = 0 } = slot;
  const pct = Math.max(0, Math.min(1, progress)) * 100;

  return (
    <button
      type="button"
      onClick={() => onClick?.(slot)}
      className={cn(
        'group relative inline-flex items-center gap-2 h-8 pl-2 pr-2 rounded-[var(--radius-full)]',
        'text-[12px] font-medium',
        'transition-colors duration-[var(--duration-fast)]',
        active
          ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]'
          : 'bg-[var(--fg-inverted)]/[0.08] text-[var(--fg-inverted)] hover:bg-[var(--fg-inverted)]/[0.14]',
      )}
      aria-pressed={active ? true : undefined}
      aria-label={typeof label === 'string' ? `${time} ${label}` : time}
    >
      {/* Progress overlay for the active slot */}
      {active && pct > 0 && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-[var(--radius-full)] pointer-events-none"
          style={{
            width: `${pct}%`,
            background: 'color-mix(in oklch, var(--fg-on-accent) 18%, transparent)',
          }}
        />
      )}
      {icon && <span className="relative z-10 grid place-items-center size-5">{icon}</span>}
      <span className="relative z-10 px-1 tabular-nums">{time}</span>
      {label && <span className="relative z-10 opacity-80">{label}</span>}
      {attendees && attendees.length > 0 && (
        <span className="relative z-10 flex -space-x-1">
          {attendees.slice(0, 3).map((a) => (
            <span
              key={a.id}
              className="grid place-items-center size-5 rounded-[var(--radius-full)] bg-[var(--surface)] text-[10px] text-[var(--fg)] border border-[var(--border-inverted)] overflow-hidden"
              title={a.name}
            >
              {a.avatar
                ? <img src={a.avatar} alt={a.name ?? ''} className="size-full object-cover" />
                : (a.name ?? '?').charAt(0).toUpperCase()
              }
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
