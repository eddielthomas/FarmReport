// =============================================================================
// OperationsDashboard — unified ops view (S7C re-skin)
// -----------------------------------------------------------------------------
// IA preserved (KPI strip, compact case board, escalations panel, team
// workload). Visual layer rewritten on tokens + KpiCard. The map iframe area
// is intentionally NOT introduced here — this view is the surrounding chrome
// for the case board only; the map itself lives at /dashboard.html.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import type { Case, CaseStatus, Team, DashboardMetrics } from '@crm/lib/types';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@crm/components/ui/card';
import { Badge, statusVariant } from '@crm/components/ui/badge';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { formatRelative, cn } from '@crm/lib/utils';
import { AlertTriangle, Users2, ClipboardList, ShieldAlert, Activity, TrendingUp } from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';
import { FieldOpsPanel } from '@crm/components/field/FieldOpsPanel';
import { useAuthStore } from '@crm/lib/auth-store';

const STATUSES: CaseStatus[] = ['open', 'assigned', 'in_progress', 'blocked', 'closed'];

const STATUS_LABEL: Record<CaseStatus, string> = {
  open:        'Open',
  assigned:    'Assigned',
  in_progress: 'In Progress',
  blocked:     'Blocked',
  closed:      'Closed',
};

export function OperationsDashboard() {
  const { data: cases = [] } = useQuery({ queryKey: ['cases'], queryFn: () => apiGet<Case[]>('/ops/cases') });
  const { data: teams = [] } = useQuery({ queryKey: ['staff-teams'], queryFn: () => apiGet<Team[]>('/iam/teams') });
  const { data: metrics } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn:  () => apiGet<DashboardMetrics>('/analytics/dashboard/metrics').catch(() => null),
  });

  // Sprint 9.1 — only dispatchers see the FieldOpsPanel. ops.field_specialist
  // is an internal worker (not a dispatcher), so even when they reach this
  // surface the live-tech panel is hidden. Recognised dispatchers:
  //   * platform:admin  (legacy super-user)
  //   * ops:manage      (legacy bundle held by ops.manager + ops.coordinator
  //                     via the canonical roles seed; the auth-store hydrates
  //                     it from user_profile.roles)
  //   * ops.coordinator (canonical role key on user_profile.roles for users
  //                     created post-S9.1)
  const userRoles = useAuthStore((s) => s.user?.roles) ?? [];
  const canDispatch =
    userRoles.includes('platform:admin') ||
    userRoles.includes('ops:manage') ||
    userRoles.includes('ops.coordinator') ||
    userRoles.includes('ops.manager');

  const grouped = useMemo(() => {
    const g: Record<CaseStatus, Case[]> = { open: [], assigned: [], in_progress: [], blocked: [], closed: [] };
    cases.forEach((c) => { (g[c.status] ??= []).push(c); });
    return g;
  }, [cases]);

  const escalations = useMemo(() => {
    const out: Array<{ case: Case; at: string }> = [];
    for (const c of cases) {
      if (c.detection_id) out.push({ case: c, at: c.opened_at });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  }, [cases]);

  const workload = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cases) {
      if (c.status === 'closed') continue;
      for (const a of c.assignments ?? []) {
        if (a.released_at === null) map.set(a.assignee_id, (map.get(a.assignee_id) ?? 0) + 1);
      }
    }
    return map;
  }, [cases]);

  const openCount     = grouped.open.length + grouped.assigned.length + grouped.in_progress.length;
  const blockedCount  = grouped.blocked.length;
  const highPriority  = cases.filter(c => c.priority === 'high' || c.priority === 'critical').length;
  const escalCount    = cases.filter(c => c.detection_id).length;

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--fg)]">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1500px] mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Operations
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] leading-tight">
              Field operations overview
            </h1>
            <div className="text-[12px] text-[var(--fg-muted)] mt-0.5">
              Cases, escalations, and team workload — live across all statuses.
            </div>
          </div>
        </header>

        {/* ---- S9B: live Field Ops panel (techs in the field) -------------
           * S9.1: gated to dispatchers only. ops.field_specialist users get
           * the case board + KPI strip but not the live tech map. */}
        {canDispatch && <FieldOpsPanel />}

        {/* ---- KPI strip -------------------------------------------------- */}
        <div data-coachmark="ops.kpis" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard icon={<ClipboardList className="size-3.5" />} label="Open cases"   value={openCount} tint="accent" />
          <KpiCard icon={<ShieldAlert className="size-3.5" />}   label="Blocked"       value={blockedCount} tint="red" />
          <KpiCard icon={<AlertTriangle className="size-3.5" />} label="High priority" value={highPriority} tint="orange" />
          <KpiCard icon={<Activity className="size-3.5" />}      label="Escalations"   value={escalCount} tint="cyan" />
          <KpiCard icon={<Users2 className="size-3.5" />}        label="Active teams"  value={teams.length} tint="cyan" />
          <KpiCard icon={<TrendingUp className="size-3.5" />}    label="Active leads"  value={metrics?.openLeads ?? '—'} tint="green" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* ---- Case board (compact) ------------------------------------ */}
          <Card data-coachmark="ops.board" className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Case board</CardTitle>
              <CardDescription>{cases.length} total · live across all statuses</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {STATUSES.map((s) => (
                <div
                  key={s}
                  className={cn(
                    'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)]',
                    'p-2 space-y-2',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <Badge variant={statusVariant(s)} size="sm">{STATUS_LABEL[s]}</Badge>
                    <span className="text-[11px] font-medium text-[var(--fg)]">{grouped[s].length}</span>
                  </div>
                  <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-0.5">
                    {grouped[s].slice(0, 8).map((c) => (
                      <a
                        key={c.id}
                        href={`/pm.html#case-${c.id}`}
                        className={cn(
                          'block rounded-[var(--radius-md)] p-2',
                          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
                          'hover:border-[var(--border-strong)]',
                          'transition-colors duration-[var(--duration-fast)]',
                        )}
                      >
                        <div className="text-[11px] font-medium truncate">{c.title}</div>
                        <div className="flex items-center justify-between mt-1">
                          <Badge variant={statusVariant(c.priority)} size="sm">{c.priority}</Badge>
                          <span className="text-[10px] text-[var(--fg-muted)]">{formatRelative(c.opened_at)}</span>
                        </div>
                      </a>
                    ))}
                    {grouped[s].length === 0 && (
                      <div className="text-[10px] text-[var(--fg-subtle)] text-center">—</div>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* ---- Recent escalations -------------------------------------- */}
          <Card data-coachmark="ops.escal">
            <CardHeader>
              <CardTitle>Recent escalations</CardTitle>
              <CardDescription>Cases auto-created from map detections</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[440px] overflow-y-auto">
              {escalations.map(({ case: c }) => (
                <a
                  key={c.id}
                  href={`/pm.html#case-${c.id}`}
                  className={cn(
                    'block rounded-[var(--radius-md)] p-3 space-y-1.5',
                    'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
                    'hover:border-[var(--border-strong)]',
                    'transition-colors duration-[var(--duration-fast)]',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <Badge variant={statusVariant(c.priority)} size="sm">{c.priority}</Badge>
                    <span className="text-[10px] text-[var(--fg-muted)]">{formatRelative(c.opened_at)}</span>
                  </div>
                  <div className="text-[12px] font-medium truncate">{c.title}</div>
                  {c.detection_id && (
                    <div className="flex items-center gap-1 text-[10px] font-mono text-[var(--fg-muted)]">
                      <AlertTriangle className="size-3" />
                      {c.detection_id}
                    </div>
                  )}
                </a>
              ))}
              {escalations.length === 0 && (
                <div className="text-[11px] text-[var(--fg-subtle)] text-center p-3">No recent escalations</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---- Team workload ---------------------------------------------- */}
        <Card data-coachmark="ops.teams">
          <CardHeader>
            <CardTitle>Team workload</CardTitle>
            <CardDescription>Active assignments by team member</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {teams.map((t) => (
              <div
                key={t.id}
                className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[13px] font-semibold text-[var(--fg)]">{t.name}</div>
                  <span className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                    {t.members.length} members
                  </span>
                </div>
                <div className="space-y-1.5">
                  {t.members.map((m) => {
                    const count = workload.get(m.user_id) ?? 0;
                    const tone =
                      count === 0 ? 'text-[var(--fg-muted)]' :
                      count > 3   ? 'text-[var(--orange)]'   :
                                    'text-[var(--fg)]';
                    return (
                      <div key={m.user_id} className="flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[var(--fg)] truncate">{m.display_name}</span>
                          <Badge variant="outline" size="sm">{m.role}</Badge>
                        </div>
                        <span className={cn('font-medium font-mono', tone)}>
                          {count} active
                        </span>
                      </div>
                    );
                  })}
                  {t.members.length === 0 && (
                    <div className="text-[10px] text-[var(--fg-subtle)]">No members</div>
                  )}
                </div>
              </div>
            ))}
            {teams.length === 0 && (
              <div className="col-span-2 text-[11px] text-[var(--fg-subtle)] text-center p-3">No teams configured</div>
            )}
          </CardContent>
        </Card>
        <CoachmarkTour tourId={TOURS.operations.id} steps={TOURS.operations.steps} />
      </div>
    </div>
  );
}
