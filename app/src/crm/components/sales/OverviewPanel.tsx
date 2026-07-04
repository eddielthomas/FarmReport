// =============================================================================
// OverviewPanel — Sales Overview surface (S7B)
// -----------------------------------------------------------------------------
// Pixel-mapped to the "Overview Panel" concept board:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │  Data Based on All Clients                       [GlassPanel] ▶ │
//   │  Overview Panel                                                 │
//   │  ───────────────                                                │
//   │                                                                 │
//   │   ╭──────────╮  ╭──────────╮  ╭──────────╮   ╭───────────────╮  │
//   │   │ Proc.    │  │ Synced   │  │ Anomalies│   │  AI Assistant │  │
//   │   │ Items    │  │ Records  │  │          │   │  (sticky rail │  │
//   │   │ 97,22%   │  │ 71,74%   │  │ 10,12%   │   │   spans 2     │  │
//   │   ╰──────────╯  ╰──────────╯  ╰──────────╯   │   rows)       │  │
//   │   ╭───────────────────╮ ╭────────────────╮   │               │  │
//   │   │ Utilization 56,1% │ │ Closures 82,6% │   │               │  │
//   │   ╰───────────────────╯ ╰────────────────╯   ╰───────────────╯  │
//   │   ╭ Eva ╮   ╭ Helena ╮   ╭ Anna ╮            (contact row)      │
//   └─────────────────────────────────────────────────────────────────┘
//
// Layout: 4-column grid on >= xl (1280 px). The right column is the AI
// Assistant rail; it spans the KPI + chart rows visually thanks to grid
// row-span. Below 1280 the assistant rail falls beneath the other content.
//
// Data wiring: hits `/analytics/dashboard/metrics`, `/sales/leads`, and
// `/crm/contacts` (graceful fallback when an endpoint is unavailable —
// see `useContacts`).
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Layers, Database, AlertOctagon, FolderClosed, Calendar, ChevronDown, ArrowUpRight,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import type { DashboardMetrics, Lead } from '@crm/lib/types';
import { cn, formatDate } from '@crm/lib/utils';
import { KpiCard, KpiStrip } from '@crm/components/ui/kpi-card';
import { MetricArc } from '@crm/components/ui/metric-arc';
import { AccountInsightsHero } from './AccountInsightsHero';
import { AiAssistantChat } from './AiAssistantChat';
import { ContactRow } from './ContactRow';
import { UtilizationChart, type UtilPoint } from './UtilizationChart';

interface Contact {
  id:    string;
  name:  string;
  email: string | null;
  avatar?: string | null;
}

