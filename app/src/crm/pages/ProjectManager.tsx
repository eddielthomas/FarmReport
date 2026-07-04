// =============================================================================
// ProjectManager — case-board surface (S7C re-skin)
// -----------------------------------------------------------------------------
// Information architecture is preserved (case board, stale strip, detail rail,
// new-case form). Cinematic styling replaced with token primitives:
//   - 5 KpiCard tiles for the per-status counters at the top.
//   - PillTabs for the status filter (all / open / assigned / in_progress /
//     blocked / closed).
//   - Card surfaces for each case column.
//   - Badge for status / priority chips using the new taxonomy.
// =============================================================================

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '@crm/lib/api';
import type { Case, CaseStatus, TenantUser } from '@crm/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@crm/components/ui/card';
import { Badge, statusVariant } from '@crm/components/ui/badge';
import { Button } from '@crm/components/ui/button';
import { Input, Textarea, Label } from '@crm/components/ui/input';
import { KpiCard } from '@crm/components/ui/kpi-card';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { formatRelative, cn } from '@crm/lib/utils';
import {
  Plus, AlertTriangle, UserCheck, X, ClipboardList, ListChecks,
  Activity, ShieldAlert, CheckCheck,
} from 'lucide-react';
import { CoachmarkTour } from '@crm/components/ui/coachmark';
import { TOURS } from '@crm/lib/tours';
import { ProjectsPanel } from '@crm/components/projects/ProjectsPanel';
import { RegistrationPanel } from '@crm/components/registration/RegistrationPanel';

const STATUSES: CaseStatus[] = ['open', 'assigned', 'in_progress', 'blocked', 'closed'];

type StatusFilter = 'all' | CaseStatus;

const FILTER_ITEMS: ReadonlyArray<PillTabItem<StatusFilter>> = [
  { key: 'all',         label: 'All' },
  { key: 'open',        label: 'Open' },
  { key: 'assigned',    label: 'Assigned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked',     label: 'Blocked' },
  { key: 'closed',      label: 'Closed' },
];

const STATUS_LABEL: Record<CaseStatus, string> = {
  open:        'Open',
  assigned:    'Assigned',
  in_progress: 'In Progress',
  blocked:     'Blocked',
  closed:      'Closed',
};

const STATUS_ICON: Record<CaseStatus, React.ReactNode> = {
  open:        <ClipboardList className="size-3.5" />,
  assigned:    <ListChecks className="size-3.5" />,
  in_progress: <Activity className="size-3.5" />,
  blocked:     <ShieldAlert className="size-3.5" />,
  closed:      <CheckCheck className="size-3.5" />,
};

