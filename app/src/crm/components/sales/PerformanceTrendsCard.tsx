// =============================================================================
// PerformanceTrendsCard — "Account Performance Trends" card (S7B)
// -----------------------------------------------------------------------------
// Mirrors the mobile concept tile titled "Account Performance Trends":
//   • Top row     — icon + title + arrow.
//   • Sub-tabs    — Utilization / Timely Closures.
//   • Hero number — 56,1% (Urbanist 600).
//   • Sub-stats   — 4-column row: Syncs / Fetches / Manuals / Autosync.
//   • Chart       — embedded UtilizationChart with axis labels.
// =============================================================================

import * as React from 'react';
import { ArrowUpRight, FolderClosed } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { UtilizationChart, type UtilPoint } from './UtilizationChart';

export type TrendsTab = 'utilization' | 'closures';

export interface PerformanceTrendsCardProps {
  /** Headline percent (e.g. 56.1). */
  value: number;
  syncs:    string | number;
  fetches:  string | number;
  manuals:  string | number;
  autosync: string | number;
  data:     UtilPoint[];
  defaultTab?: TrendsTab;
  onOpen?:  () => void;
  className?: string;
}

export function PerformanceTrendsCard({
  value,
  syncs,
  fetches,
  manuals,
  autosync,
  data,
  defaultTab = 'utilization',
  onOpen,
  className,
}: PerformanceTrendsCardProps) {
  const [tab, setTab] = React.useState<TrendsTab>(defaultTab);

  const heroInt  = Math.trunc(value);
  const heroFrac = Math.abs(value - heroInt).toFixed(1).slice(2);

  return (
    <section
      className={cn(
        'rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
        'shadow-[var(--shadow-card)] p-5',
        className,
      )}
      aria-label="Account Performance Trends"
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-muted)]">
          <FolderClosed className="size-3.5 text-[var(--fg)]" />
          <span>Account Performance Trends</span>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label="Open trends"
            className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
          >
            <ArrowUpRight className="size-3.5" />
          </button>
        )}
      </header>

      {/* Sub-tabs (Utilization / Timely Closures) */}
      <div role="tablist" aria-label="Trends view" className="mt-4 flex items-center gap-5 text-[12px]">
        {(
          [
            { k: 'utilization', label: 'Utilization' },
            { k: 'closures',    label: 'Timely Closures' },
          ] as const
        ).map((t) => (
          <button
            key={t.k}
            role="tab"
            type="button"
            aria-selected={tab === t.k}
            onClick={() => setTab(t.k)}
            className={cn(
              'pb-1 -mb-px border-b-2 transition-colors duration-[var(--duration-fast)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-sm)]',
              tab === t.k
                ? 'border-[var(--fg)] text-[var(--fg)] font-medium'
                : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-baseline gap-3">
        <div className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mr-auto">
          Average Account Stats
        </div>
      </div>

      {/* Hero number */}
      <div className="mt-1 flex items-baseline">
        <span className="text-[56px] sm:text-[64px] leading-[1.0] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
          {heroInt},{heroFrac}
        </span>
        <span className="text-[18px] font-medium text-[var(--fg-muted)] translate-y-[-22px] ml-1">%</span>
      </div>

      {/* Sub-stats — 4 columns matching the concept */}
      <div className="mt-4 grid grid-cols-4 gap-3">
        <SubStat label="Syncs"    value={syncs} />
        <SubStat label="Fetches"  value={fetches} />
        <SubStat label="Manuals"  value={manuals} />
        <SubStat label="Autosync" value={autosync} />
      </div>

      {/* Chart */}
      <div className="mt-4">
        <UtilizationChart data={data} height={120} axis />
      </div>
    </section>
  );
}

function SubStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[16px] font-semibold text-[var(--fg)] leading-tight">{value}</span>
      <span className="text-[11px] text-[var(--fg-muted)]">{label}</span>
    </div>
  );
}