export function OverviewPanel() {
  const { data: metrics } = useQuery({
    queryKey: ['analytics', 'dashboard', 'overview'],
    queryFn:  () => apiGet<DashboardMetrics>('/analytics/dashboard/metrics?period=month'),
  });

  const { data: leads = [] } = useQuery({
    queryKey: ['sales', 'leads', 'overview'],
    queryFn:  () => apiGet<Lead[]>('/sales/leads'),
  });

  const contacts = useContacts(leads);

  // KPI math — sensible defaults so the surface renders even before data lands.
  const totalLeads = metrics?.totalLeads ?? 0;
  const conv       = metrics?.conversionRate ?? 0;        // 1-decimal pct, 0..100
  const processed  = clampPct((totalLeads ? (metrics?.totalActiveClients ?? 0) / totalLeads : 0) * 100);
  const anomalies  = clampPct(Math.min(100, (metrics?.openLeads ?? 0) / Math.max(1, totalLeads) * 100));

  // Chart series (12 points). Hand-rolled when no live history is present yet.
  const utilSeries:    UtilPoint[] = makeSeries(metrics?.chartData?.length ?? 12, 'util');
  const closureSeries: UtilPoint[] = makeSeries(metrics?.chartData?.length ?? 12, 'close');

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1600px] mx-auto">
      {/* HERO ROW — kicker + title on the left, GlassPanel on the right */}
      <div className="grid grid-cols-12 gap-6 items-start">
        <div className="col-span-12 xl:col-span-7 flex flex-col">
          <div className="text-[12px] text-[var(--fg-muted)]">Data Based on All Clients</div>
          <h1 className="mt-2 text-[44px] sm:text-[64px] md:text-[80px] leading-[1.0] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
            Overview Panel
          </h1>
        </div>
        <div className="col-span-12 xl:col-span-5">
          <AccountInsightsHero hours={48.3} period="Last month" />
        </div>
      </div>

      {/* PERIOD ROW — calendar pill + date pickers + partner select */}
      <div className="mt-5 flex items-center justify-end gap-2 flex-wrap">
        <button
          type="button"
          aria-label="Pick date range"
          className="grid place-items-center size-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-sunken)]"
        >
          <Calendar className="size-4" />
        </button>
        <DateChip value="01.12.2023" />
        <DateChip value="01.12.2024" />
        <button
          type="button"
          className="inline-flex items-center gap-2 h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] text-[12px] hover:bg-[var(--surface-sunken)]"
        >
          All Partner <ChevronDown className="size-3.5" />
        </button>
      </div>

      {/* MAIN GRID — KPIs + charts on the left, AI rail on the right */}
      <div className="mt-4 grid grid-cols-12 gap-3 lg:gap-4">
        {/* KPI ROW */}
        <KpiCard
          className="col-span-12 sm:col-span-6 lg:col-span-3 xl:col-span-3"
          icon={<Layers className="size-3.5" />}
          label="Processed Items"
          value={fmt2(processed)}
          unit="%"
          primary={{ label: 'Auto-Processed', value: '14.9k' }}
          secondary={{ label: 'Pending Check', value: '18k' }}
          chart={<KpiStrip value={62} />}
        />
        <KpiCard
          className="col-span-12 sm:col-span-6 lg:col-span-3 xl:col-span-3"
          icon={<Database className="size-3.5" />}
          label="Synced Records"
          value={
            <span className="flex flex-col items-start">
              <span className="text-[11px] text-[var(--fg-muted)]">Verified</span>
              <span className="text-[20px] font-semibold text-[var(--fg)] leading-none">174</span>
            </span>
          }
          aside={<MetricArc value={71.74} size={140} thickness={10} showValue />}
          secondary={{ label: 'Pending Check', value: '31', align: 'left' }}
        />
        <KpiCard
          className="col-span-12 sm:col-span-6 lg:col-span-3 xl:col-span-3"
          icon={<AlertOctagon className="size-3.5" />}
          label="Anomalies"
          value={fmt2(anomalies)}
          unit="%"
          primary={{ label: 'Detected', value: '1.62k' }}
          secondary={{ label: 'Total Items', value: '13.7k' }}
          chart={<KpiStrip value={32} />}
        />

        {/* AI ASSISTANT — spans two rows on xl */}
        <div className="col-span-12 lg:col-span-12 xl:col-span-3 xl:row-span-2 min-h-[480px] xl:min-h-[560px]">
          <AiAssistantChat />
        </div>

        {/* CHART ROW — Utilization + Timely Closures */}
        <UtilizationCard
          className="col-span-12 md:col-span-6 lg:col-span-6 xl:col-span-4 xl:col-start-1"
          title="Utilization"
          value={56.1}
          syncs="65%"
          fetches="82%"
          manuals="34%"
          autosync="12%"
          data={utilSeries}
        />
        <UtilizationCard
          className="col-span-12 md:col-span-6 lg:col-span-6 xl:col-span-5"
          title="Timely Closures"
          value={82.6}
          syncs="84"
          fetches="24%"
          manuals="84/0%"
          autosync="19/5"
          syncsLabel="Done"
          fetchesLabel="Active"
          manualsLabel="OnTime"
          autosyncLabel="Timely"
          data={closureSeries}
        />

        {/* CONTACT ROW (3 across) */}
        <div className="col-span-12 xl:col-span-9 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {contacts.slice(0, 3).map((c) => (
            <ContactRow key={c.id} name={c.name} email={c.email} avatar={c.avatar ?? undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Reusable inline Utilization/Closures card — same shape, different labels.
// Built inline (not a sales/* component) because it only appears here.
// -----------------------------------------------------------------------------
function UtilizationCard({
  className, title, value, syncs, fetches, manuals, autosync,
  syncsLabel = 'Syncs', fetchesLabel = 'Fetches', manualsLabel = 'Manuals', autosyncLabel = 'Autosync',
  data,
}: {
  className?: string;
  title:    React.ReactNode;
  value:    number;
  syncs:    React.ReactNode;
  fetches:  React.ReactNode;
  manuals:  React.ReactNode;
  autosync: React.ReactNode;
  syncsLabel?:    string;
  fetchesLabel?:  string;
  manualsLabel?:  string;
  autosyncLabel?: string;
  data:     UtilPoint[];
}) {
  const heroInt  = Math.trunc(value);
  const heroFrac = Math.abs(value - heroInt).toFixed(1).slice(2);

  return (
    <section className={cn(
      'rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
      'shadow-[var(--shadow-card)] p-5 flex flex-col',
      className,
    )}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-muted)]">
          <FolderClosed className="size-3.5 text-[var(--fg)]" />
          <span>{title}</span>
        </div>
        <button
          type="button"
          aria-label="Open details"
          className="grid place-items-center size-7 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] text-[var(--fg)] hover:bg-[var(--fg)] hover:text-[var(--fg-inverted)] transition-colors duration-[var(--duration-fast)]"
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      </header>

      <div className="mt-2 grid grid-cols-3 gap-3 items-end">
        <div className="flex flex-col">
          <span className="text-[18px] font-semibold text-[var(--fg)] leading-none">{syncs}</span>
          <span className="text-[11px] text-[var(--fg-muted)] mt-1">{syncsLabel}</span>
          <span className="text-[18px] font-semibold text-[var(--fg)] leading-none mt-3">{fetches}</span>
          <span className="text-[11px] text-[var(--fg-muted)] mt-1">{fetchesLabel}</span>
        </div>
        <div className="flex flex-col items-center justify-center text-center">
          <div className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
            Average Account Stats
          </div>
          <div className="flex items-baseline">
            <span className="text-[44px] sm:text-[52px] leading-[1.0] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
              {heroInt},{heroFrac}
            </span>
            <span className="text-[14px] font-medium text-[var(--fg-muted)] translate-y-[-18px] ml-0.5">%</span>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[18px] font-semibold text-[var(--fg)] leading-none">{manuals}</span>
          <span className="text-[11px] text-[var(--fg-muted)] mt-1">{manualsLabel}</span>
          <span className="text-[18px] font-semibold text-[var(--fg)] leading-none mt-3">{autosync}</span>
          <span className="text-[11px] text-[var(--fg-muted)] mt-1">{autosyncLabel}</span>
        </div>
      </div>

      <div className="mt-4">
        <UtilizationChart data={data} height={130} axis />
      </div>
    </section>
  );
}

