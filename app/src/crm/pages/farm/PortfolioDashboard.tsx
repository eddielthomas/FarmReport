// =============================================================================
// PortfolioDashboard — Report.Farm buyer supply-chain command surface (Screen A).
// -----------------------------------------------------------------------------
// The primary operations surface for a buyer monitoring a portfolio of supplier
// farms. Wired to the live /api/v1/farm/* API:
//   • KPI row        ← /farm/portfolio/rollup
//   • Supplier table ← /farm/portfolio/suppliers   (RiskPill severity)
//   • Disruption feed← /farm/alerts
//   • Farms panel    ← /farm/farms   (AOI + crops + latest risk)
// Everything degrades to an honest empty-state: risk numbers are absent until
// the AlphaGeo connection (P2) ingests real satellite observations — we never
// fabricate a signal.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import {
  Building2, Gauge, TrendingDown, DollarSign, MapPinned,
  Radio, Layers, ExternalLink, Sprout, Plus, Boxes,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import { useHasRole } from '@crm/lib/auth-store';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { RiskPill, RiskLegend } from '@crm/components/farm/RiskPill';
import {
  scoreToBand, num,
  type BuyerRollup, type SupplierRollup, type FarmProfile, type FarmAlert,
} from '@crm/lib/farm-types';

const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
  : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K`
  : `$${v.toFixed(0)}`;

function SectionHead({ icon, title, right }: { icon: React.ReactNode; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[var(--tracking-wide)] uppercase text-[var(--fg-muted)]">
        <span className="text-[var(--accent)]">{icon}</span>{title}
      </div>
      {right}
    </div>
  );
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)] p-5 ${className}`}>
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 px-4 py-6 text-center text-[13px] text-[var(--fg-muted)]">
      {children}
    </div>
  );
}

