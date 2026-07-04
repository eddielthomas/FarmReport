// =============================================================================
// WorkspaceView — Sales Workspace (dark-surface lead pipeline) — S7B
// -----------------------------------------------------------------------------
// Concept layout:
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ [vertical sidebar ▢▢▢▢]  [ScheduleRail · pill bar @top]            │
//   │                                                                    │
//   │     LEAD GRID (2×2 cards, one is `active` — fills lime)            │
//   │                                                                    │
//   │     Today's tasks                                                  │
//   │     [TaskCard]  [TaskCard active]  [TaskCard]                      │
//   │                                                                    │
//   │     (optional Video PIP overlay – floating bottom-right)           │
//   └────────────────────────────────────────────────────────────────────┘
//
// On mount, force `data-surface=dark` on the wrapper so the workspace adopts
// the cinematic dark palette regardless of the user's top-level surface mode.
// The mode auto-restores when this view unmounts.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutGrid, MessageSquare, BarChart3, Settings as SettingsIcon,
  Video, Mic, MicOff, PhoneOff, X,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import type { Lead, Meeting } from '@crm/lib/types';
import { cn } from '@crm/lib/utils';
import { ScheduleRail, type ScheduleSlot } from '@crm/components/ui/schedule-rail';
import { LeadCard } from './LeadCard';
import { TaskCard } from './TaskCard';

