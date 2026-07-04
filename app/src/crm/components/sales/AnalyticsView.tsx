// =============================================================================
// AnalyticsView — Sales > Analytics tab (S7B)
// -----------------------------------------------------------------------------
// Mirrors the Accounting concept screen, scoped to the Sales surface:
//   • Hero "Income" headline number (huge Urbanist 600).
//   • Period switcher (Week / Month / Quarter / Year — underlined-active).
//   • Combo bar+line chart with a callout pill.
//   • 3 mini-cards beneath (Sales Forecast / Monthly Expenses / Project Budget).
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import type { DashboardMetrics, IncomeBucket } from '@crm/lib/types';
import { formatCurrency } from '@crm/lib/utils';
import { IncomeStatementCard, type IncomePeriod, type IncomePoint } from './IncomeStatementCard';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { MetricArc } from '@crm/components/ui/metric-arc';
import { TrendingUp, Receipt, Briefcase } from 'lucide-react';

export function AnalyticsView() {
  const [period, setPeriod] = React.useState<IncomePeriod>('month');

  const { data: metrics } = useQuery({
    queryKey: ['analytics', 'dashboard', 'sales-analytics'],
    queryFn:  () => apiGet<DashboardMetrics>(`/analytics/dashboard/metrics?period=${period}`),
  });
  const { data: income = [] } = useQuery({
    queryKey: ['analytics', 'income', period],
    queryFn:  () => apiGet<IncomeBucket[]>(`/analytics/income/${period}`),
  });

  const total = Number(metrics?.totalProfit ?? 0);
  const series: IncomePoint[] = (income.length > 0 ? income : seedSeries()).map((row, i) => ({
    x:    row.label,
    bar:  Number((row as IncomeBucket).income ?? (row as IncomePoint).bar ?? 0),
    line: Number((row as IncomePoint).line ?? Number((row as IncomeBucket).income ?? 0) * 0.62 + i * 80),
  }));
  const len = series.length;
  const hl  = { from: Math.floor(len * 0.18), to: Math.floor(len * 0.38), label: '$115k', delta: '+32%' };

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1600px] mx-auto space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="text-[12px] text-[var(--fg-muted)]">Sales · Accounting</div>
          <h1 className="text-[34px] sm:text-[44px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
            Income Statement
          </h1>
        </div>
      </div>

      <IncomeStatementCard
        total={total > 0 ? total : 1_651_045_139}
        period={period}
        onPeriodChange={setPeriod}
        data={series}
        highlight={hl}
      />

      {/* Sub-cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={<TrendingUp className="size-3.5" />}
          label="Sales Forecast"
          value={formatCurrency(141_700)}
          primary={{ label: 'Sales', value: '74%' }}
          secondary={{ label: 'Forecast', value: '26%' }}
        />
        <KpiCard
          icon={<Receipt className="size-3.5" />}
          label="Monthly Expenses"
          value={formatCurrency(17_200)}
          primary={{ label: 'Meals',    value: '38%' }}
          secondary={{ label: 'Rent',   value: '54%' }}
        />
        <KpiCard
          icon={<Briefcase className="size-3.5" />}
          label="Project Budget"
          value={formatCurrency(92_100)}
          primary={{ label: 'Sales',    value: '62%' }}
          secondary={{ label: 'Forecast', value: '38%' }}
        />
        <KpiCard
          icon={<TrendingUp className="size-3.5" />}
          label="Insight"
          value="Boosted"
          unit=""
          aside={<MetricArc value={57.6} size={120} thickness={9} showValue />}
          footnote="The new feedback form boosted requests and sales."
        />
      </div>
    </div>
  );
}

function seedSeries(): IncomeBucket[] {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep'];
  return months.map((m, i) => ({
    label:  m,
    income: 60_000 + Math.round(Math.sin((i / months.length) * Math.PI * 2) * 30_000) + i * 6_000,
  }));
}