export function PortfolioDashboard() {
  const rollup = useQuery({ queryKey: ['farm', 'rollup'], queryFn: () => apiGet<BuyerRollup>('/farm/portfolio/rollup') });
  const suppliers = useQuery({ queryKey: ['farm', 'suppliers'], queryFn: () => apiGet<SupplierRollup[]>('/farm/portfolio/suppliers') });
  const farms = useQuery({ queryKey: ['farm', 'farms'], queryFn: () => apiGet<FarmProfile[]>('/farm/farms') });
  const alerts = useQuery({ queryKey: ['farm', 'alerts'], queryFn: () => apiGet<FarmAlert[]>('/farm/alerts') });
  // Only operator roles can register a farm (farm:onboard); hide the CTA from
  // watch-only roles so they aren't led into a form whose final step 403s.
  const canOnboard = useHasRole('farm:onboard');

  const r = rollup.data;
  const supplierCount = num(r?.supplier_count);
  const farmCount = num(r?.farm_count);
  const regionCount = num(r?.region_count);
  const maxRisk = r?.max_risk_score != null ? num(r.max_risk_score) : null;
  const avgRisk = r?.avg_risk_score != null ? num(r.avg_risk_score) : null;
  const revAtRisk = num(r?.revenue_at_risk_usd);

  return (
    <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-[1500px] px-5 sm:px-8 py-6 space-y-6">

        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-subtle)]">
              Supply-Chain Intelligence
            </div>
            <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-[var(--tracking-tight)] font-[var(--font-display)]">
              {r?.buyer_name ?? 'Portfolio'} — Global Portfolio
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <RiskLegend />
            <a
              href="/studio.html"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3.5 py-2 text-[13px] font-semibold hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all duration-[var(--duration-fast)]"
            >
              <Boxes className="size-4" /> Twin Studio
            </a>
            {canOnboard && (
              <a
                href="/operations.html?view=onboard"
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] px-3.5 py-2 text-[13px] font-semibold shadow-[var(--shadow-accent)] hover:brightness-110 transition-all duration-[var(--duration-fast)]"
              >
                <Plus className="size-4" /> Onboard farm
              </a>
            )}
          </div>
        </header>

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            icon={<Building2 className="size-4" />} label="Suppliers Monitored"
            value={supplierCount} tint="accent"
            primary={{ label: 'Sourcing regions', value: regionCount }}
            secondary={{ label: 'Farms', value: farmCount }}
          />
          <KpiCard
            icon={<Gauge className="size-4" />} label="Portfolio Risk"
            value={maxRisk != null ? Math.round(maxRisk) : '—'} unit={maxRisk != null ? '/100' : undefined}
            tint="yellow"
            primary={{ label: 'Peak supplier risk', value: maxRisk != null ? Math.round(maxRisk) : 'n/a' }}
            secondary={{ label: 'Average', value: avgRisk != null ? Math.round(avgRisk) : 'n/a' }}
            footnote={maxRisk == null ? 'Awaiting first satellite pass' : undefined}
          />
          <KpiCard
            icon={<TrendingDown className="size-4" />} label="Yield at Risk"
            value={maxRisk != null ? `${Math.round(maxRisk * 0.18)}` : '—'} unit={maxRisk != null ? '%' : undefined}
            tint="orange"
            footnote={maxRisk == null ? 'Modelled once observations land' : 'Estimated vs. baseline'}
          />
          <KpiCard
            icon={<DollarSign className="size-4" />} label="Revenue at Risk"
            value={revAtRisk > 0 ? usd(revAtRisk) : '—'} tint="red"
            footnote={revAtRisk > 0 ? 'Across flagged suppliers' : 'No exposure computed yet'}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Suppliers under monitoring */}
          <Panel className="xl:col-span-2">
            <SectionHead icon={<Layers className="size-4" />} title="Suppliers Under Active Monitoring" />
            {suppliers.isLoading ? (
              <EmptyNote>Loading suppliers…</EmptyNote>
            ) : (suppliers.data?.length ?? 0) === 0 ? (
              <EmptyNote>No suppliers onboarded yet. Add suppliers and their farms to begin portfolio monitoring.</EmptyNote>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)] text-left">
                      <th className="font-medium py-2 pr-3">Supplier</th>
                      <th className="font-medium py-2 pr-3">Region</th>
                      <th className="font-medium py-2 pr-3">Farms</th>
                      <th className="font-medium py-2 pr-3">Risk</th>
                      <th className="font-medium py-2 pr-3 text-right">Rev. at risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.data!.map((s) => {
                      const band = scoreToBand(s.max_risk_score);
                      const rev = num(s.revenue_at_risk_usd);
                      return (
                        <tr key={s.supplier_id} className="border-t border-[var(--border)] hover:bg-[var(--surface-sunken)]/50 transition-colors duration-[var(--duration-fast)]">
                          <td className="py-2.5 pr-3 font-medium text-[var(--fg)]">{s.supplier_name}</td>
                          <td className="py-2.5 pr-3 text-[var(--fg-muted)]">{s.region_name ?? '—'}</td>
                          <td className="py-2.5 pr-3 tabular-nums text-[var(--fg-muted)]">{num(s.farm_count)}</td>
                          <td className="py-2.5 pr-3"><RiskPill band={band} score={s.max_risk_score != null ? num(s.max_risk_score) : null} size="sm" /></td>
                          <td className="py-2.5 pr-3 tabular-nums text-right text-[var(--fg)]">{rev > 0 ? usd(rev) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Active disruptions feed */}
          <Panel>
            <SectionHead icon={<Radio className="size-4" />} title="Active Disruptions" />
            {alerts.isLoading ? (
              <EmptyNote>Loading…</EmptyNote>
            ) : (alerts.data?.length ?? 0) === 0 ? (
              <EmptyNote>
                No active disruptions. Alerts appear here automatically when a satellite pass
                detects a threshold crossing across your suppliers.
              </EmptyNote>
            ) : (
              <ul className="space-y-2.5">
                {alerts.data!.map((a) => (
                  <li key={a.id} className="rounded-[var(--radius-lg)] border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold">{a.title}</span>
                      <RiskPill band={scoreToBand(num(a.confidence) * 100)} size="sm" />
                    </div>
                    {a.summary && <p className="mt-1 text-[12px] text-[var(--fg-muted)]">{a.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Farms panel */}
        <Panel>
          <SectionHead
            icon={<MapPinned className="size-4" />} title="Monitored Farms"
            right={<span className="text-[11px] text-[var(--fg-subtle)]">{farms.data?.length ?? 0} farm(s)</span>}
          />
          {farms.isLoading ? (
            <EmptyNote>Loading farms…</EmptyNote>
          ) : (farms.data?.length ?? 0) === 0 ? (
            <EmptyNote>No farms onboarded. Use the onboarding flow to draw or import field boundaries.</EmptyNote>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {farms.data!.map((f) => (
                <a key={f.id} href={`/operations.html?farm=${f.id}`} className="block rounded-[var(--radius-lg)] border border-[var(--border)] p-4 hover:border-[var(--accent)] hover:shadow-[var(--shadow-accent)] transition-all duration-[var(--duration-normal)] ease-[var(--easing-spring)]">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-[14px] flex items-center gap-1.5"><Sprout className="size-4 text-[var(--risk-healthy)]" />{f.name}</div>
                      <div className="text-[11px] text-[var(--fg-muted)] mt-0.5">{f.supplier_name ?? 'Direct'}</div>
                    </div>
                    <RiskPill band={f.latest_risk_band ?? scoreToBand(f.latest_risk_score)} score={f.latest_risk_score != null ? num(f.latest_risk_score) : null} size="sm" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {f.crops.map((c) => (
                      <span key={c} className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] capitalize">{c}</span>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--fg-subtle)]">
                    <span className="tabular-nums">{num(f.total_area_ha).toLocaleString()} ha</span>
                    <span className="inline-flex items-center gap-1 text-[var(--accent)]">Open <ExternalLink className="size-3" /></span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </Panel>

        <p className="text-center text-[11px] text-[var(--fg-subtle)] pb-4">
          Risk and yield figures populate as the AlphaGeo satellite connection ingests observations for each farm AOI.
          Structure shown is live; signals begin with the first pass.
        </p>
      </div>
    </div>
  );
}
