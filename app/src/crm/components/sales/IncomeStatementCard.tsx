// =============================================================================
// IncomeStatementCard — Accounting hero card (S7B Analytics view)
// -----------------------------------------------------------------------------
// Matches the "Accounting · $1,651,045,139" concept screen:
//   • Top header   — kicker "HALF-YEAR INCOME STATEMENT" + 4 radio metric tabs.
//   • Hero number  — giant figure (Urbanist 600 ~80px on desktop).
//   • Period tabs  — Week / Month / Quarter / Year, underlined-active.
//   • Combo chart  — thin black bars + black trend line, lime highlight band.
//   • Tooltip pill — "$115k +32%  income growth to end the half-year".
//
// Pure visuals — caller injects the dataset.
// =============================================================================

import * as React from 'react';
import {
  ComposedChart, Bar, Line, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import { cn } from '@crm/lib/utils';
import { formatCurrency } from '@crm/lib/utils';

export type IncomePeriod = 'week' | 'month' | 'quarter' | 'year';

export interface IncomePoint {
  x:    string;
  bar:  number;
  line: number;
}

export interface IncomeStatementCardProps {
  total:    number;
  period:   IncomePeriod;
  onPeriodChange: (p: IncomePeriod) => void;
  data:     IncomePoint[];
  /** Highlight band start/end (indexes into `data`). */
  highlight?: { from: number; to: number; label?: React.ReactNode; delta?: string };
  className?: string;
}

const PERIODS: ReadonlyArray<{ k: IncomePeriod; label: string }> = [
  { k: 'week',    label: 'Week' },
  { k: 'month',   label: 'Month' },
  { k: 'quarter', label: 'Quarter' },
  { k: 'year',    label: 'Year' },
];

const FILTERS = ['Income', 'New Profit', 'COGS', 'Expenses'] as const;

export function IncomeStatementCard({
  total,
  period,
  onPeriodChange,
  data,
  highlight,
  className,
}: IncomeStatementCardProps) {
  const [filter, setFilter] = React.useState<typeof FILTERS[number]>('Income');

  return (
    <section
      className={cn(
        'rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
        'shadow-[var(--shadow-card)] p-6',
        className,
      )}
      aria-label="Income statement"
    >
      {/* Top row */}
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
            Half-Year Income Statement
          </div>
          <div role="radiogroup" aria-label="Metric filter" className="mt-2 flex items-center gap-4 text-[12px]">
            {FILTERS.map((f) => (
              <button
                key={f}
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'inline-flex items-center gap-2 text-[var(--fg-muted)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-sm)]',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-block size-2.5 rounded-[var(--radius-full)] border',
                    filter === f
                      ? 'bg-[var(--fg)] border-[var(--fg)]'
                      : 'bg-transparent border-[var(--border-strong)]',
                  )}
                />
                <span className={cn(filter === f && 'text-[var(--fg)]')}>{f}</span>
              </button>
            ))}
          </div>
        </div>

        <div role="tablist" aria-label="Period" className="flex items-center gap-4 text-[12px]">
          {PERIODS.map((p) => (
            <button
              key={p.k}
              role="tab"
              aria-selected={period === p.k}
              onClick={() => onPeriodChange(p.k)}
              className={cn(
                'pb-1 -mb-px border-b-2 transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-sm)]',
                period === p.k
                  ? 'border-[var(--fg)] text-[var(--fg)] font-medium'
                  : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {/* Hero number */}
      <div className="mt-6 text-center">
        <div className="text-[44px] sm:text-[64px] md:text-[80px] leading-[1.0] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
          {formatCurrency(total)}
        </div>
        <div className="mt-1 text-[12px] text-[var(--fg-muted)]">Income</div>
      </div>

      {/* Chart */}
      <div className="mt-6 h-[260px] sm:h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 20, right: 8, bottom: 18, left: 8 }} barCategoryGap={1}>
            <XAxis
              dataKey="x"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--fg-muted)', fontFamily: 'var(--font-sans)' }}
              interval={Math.max(0, Math.floor(data.length / 9))}
              height={20}
            />
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip
              cursor={{ fill: 'color-mix(in oklch, var(--accent) 14%, transparent)' }}
              contentStyle={{
                background:   'var(--surface-elevated)',
                border:       '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                fontSize:     11,
                color:        'var(--fg)',
                boxShadow:    'var(--shadow-popover)',
              }}
              labelStyle={{ color: 'var(--fg-muted)' }}
              formatter={(v: number) => formatCurrency(v)}
            />
            <Bar dataKey="bar" radius={[2, 2, 0, 0]} maxBarSize={5}>
              {data.map((_, i) => {
                const inBand = highlight && i >= highlight.from && i <= highlight.to;
                return (
                  <Cell key={i} fill={inBand ? 'var(--fg)' : 'color-mix(in oklch, var(--fg) 18%, transparent)'} />
                );
              })}
            </Bar>
            <Line
              type="monotone"
              dataKey="line"
              stroke="var(--fg)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Highlight callout pill */}
      {highlight && (
        <div className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-soft)]">
          <span className="text-[14px] font-semibold text-[var(--fg)]">{highlight.label ?? '$115k'}</span>
          {highlight.delta && (
            <span className="text-[11px] px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] font-medium">
              {highlight.delta}
            </span>
          )}
          <span className="text-[11px] text-[var(--fg-muted)]">income growth to end the half-year</span>
        </div>
      )}
    </section>
  );
}