export function ProjectManager() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const { data: cases = [], isLoading } = useQuery({
    queryKey: ['cases'],
    queryFn: () => apiGet<Case[]>('/ops/cases'),
  });

  const grouped = useMemo(() => {
    const g: Record<CaseStatus, Case[]> = { open: [], assigned: [], in_progress: [], blocked: [], closed: [] };
    cases.forEach((c) => { (g[c.status] ??= []).push(c); });
    return g;
  }, [cases]);

  // Stale cases: blocked >7d or assigned >14d without movement.
  const stale = useMemo(() => {
    const now = Date.now();
    const DAY = 86_400_000;
    return cases.filter((c) => {
      if (c.status === 'closed') return false;
      const age = (now - new Date(c.opened_at).getTime()) / DAY;
      if (c.status === 'blocked'  && age > 7)  return true;
      if (c.status === 'assigned' && age > 14) return true;
      return false;
    }).slice(0, 6);
  }, [cases]);

  const transition = useMutation({
    mutationFn: ({ id, to }: { id: string; to: CaseStatus }) =>
      apiPut(`/ops/cases/${id}`, { status: to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cases'] }),
  });

  const selected = cases.find((c) => c.id === selectedId) ?? null;

  const visibleStatuses: CaseStatus[] = filter === 'all' ? STATUSES : [filter];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] h-full bg-[var(--bg)] text-[var(--fg)]">
      <section className="flex flex-col overflow-y-auto min-h-0 p-4 sm:p-5 gap-4">
        {/* ---- Header --------------------------------------------------- */}
        <header className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              Case Board
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)] leading-tight">
              {cases.length} {cases.length === 1 ? 'case' : 'cases'} total
            </h1>
          </div>
          <Button size="md" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New case
          </Button>
        </header>

        {/* ---- Projects & Scans (client / project / scan management) ----- */}
        <ProjectsPanel />

        {/* ---- Portal registrations (self-service request review + codes) - */}
        <RegistrationPanel />

        {/* ---- KPI strip: per-status counters --------------------------- */}
        <div data-coachmark="pm.kpis" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {STATUSES.map((s) => (
            <KpiCard
              key={s}
              icon={STATUS_ICON[s]}
              label={STATUS_LABEL[s]}
              value={grouped[s].length}
              tint={s === 'blocked' ? 'red' : s === 'closed' ? 'green' : 'accent'}
              footnote={s === 'blocked' && grouped[s].length > 0 ? 'Needs unblocking' : undefined}
              onAction={() => setFilter(s)}
            />
          ))}
        </div>

        {/* ---- Stale strip ---------------------------------------------- */}
        {stale.length > 0 && (
          <Card data-coachmark="pm.stale" className="border-[var(--red)]/30">
            <div className="flex items-center gap-2 p-3">
              <AlertTriangle className="size-4 text-[var(--red)] shrink-0" />
              <div className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--red)] shrink-0 font-semibold">
                Stale · {stale.length}
              </div>
              <div className="flex gap-2 overflow-x-auto min-w-0">
                {stale.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'shrink-0 px-2.5 py-1 rounded-[var(--radius-full)]',
                      'text-[11px] font-medium',
                      'border border-[var(--red)]/40 bg-[color-mix(in_oklch,var(--red)_8%,transparent)]',
                      'text-[var(--fg)] hover:bg-[color-mix(in_oklch,var(--red)_14%,transparent)]',
                      'transition-colors duration-[var(--duration-fast)]',
                      'truncate max-w-[180px]',
                    )}
                    title={`${c.status} · ${formatRelative(c.opened_at)}`}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        )}

        {/* ---- Filter pills --------------------------------------------- */}
        <div data-coachmark="pm.filter" className="flex items-center justify-between gap-3 flex-wrap">
          <PillTabs<StatusFilter>
            value={filter}
            onChange={setFilter}
            items={FILTER_ITEMS}
            size="md"
            aria-label="Case status filter"
          />
        </div>

        {/* ---- Board ---------------------------------------------------- */}
        <div
          data-coachmark="pm.board"
          className={cn(
            'grid gap-3 flex-1 min-h-0',
            filter === 'all'
              ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-5'
              : 'grid-cols-1',
          )}
        >
          {visibleStatuses.map((status) => (
            <Card key={status} className="flex flex-col overflow-hidden min-h-0">
              <CardHeader className="pb-3 flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  {STATUS_ICON[status]}
                  <span>{STATUS_LABEL[status]}</span>
                </CardTitle>
                <Badge variant="soft" size="sm">{grouped[status].length}</Badge>
              </CardHeader>
              <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
                {isLoading && (
                  <div className="text-[11px] text-[var(--fg-muted)] p-2">Loading…</div>
                )}
                {grouped[status].map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'w-full text-left rounded-[var(--radius-lg)] p-3 space-y-2',
                      'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
                      'hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-soft)]',
                      'transition-colors duration-[var(--duration-fast)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                      selectedId === c.id && 'border-[var(--fg)] shadow-[var(--shadow-card)]',
                    )}
                  >
                    <div className="text-[12px] font-medium text-[var(--fg)] line-clamp-2">{c.title}</div>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={statusVariant(c.priority)} size="sm">{c.priority}</Badge>
                      <span className="text-[10px] text-[var(--fg-muted)]">{formatRelative(c.opened_at)}</span>
                    </div>
                    {c.detection_id && (
                      <a
                        href={`/dashboard.html#detection-${c.detection_id}`}
                        className="flex items-center gap-1 text-[10px] font-mono text-[var(--fg-muted)] hover:text-[var(--fg)] hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <AlertTriangle className="size-3" />
                        {c.detection_id}
                      </a>
                    )}
                    {status !== 'closed' && (
                      <select
                        value={c.status}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => transition.mutate({ id: c.id, to: e.target.value as CaseStatus })}
                        aria-label="Transition status"
                        className={cn(
                          'w-full h-7 px-2 rounded-[var(--radius-md)]',
                          'border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--fg)]',
                          'text-[11px]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                        )}
                      >
                        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                      </select>
                    )}
                  </button>
                ))}
                {grouped[status].length === 0 && !isLoading && (
                  <div className="text-[11px] text-[var(--fg-subtle)] text-center p-4">
                    Empty
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <aside
        data-coachmark="pm.detail"
        className={cn(
          'border-t lg:border-t-0 lg:border-l border-[var(--border)]',
          'bg-[var(--bg-elevated)] overflow-y-auto max-h-[40vh] lg:max-h-none',
        )}
      >
        {creating ? (
          <NewCaseForm onClose={() => setCreating(false)} onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['cases'] }); }} />
        ) : selected ? (
          <CaseDetail caseId={selected.id} />
        ) : (
          <div className="p-6 text-center text-[12px] text-[var(--fg-muted)]">
            Select a case to view its detail
          </div>
        )}
      </aside>
      <CoachmarkTour tourId={TOURS.pm.id} steps={TOURS.pm.steps} />
    </div>
  );
}