export function WorkspaceView() {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [activeLeadId, setActiveLeadId] = React.useState<string | null>(null);
  const [pipOpen, setPipOpen] = React.useState(false);

  // Lock this view to dark mode regardless of the global surface store.
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const prev = el.getAttribute('data-surface');
    el.setAttribute('data-surface', 'dark');
    return () => {
      if (prev) el.setAttribute('data-surface', prev);
      else      el.removeAttribute('data-surface');
    };
  }, []);

  const { data: leads = [] } = useQuery({
    queryKey: ['sales', 'leads', 'workspace'],
    queryFn:  () => apiGet<Lead[]>('/sales/leads'),
  });

  const { data: meetings = [] } = useQuery({
    queryKey: ['sales', 'meetings', 'workspace', todayKey()],
    queryFn:  async () => {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const rows = await apiGet<Meeting[]>(`/sales/meetings?from=${from.toISOString()}`);
      return rows.filter((m) => sameDay(new Date(m.start_at), new Date()));
    },
  });

  // Top 4 pipeline cards — prefer status='Lead', fall back to Info Request.
  const pipeline = React.useMemo(() => {
    const ranked = [
      ...leads.filter((l) => l.status === 'Lead'),
      ...leads.filter((l) => l.status === 'Info Request'),
      ...leads.filter((l) => l.status === 'Client'),
    ];
    return ranked.slice(0, 4);
  }, [leads]);

  const slots: ScheduleSlot[] = meetings.length > 0
    ? meetings.slice(0, 5).map((m, i) => ({
        id:    m.id,
        time:  timeLabel(m.start_at),
        label: m.title,
        active: i === 0,
        progress: i === 0 ? 0.45 : 0,
        attendees: (m.attendees ?? []).map((a, ai) => ({ id: `${m.id}-${ai}`, name: a.name ?? a.email })),
      }))
    : DEMO_SLOTS;

  const activeLead = pipeline.find((l) => l.id === activeLeadId) ?? pipeline[0] ?? null;

  return (
    <div
      ref={wrapperRef}
      data-surface="dark"
      className="relative min-h-full bg-[var(--bg)] text-[var(--fg)]"
    >
      <div className="flex h-full min-h-[640px]">
        {/* Sidebar — 4 vertical icons */}
        <aside
          aria-label="Workspace navigation"
          className="hidden lg:flex flex-col items-center gap-2 p-3 border-r border-[var(--border)] bg-[var(--bg-elevated)]"
        >
          {[
            { icon: LayoutGrid,     label: 'Pipeline',    active: true  },
            { icon: MessageSquare,  label: 'Messages',    active: false },
            { icon: BarChart3,      label: 'Analytics',   active: false },
            { icon: SettingsIcon,   label: 'Settings',    active: false },
          ].map(({ icon: Icon, label, active }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={label}
              className={cn(
                'grid place-items-center size-11 rounded-[var(--radius-xl)] transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
                active
                  ? 'bg-[var(--fg)] text-[var(--fg-inverted)] shadow-[var(--shadow-card)]'
                  : 'bg-transparent text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--fg)]',
              )}
            >
              <Icon className="size-5" />
            </button>
          ))}
        </aside>

        {/* Main */}
        <div className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6 overflow-x-hidden">
          {/* Top: schedule rail */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[12px] text-[var(--fg-muted)]">Your day at a glance</div>
              <h2 className="text-[26px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
                Workspace
              </h2>
            </div>
            <ScheduleRail date={prettyToday()} slots={slots} />
          </div>

          {/* Lead grid */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {pipeline.length === 0 && (
              <div className="col-span-full rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] p-8 text-center text-[var(--fg-muted)]">
                No active leads — head to the Overview to ingest new ones.
              </div>
            )}
            {pipeline.map((l, i) => (
              <LeadCard
                key={l.id}
                name={l.name}
                role={l.position}
                company={l.company}
                score={scoreFor(l)}
                sources={l.source ? [l.source] : []}
                active={activeLead?.id === l.id || (!activeLeadId && i === 0)}
                onClick={() => setActiveLeadId(l.id)}
              />
            ))}
          </div>

          {/* Today's tasks */}
          <div className="mt-8">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[16px] font-semibold text-[var(--fg)]">Today&rsquo;s tasks</h3>
              <span className="text-[11px] text-[var(--fg-muted)]">
                {meetings.length} meeting{meetings.length === 1 ? '' : 's'} · {pipeline.length} active leads
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {meetings.length > 0 ? (
                meetings.slice(0, 5).map((m, i) => (
                  <TaskCard
                    key={m.id}
                    title={m.title}
                    subtitle={m.location ?? `${(m.attendees ?? []).length} attendees`}
                    trailing={timeLabel(m.start_at)}
                    active={i === 1}
                    onVideo={() => setPipOpen(true)}
                  />
                ))
              ) : (
                DEMO_TASKS.map((t, i) => (
                  <TaskCard
                    key={t.id}
                    title={t.title}
                    subtitle={t.subtitle}
                    trailing={t.trailing}
                    active={i === 1}
                    onVideo={() => setPipOpen(true)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Video PIP overlay */}
      {pipOpen && <VideoPipCard onClose={() => setPipOpen(false)} />}
    </div>
  );
}

// -----------------------------------------------------------------------------
// VideoPipCard — floating call-tile overlay matching the Workspace concept.
// -----------------------------------------------------------------------------
function VideoPipCard({ onClose }: { onClose: () => void }) {
  const [muted, setMuted] = React.useState(false);
  return (
    <div
      role="dialog"
      aria-label="Active call"
      className="fixed right-4 bottom-4 z-[var(--z-overlay)] w-[280px] rounded-[var(--radius-2xl)] overflow-hidden shadow-[var(--shadow-overlay)] border border-[var(--border-strong)] bg-[var(--surface-elevated)] text-[var(--fg)]"
    >
      <div className="aspect-video bg-[var(--surface-sunken)] grid place-items-center">
        <Video className="size-8 text-[var(--fg-muted)]" />
      </div>
      <div className="p-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--fg)] truncate">Eva Robinson</div>
          <div className="text-[10px] text-[var(--fg-muted)]">Quarterly review · 24:18</div>
        </div>
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? 'Unmute' : 'Mute'}
          className="grid place-items-center size-9 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="End call"
          className="grid place-items-center size-9 rounded-[var(--radius-full)] bg-[var(--red)] text-[var(--fg-inverted)] hover:bg-[var(--red)]/85 transition-colors duration-[var(--duration-fast)]"
        >
          <PhoneOff className="size-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close picture-in-picture"
          className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors duration-[var(--duration-fast)]"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Demo data — used when the API returns empty (e.g. fresh tenant).
// -----------------------------------------------------------------------------
const DEMO_SLOTS: ScheduleSlot[] = [
  { id: 's-1', time: '09:00', label: 'Standup',        active: false },
  { id: 's-2', time: '10:30', label: 'Eva Robinson',   active: true, progress: 0.5 },
  { id: 's-3', time: '13:15', label: 'Demo · Veriq',   active: false },
  { id: 's-4', time: '15:45', label: 'Pipeline review', active: false },
];

const DEMO_TASKS = [
  { id: 't-1', title: 'Send Q3 proposal to Eva Robinson',  subtitle: 'eva.r@syncdesk.co',  trailing: '$118k' },
  { id: 't-2', title: 'Quarterly review · Helena Crims',   subtitle: 'helena.c@veriq.tech', trailing: '10:30' },
  { id: 't-3', title: 'Renewal call · Anna Morris',        subtitle: 'anna@domain.io',     trailing: '$24k' },
  { id: 't-4', title: 'Onboarding kickoff · NorthWind',    subtitle: 'NorthWind Ltd',      trailing: '14:00' },
];

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function scoreFor(lead: Lead): number {
  switch (lead.status) {
    case 'Client':       return 5;
    case 'Lead':         return 3;
    case 'Info Request': return 2;
    default:             return 1;
  }
}

function todayKey(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function prettyToday(): string {
  try {
    return new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
  } catch { return 'Today'; }
}
