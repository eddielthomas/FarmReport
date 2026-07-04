// =============================================================================
// AnalyticsManager — analytics surface (S7C re-skin)
// -----------------------------------------------------------------------------
// IA preserved (KPI strip, 12-month trend area chart, income bar chart, period
// picker, CSV exports). Visual layer:
//   - Giant hero number (Urbanist 600) for total revenue.
//   - KpiCard grid for the rest of the KPIs.
//   - Recharts re-themed via CSS variables: thin black bars + green highlight
//     to match the concept boards.
//   - PillTabs for the period picker.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { apiGet } from '@crm/lib/api';
import type { DashboardMetrics, IncomeBucket } from '@crm/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Button } from '@crm/components/ui/button';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { formatCurrency } from '@crm/lib/utils';
import {
  TrendingUp, Users, UserCheck, Activity, DollarSign, Percent, Download,
} from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';

type Period = 'week' | 'month' | 'quarter' | 'year';

const PERIOD_ITEMS: ReadonlyArray<PillTabItem<Period>> = [
  { key: 'week',    label: 'Week' },
  { key: 'month',   label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year',    label: 'Year' },
];

export function AnalyticsManager() {
  const [period, setPeriod] = useState<Period>('month');

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => apiGet<DashboardMetrics>('/analytics/dashboard/metrics'),
  });
  const { data: income = [], isLoading: incomeLoading } = useQuery({
    queryKey: ['analytics', 'income', period],
    queryFn: () => apiGet<IncomeBucket[]>(`/analytics/income/${period}`),
  });

  function exportCsv(name: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `${name}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Hero number: total revenue (formatted minus the currency symbol so the
  // giant glyph reads cleanly with `$` shown as a smaller superscript).
  const totalRevenue = Number(metrics?.totalProfit ?? 0);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-6 max-w-[1440px] mx-auto">
        {/* ---- Header ---------------------------------------------------- */}
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Analytics
            </div>
            <h1 className="text-[28px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
              Pipeline performance
            </h1>
          </div>
          <Button
            size="md"
            variant="outline"
            onClick={() => exportCsv('trend', metrics?.chartData ?? [])}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        </header>

        {/* ---- Hero number ---------------------------------------------- */}
        <Card data-coachmark="analytics.hero" className="overflow-hidden">
          <CardContent className="py-10 sm:py-14 flex flex-col items-center text-center gap-2">
            <div className="text-[10px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-muted)]">
              Total Revenue · Lifetime
            </div>
            {metricsLoading ? (
              <div className="h-20 w-64 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] animate-pulse" />
            ) : (
              <div className="flex items-baseline gap-1 leading-none">
                <span className="text-[28px] sm:text-[36px] font-medium text-[var(--fg-muted)] translate-y-[-0.55em]">
                  $
                </span>
                <span className="text-[64px] sm:text-[88px] lg:text-[112px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
                  {new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(totalRevenue)}
                </span>
              </div>
            )}
            <div className="text-[12px] text-[var(--fg-muted)]">
              Closed revenue across all leads in the current tenant
            </div>
          </CardContent>
        </Card>

        {/* ---- KPI grid ------------------------------------------------- */}
        <div data-coachmark="analytics.kpis" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {metricsLoading ? (
            <>
              <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
            </>
          ) : (
            <>
              <KpiCard
                icon={<Users className="size-3.5" />}
                label="Total Leads"
                value={metrics?.totalLeads ?? '—'}
                tint="cyan"
              />
              <KpiCard
                icon={<Activity className="size-3.5" />}
                label="Info Requests"
                value={metrics?.pendingInfoRequests ?? '—'}
                tint="orange"
              />
              <KpiCard
                icon={<TrendingUp className="size-3.5" />}
                label="Open Leads"
                value={metrics?.openLeads ?? '—'}
                tint="accent"
              />
              <KpiCard
                icon={<UserCheck className="size-3.5" />}
                label="Active Clients"
                value={metrics?.totalActiveClients ?? '—'}
                tint="green"
              />
              <KpiCard
                icon={<Percent className="size-3.5" />}
                label="Conversion Rate"
                value={metrics?.conversionRate ?? 0}
                unit="%"
                tint="accent"
              />
              <KpiCard
                icon={<DollarSign className="size-3.5" />}
                label="Total Revenue"
                value={formatCurrency(metrics?.totalProfit ?? 0)}
                tint="green"
              />
            </>
          )}
        </div>

        {/* ---- 12-month trend ------------------------------------------- */}
        <Card data-coachmark="analytics.trend">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>12-Month trend</CardTitle>
              <CardDescription>Cumulative leads · clients · conversion rate</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => exportCsv('trend', metrics?.chartData ?? [])}>
              <Download className="size-3" /> CSV
            </Button>
          </CardHeader>
          <CardContent className="h-[300px]">
            {metricsLoading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={metrics?.chartData ?? []} margin={{ top: 10, right: 4, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="leadsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="var(--accent)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="clientsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%"   stopColor="var(--green)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--green)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: 'var(--fg-muted)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: 'var(--fg-muted)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--fg)',
                      fontSize: 12,
                      boxShadow: 'var(--shadow-popover)',
                    }}
                    labelStyle={{ color: 'var(--fg-muted)' }}
                  />
                  <Area type="monotone" dataKey="leads"   stroke="var(--fg)"     fill="url(#leadsGrad)"   strokeWidth={1.5} />
                  <Area type="monotone" dataKey="clients" stroke="var(--accent-strong)" fill="url(#clientsGrad)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* ---- Income chart --------------------------------------------- */}
        <Card data-coachmark="analytics.income">
          <CardHeader className="flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle>Income · {period.charAt(0).toUpperCase() + period.slice(1)}</CardTitle>
              <CardDescription>Closed revenue per bucket</CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <PillTabs<Period>
                value={period}
                onChange={setPeriod}
                items={PERIOD_ITEMS}
                size="sm"
                aria-label="Income period"
              />
              <Button size="sm" variant="outline" onClick={() => exportCsv(`income-${period}`, income)}>
                <Download className="size-3" /> CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="h-[280px]">
            {incomeLoading ? <ChartSkeleton /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={income} margin={{ top: 10, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--fg-muted)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: 'var(--fg-muted)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--fg)',
                      fontSize: 12,
                      boxShadow: 'var(--shadow-popover)',
                    }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Bar dataKey="income" fill="var(--fg)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <CoachmarkTour tourId={TOURS.analytics.id} steps={TOURS.analytics.steps} />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
function KpiSkeleton() {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="h-3 w-20 rounded bg-[var(--surface-sunken)] animate-pulse" />
        <div className="h-12 w-32 rounded mt-3 bg-[var(--surface-sunken)] animate-pulse" />
      </CardContent>
    </Card>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-full w-full flex items-end gap-2 px-1">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="flex-1 rounded-t bg-[var(--surface-sunken)] animate-pulse"
          style={{ height: `${30 + ((i * 53) % 60)}%`, animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  );
}
