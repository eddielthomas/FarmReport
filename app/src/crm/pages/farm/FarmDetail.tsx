// =============================================================================
// FarmDetail — Report.Farm supplier/farm drill-down (Screen B).
// -----------------------------------------------------------------------------
// Drill into ONE farm: its fields on the map, its monitoring zones and their
// intent, the timeline of what changed, and its open alerts. Wired to the live
// /api/v1/farm/* API:
//   • profile   ← /farm/farms/:id            (boundary + supplier + crops + risk)
//   • parcels   ← /farm/farms/:id/parcels
//   • zones     ← /farm/farms/:id/zones
//   • alerts    ← /farm/alerts?farm_id=:id   (acknowledge → POST /alerts/:id/ack)
//   • signals   ← /farm/observations?farm_id=:id  (EMPTY until P2 — honest state)
//   • report    → POST /farm/reports/generate (field, last 30 days)
//
// Farm id comes from the URL query string (?farm=<uuid>); the dashboard links
// its farm cards to farm-detail.html?farm=:id. No fabricated signals — risk and
// timeline degrade to honest empty-states until the AlphaGeo connection lands.
// =============================================================================

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, MapPinned, Layers, Activity, Radio, FileText,
  CheckCheck, Sprout, ExternalLink, Building2, Gauge, Ruler, Loader2, X,
} from 'lucide-react';
import { apiGet, apiPost } from '@crm/lib/api';
import { RiskPill } from '@crm/components/farm/RiskPill';
import {
  scoreToBand, num,
  type FarmProfile, type FarmAlert, type RiskBand,
} from '@crm/lib/farm-types';
import { FarmMap, type Parcel, type Zone } from '@crm/components/farm/FarmMap';
import { ZoneList } from '@crm/components/farm/ZoneList';
import { SignalTimeline, type Observation } from '@crm/components/farm/SignalTimeline';

// --- Local layout helpers (match PortfolioDashboard conventions) -----------
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

// Alert severity string → risk band (label + icon always attached by RiskPill).
function severityToBand(sev: string | null | undefined): RiskBand {
  switch ((sev ?? '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': case 'moderate': case 'stress': return 'stress';
    case 'low': case 'watch': return 'watch';
    default: return 'healthy';
  }
}

function readFarmId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('farm');
}