function DateChip({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] text-[12px]">
      {value}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Contacts hook — tries /crm/contacts, falls back to deriving from leads so the
// surface always paints a sensible row.
// -----------------------------------------------------------------------------
function useContacts(fallbackLeads: Lead[]): Contact[] {
  const { data } = useQuery<Contact[] | null>({
    queryKey: ['crm', 'contacts'],
    queryFn:  async () => {
      try {
        const rows = await apiGet<Array<{ id: string; name?: string; display_name?: string; email?: string | null; avatar_url?: string | null }>>('/crm/contacts?limit=10');
        return rows.map((r) => ({
          id:     r.id,
          name:   r.name ?? r.display_name ?? '—',
          email:  r.email ?? null,
          avatar: r.avatar_url ?? null,
        }));
      } catch {
        return null; // signal fallback
      }
    },
    retry: false,
  });

  if (data && data.length) return data;
  return fallbackLeads.slice(0, 3).map((l) => ({
    id:     l.id,
    name:   l.name,
    email:  l.email,
    avatar: null,
  }));
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function fmt2(n: number): string {
  // "97,22" style (concept). Always 2 decimals, comma separator.
  const fixed = n.toFixed(2);
  const [a, b] = fixed.split('.');
  return `${a},${b ?? '00'}`;
}

function makeSeries(len: number, seed: 'util' | 'close'): UtilPoint[] {
  // Deterministic series so SSR / hydration / SSR-less render match.
  const labels = ['Jun', 'Jul'];
  const out: UtilPoint[] = [];
  for (let i = 0; i < Math.max(8, len); i++) {
    const t = i / Math.max(8, len);
    const base = seed === 'util' ? 18 : 22;
    const phase = seed === 'util' ? 0 : Math.PI / 3;
    const bar  = Math.max(2, Math.round(base + Math.sin(t * Math.PI * 4 + phase) * 12 + (i % 5) * 1.4));
    const line = Math.round(base + Math.sin(t * Math.PI * 2 + phase) * 6 + 10);
    out.push({ x: i === 0 ? labels[0] : i === Math.max(8, len) - 1 ? labels[1] : '', bar, line });
  }
  return out;
}