// -----------------------------------------------------------------------------
function NewCaseForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium', detection_id: '' });
  const [submitting, setSubmitting] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSubmitting(true);
    try { await apiPost('/ops/cases', form); onCreated(); }
    catch (err) { console.error(err); }
    finally { setSubmitting(false); }
  }
  return (
    <form onSubmit={submit} className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-semibold text-[var(--fg)]">New case</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="size-7 grid place-items-center rounded-[var(--radius-full)] text-[var(--fg-muted)] hover:text-[var(--red)] hover:bg-[var(--surface-sunken)]"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="space-y-1">
        <Label htmlFor="nc-title">Title</Label>
        <Input id="nc-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="nc-desc">Description</Label>
        <Textarea id="nc-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="nc-det">Detection ID</Label>
        <Input id="nc-det" value={form.detection_id} onChange={(e) => setForm({ ...form, detection_id: e.target.value })} placeholder="DET-1234" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="nc-pri">Priority</Label>
        <select
          id="nc-pri"
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value })}
          className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {['low','medium','high','critical'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <Button type="submit" disabled={submitting} className="w-full" size="md">
        {submitting ? 'Creating…' : 'Create case'}
      </Button>
    </form>
  );
}

// -----------------------------------------------------------------------------
function CaseDetail({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data: c } = useQuery({
    queryKey: ['case', caseId],
    queryFn: () => apiGet<Case>(`/ops/cases/${caseId}`),
  });
  const addActivity = useMutation({
    mutationFn: () => apiPost(`/ops/cases/${caseId}/activity`, { kind: 'comment', body }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['case', caseId] }); },
  });
  if (!c) return <div className="p-4 text-[12px] text-[var(--fg-muted)]">Loading…</div>;
  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
          Case
        </div>
        <div className="text-[16px] font-semibold text-[var(--fg)] leading-snug">{c.title}</div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
          <Badge variant={statusVariant(c.priority)}>{c.priority}</Badge>
        </div>
      </div>

      {c.description && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-[12px] text-[var(--fg)] whitespace-pre-wrap">
          {c.description}
        </div>
      )}

      {c.detection_id && (
        <div className="text-[11px]">
          <span className="text-[var(--fg-muted)] uppercase tracking-[var(--tracking-wide)]">Detection </span>
          <a href={`/dashboard.html#detection-${c.detection_id}`} className="text-[var(--fg)] underline hover:text-[var(--accent-strong)]">
            {c.detection_id}
          </a>
        </div>
      )}

      <AssigneePicker caseObj={c} />

      <div className="space-y-2">
        <Label>Add activity</Label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comment, status change, blocker…" />
        <Button size="sm" disabled={!body.trim() || addActivity.isPending} onClick={() => addActivity.mutate()}>
          {addActivity.isPending ? 'Saving…' : 'Add'}
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Activity log</Label>
        <div className="space-y-2">
          {(c.activity ?? []).map((a) => (
            <div
              key={a.id}
              className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-2"
            >
              <div className="flex items-center justify-between">
                <Badge variant="outline" size="sm">{a.kind}</Badge>
                <span className="text-[10px] text-[var(--fg-muted)]">{formatRelative(a.created_at)}</span>
              </div>
              {a.body && (
                <div className="text-[12px] text-[var(--fg)] mt-1 whitespace-pre-wrap">{a.body}</div>
              )}
            </div>
          ))}
          {(c.activity ?? []).length === 0 && (
            <div className="text-[11px] text-[var(--fg-subtle)]">No activity yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
function AssigneePicker({ caseObj }: { caseObj: Case }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({
    queryKey: ['tenant-users'],
    queryFn:  () => apiGet<TenantUser[]>('/tenants/me/users'),
    staleTime: 60_000,
  });
  const active = (caseObj.assignments ?? []).find((a) => a.released_at === null);
  const assign = useMutation({
    mutationFn: (assignee_id: string) =>
      apiPost(`/ops/cases/${caseObj.id}/assign`, { assignee_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', caseObj.id] }),
  });
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        <UserCheck className="size-3" />Assignee
      </Label>
      <select
        value={active?.assignee_id ?? ''}
        onChange={(e) => e.target.value && assign.mutate(e.target.value)}
        disabled={assign.isPending}
        className={cn(
          'w-full h-9 rounded-[var(--radius-md)]',
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
          'px-3 text-[13px]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
        )}
      >
        <option value="">— Unassigned —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name} · {u.email}
          </option>
        ))}
      </select>
      {assign.isPending && <div className="text-[10px] text-[var(--fg-muted)]">Saving…</div>}
    </div>
  );
}