export function FarmDetail() {
  const farmId = React.useMemo(readFarmId, []);
  const qc = useQueryClient();
  const [toast, setToast] = React.useState<{ msg: string; reportId?: string } | null>(null);

  const enabled = !!farmId;
  const farm = useQuery({
    queryKey: ['farm', 'profile', farmId],
    queryFn: () => apiGet<FarmProfile>(`/farm/farms/${farmId}`),
    enabled,
  });
  const parcels = useQuery({
    queryKey: ['farm', 'parcels', farmId],
    queryFn: () => apiGet<Parcel[]>(`/farm/farms/${farmId}/parcels`),
    enabled,
  });
  const zones = useQuery({
    queryKey: ['farm', 'zones', farmId],
    queryFn: () => apiGet<Zone[]>(`/farm/farms/${farmId}/zones`),
    enabled,
  });
  const alerts = useQuery({
    queryKey: ['farm', 'farm-alerts', farmId],
    queryFn: () => apiGet<FarmAlert[]>(`/farm/alerts?farm_id=${farmId}`),
    enabled,
  });
  const observations = useQuery({
    queryKey: ['farm', 'observations', farmId],
    queryFn: () => apiGet<Observation[]>(`/farm/observations?farm_id=${farmId}`),
    enabled,
  });

  const ack = useMutation({
    mutationFn: (id: string) => apiPost(`/farm/alerts/${id}/ack`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['farm', 'farm-alerts', farmId] });
      setToast({ msg: 'Alert acknowledged.' });
    },
    onError: () => setToast({ msg: 'Could not acknowledge the alert. Try again.' }),
  });

  const genReport = useMutation({
    mutationFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 86_400_000);
      return apiPost<{ id: string }>('/farm/reports/generate', {
        farm_id: farmId,
        type: 'field',
        period: { start: start.toISOString(), end: end.toISOString() },
      });
    },
    onSuccess: (r) => setToast({ msg: 'Field report generated for the last 30 days.', reportId: r?.id }),
    onError: () => setToast({ msg: 'Report generation failed. Try again.' }),
  });

  // Auto-dismiss toast.
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- No farm selected ---------------------------------------------------
  if (!farmId) {
    return (
      <div className="crm h-full grid place-items-center bg-[var(--bg)] text-[var(--fg)]">
        <div className="text-center px-6">
          <MapPinned className="size-7 mx-auto text-[var(--fg-subtle)]" />
          <h1 className="mt-3 text-[20px] font-semibold font-[var(--font-display)]">No farm selected</h1>
          <p className="mt-1 text-[13px] text-[var(--fg-muted)] max-w-[40ch]">
            Open a farm from the portfolio dashboard to see its fields, zones, and change timeline.
          </p>
          <a
            href="/operations.html"
            className="mt-4 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)] px-3.5 h-9 text-[13px] font-medium shadow-[var(--shadow-accent)]"
          >
            Back to portfolio <ChevronRight className="size-4" />
          </a>
        </div>
      </div>
    );
  }

  const f = farm.data;
  const band: RiskBand | null = f ? (f.latest_risk_band ?? scoreToBand(f.latest_risk_score)) : null;
  const openAlerts = (alerts.data ?? []).filter((a) => a.status === 'open').length;
  const zoneList = zones.data ?? [];

  return (
    <div className="crm h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-[1500px] px-5 sm:px-8 py-6 space-y-6">

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]" aria-label="Breadcrumb">
          <a href="/operations.html" className="hover:text-[var(--accent)] transition-colors">Portfolio</a>
          <ChevronRight className="size-3" />
          <span>{f?.supplier_name ?? 'Supplier'}</span>
          <ChevronRight className="size-3" />
          <span className="text-[var(--fg-muted)]">{f?.name ?? '…'}</span>
        </nav>

        {/* Farm header */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[var(--tracking-widest)] text-[var(--fg-subtle)]">
              Supplier Farm
            </div>
            <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-[var(--tracking-tight)] font-[var(--font-display)] flex items-center gap-2">
              <Sprout className="size-6 text-[var(--risk-healthy)]" />
              {f?.name ?? (farm.isLoading ? 'Loading farm…' : 'Farm')}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--fg-muted)]">
              <span className="inline-flex items-center gap-1.5"><Building2 className="size-3.5" />{f?.supplier_name ?? 'Direct'}</span>
              <span className="inline-flex items-center gap-1.5 tabular-nums"><Ruler className="size-3.5" />{num(f?.total_area_ha).toLocaleString()} ha</span>
              {(f?.crops ?? []).length > 0 && (
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  {f!.crops.map((c) => (
                    <span key={c} className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[11px] capitalize">{c}</span>
                  ))}
                </span>
              )}
            </div>
          </div>

          {/* KPI chips */}
          <div className="flex items-center gap-2.5">
            <KpiChip icon={<Gauge className="size-3.5" />} label="Farm Health"
              value={f?.latest_risk_score != null ? Math.round(num(f.latest_risk_score)).toString() : '—'}
              unit={f?.latest_risk_score != null ? '/100' : undefined} />
            <KpiChip icon={<Radio className="size-3.5" />} label="Active Signals" value={String(openAlerts)} />
            <div className="self-stretch flex items-center pl-1">
              <RiskPill band={band} score={f?.latest_risk_score != null ? num(f.latest_risk_score) : null} />
            </div>
          </div>
        </header>

        {/* Zones · Map · Timeline */}
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Zones */}
          <Panel className="xl:col-span-1 order-2 xl:order-1">
            <SectionHead icon={<Layers className="size-4" />} title="Monitoring Zones"
              right={<span className="text-[11px] text-[var(--fg-subtle)]">{zoneList.length}</span>} />
            {zones.isLoading ? <EmptyNote>Loading zones…</EmptyNote>
              : zones.isError ? <EmptyNote>Couldn't load zones.</EmptyNote>
              : <ZoneList zones={zoneList} />}
          </Panel>

          {/* Map */}
          <div className="xl:col-span-2 order-1 xl:order-2">
            <div className="h-[440px]">
              <FarmMap
                boundary={(f?.boundaries as GeoJSON.MultiPolygon | null) ?? null}
                parcels={parcels.data ?? []}
                zones={zoneList}
                className="h-full"
              />
            </div>
          </div>

          {/* Signal timeline */}
          <Panel className="xl:col-span-1 order-3">
            <SectionHead icon={<Activity className="size-4" />} title="Signal Timeline" />
            {observations.isLoading ? <EmptyNote>Loading signals…</EmptyNote>
              : <SignalTimeline observations={observations.data ?? []} />}
          </Panel>
        </div>

        {/* Alerts + report action */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <Panel className="xl:col-span-2">
            <SectionHead icon={<Radio className="size-4" />} title="Alerts"
              right={<span className="text-[11px] text-[var(--fg-subtle)]">{alerts.data?.length ?? 0}</span>} />
            {alerts.isLoading ? (
              <EmptyNote>Loading alerts…</EmptyNote>
            ) : (alerts.data?.length ?? 0) === 0 ? (
              <EmptyNote>
                No alerts for this farm. Threshold crossings appear here automatically once satellite
                passes are ingested.
              </EmptyNote>
            ) : (
              <ul className="space-y-2.5">
                {alerts.data!.map((a) => {
                  const conf = a.confidence != null ? num(a.confidence) : null;
                  const isOpen = a.status === 'open';
                  return (
                    <li key={a.id} className="rounded-[var(--radius-lg)] border border-[var(--border)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <RiskPill band={severityToBand(a.severity)} size="sm" />
                            <span className="text-[12px] font-semibold text-[var(--fg)]">{a.title}</span>
                            {a.category && (
                              <span className="rounded-[var(--radius-full)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">{a.category}</span>
                            )}
                          </div>
                          {a.summary && <p className="mt-1 text-[12px] text-[var(--fg-muted)]">{a.summary}</p>}
                          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-[var(--fg-subtle)]">
                            {conf != null && <span className="tabular-nums">Confidence {Math.round(conf * 100)}%</span>}
                            <span className="capitalize">{a.status}</span>
                          </div>
                        </div>
                        {isOpen ? (
                          <button
                            type="button"
                            onClick={() => ack.mutate(a.id)}
                            disabled={ack.isPending && ack.variables === a.id}
                            className="shrink-0 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] px-2.5 h-7 text-[11px] font-medium text-[var(--fg)] hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)] disabled:opacity-50"
                          >
                            {ack.isPending && ack.variables === a.id
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <CheckCheck className="size-3.5" />}
                            Acknowledge
                          </button>
                        ) : (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--risk-healthy)]">
                            <CheckCheck className="size-3.5" /> Ack’d
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          {/* Field report */}
          <Panel>
            <SectionHead icon={<FileText className="size-4" />} title="Field Report" />
            <p className="text-[12px] text-[var(--fg-muted)]">
              Generate a print-grade field report for this farm covering the last 30 days —
              health, zone status, and any change events on record.
            </p>
            <button
              type="button"
              onClick={() => genReport.mutate()}
              disabled={genReport.isPending}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)] h-9 text-[13px] font-medium shadow-[var(--shadow-accent)] hover:bg-[var(--accent-strong)] transition-colors duration-[var(--duration-fast)] disabled:opacity-60"
            >
              {genReport.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
              {genReport.isPending ? 'Generating…' : 'Generate field report'}
            </button>
            {genReport.data?.id && (
              <a
                href={`/report.html?report=${genReport.data.id}`}
                className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] text-[var(--accent)] hover:text-[var(--accent-strong)]"
              >
                View generated report <ExternalLink className="size-3.5" />
              </a>
            )}
          </Panel>
        </div>

        <p className="text-center text-[11px] text-[var(--fg-subtle)] pb-4">
          Field geometry and zone intents are live. Risk scores and the change timeline populate once the
          AlphaGeo satellite connection ingests observations for this farm's AOI.
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-elevated)] shadow-[var(--shadow-overlay)] px-4 py-3 text-[13px] text-[var(--fg)] max-w-[360px]"
          style={{ animation: 'var(--duration-normal) ease-out' }}
        >
          <CheckCheck className="size-4 text-[var(--accent)] shrink-0" />
          <div className="min-w-0">
            <div>{toast.msg}</div>
            {toast.reportId && (
              <a href={`/report.html?report=${toast.reportId}`} className="text-[var(--accent)] hover:text-[var(--accent-strong)] inline-flex items-center gap-1 mt-0.5">
                Open report <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className="ml-auto text-[var(--fg-subtle)] hover:text-[var(--fg)]">
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// Compact KPI chip for the header row.
function KpiChip({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-soft)]">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">
        {icon}{label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-0.5">
        <span className="text-[20px] font-semibold tabular-nums font-[var(--font-display)] text-[var(--fg)]">{value}</span>
        {unit && <span className="text-[11px] text-[var(--fg-muted)]">{unit}</span>}
      </div>
    </div>
  );
}
