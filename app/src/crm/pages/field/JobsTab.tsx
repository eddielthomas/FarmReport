// =============================================================================
// JobsTab — list of jobs assigned to the current field agronomist (S9B).
// -----------------------------------------------------------------------------
// Mobile-first list. Each row is a Card-like surface with:
//   * status pill (color by inferred status)
//   * title + address
//   * distance from current GPS (live, recomputed on every fix)
//   * "Open" CTA → opens JobSheet (bottom sheet)
//   * "Navigate" CTA → opens native maps deep link (geo: / maps.apple.com)
//
// Sort: by distance asc when GPS available, else by scheduled_start_at asc.
// Pull-to-refresh via touchstart/touchmove delta — minimal, no library.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import { useGeolocation, haversineMeters, formatDistance } from '@crm/lib/useGeolocation';
import { useFieldEvents } from '@crm/lib/field-socket';
import {
  type FieldJob, JOB_STATUS_LABEL, ACTIVE_JOB_STATUSES,
} from '@crm/lib/field-types';
import { JobSheet } from './JobSheet';
import { FieldChatPanel } from './FieldChatPanel';
import { cn } from '@crm/lib/utils';
import {
  MapPin, Navigation, AlertCircle, Briefcase, ChevronRight, RefreshCw,
  MessageSquare, X, Sprout,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Field dispatch queue (Phase 2) — flagged findings a manager has sent to the
// field via the gateway (/api/detections?status=sent_to_field). The gateway
// response is either a GeoJSON FeatureCollection or a plain array; parse
// defensively and derive a navigable centroid from the MultiPolygon.
// ---------------------------------------------------------------------------
interface DispatchFinding {
  id: string;
  title: string;
  address?: string;
  priority?: number;
  lat?: number;
  lon?: number;
  tier?: 'T2' | 'T3';
  screeningOnly?: boolean;
  provLabel?: string;
  integrityNote?: string;
}

function dispatchCentroid(geom: unknown): { lat: number; lon: number } | null {
  const g = geom as { coordinates?: unknown } | null;
  if (!g || g.coordinates == null) return null;
  let sx = 0, sy = 0, n = 0;
  const walk = (a: unknown): void => {
    if (!Array.isArray(a)) return;
    if (typeof a[0] === 'number' && typeof a[1] === 'number') { sx += a[0]; sy += a[1]; n += 1; }
    else a.forEach(walk);
  };
  walk(g.coordinates);
  return n ? { lat: sy / n, lon: sx / n } : null;
}

function parseDispatchQueue(raw: unknown): DispatchFinding[] {
  const asObj = raw as { features?: unknown[] } | unknown[] | null;
  const items: unknown[] = Array.isArray((asObj as { features?: unknown[] })?.features)
    ? (asObj as { features: unknown[] }).features
    : Array.isArray(asObj) ? (asObj as unknown[]) : [];
  return items.map((it): DispatchFinding => {
    const f = it as { id?: unknown; geometry?: unknown; properties?: Record<string, unknown> };
    const p = (f.properties ?? (it as Record<string, unknown>)) || {};
    const c = dispatchCentroid(f.geometry)
      ?? (typeof p.lat === 'number' && typeof p.lon === 'number' ? { lat: p.lat, lon: p.lon } : null);
    const vr = p.verification_result ?? '';
    // `finding_type` is the farm field/zone observation class; fall back through
    // the legacy gateway `leak_type` key (data contract) to a neutral 'finding'.
    const lt = p.finding_type ?? p.leak_type ?? 'finding';
    const uid = p.utilis_id ?? f.id ?? '';
    // Provenance: tag tier + screening-only so a field agronomist never receives
    // an observation without knowing its grade. The gateway only lets
    // dispatchable observations reach sent_to_field, so the queue is
    // pre-filtered; we still surface the grade verbatim.
    const mode = typeof p.integrity_mode === 'string' ? p.integrity_mode : undefined;
    const tier: 'T2' | 'T3' | undefined =
      mode === 'real_lband_sar' ? 'T2' : mode === 'cband_sar' ? 'T3' : undefined;
    return {
      id: String(f.id ?? uid ?? Math.random()),
      title: [vr, lt, uid].filter(Boolean).join(' · ') || `Observation ${String(f.id ?? '')}`,
      address: typeof p.address === 'string' ? p.address : undefined,
      priority: typeof p.investigation_priority === 'number' ? p.investigation_priority : undefined,
      lat: c?.lat,
      lon: c?.lon,
      tier,
      screeningOnly: mode === 'cband_sar',
      provLabel: mode === 'real_lband_sar' ? 'L-band · regulatory'
        : mode === 'cband_sar' ? 'C-band · screening-only' : undefined,
      integrityNote: typeof p.integrity_note === 'string' ? p.integrity_note : undefined,
    };
  });
}

function DispatchQueue() {
  const { data: findings = [], isError } = useQuery({
    queryKey: ['field-dispatch-queue'],
    queryFn: async (): Promise<DispatchFinding[]> => {
      const r = await fetch('/api/detections?status=sent_to_field', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('queue ' + r.status);
      return parseDispatchQueue(await r.json());
    },
    refetchInterval: 60_000,
    retry: 1,
  });

  if (isError || findings.length === 0) return null;
  return (
    <section className="px-3 pt-1 pb-2" aria-label="Dispatched findings">
      <div className="px-1 pb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--cyan)]">
        <Sprout className="size-3.5" /> Dispatched findings · {findings.length}
      </div>
      <ul className="space-y-2" role="list">
        {findings.map((finding) => (
          <li key={finding.id}>
            <div
              className={cn(
                'w-full rounded-[var(--radius-xl)] p-4 flex items-start gap-3',
                'bg-[var(--surface)] border border-[var(--cyan)]/40 shadow-[var(--shadow-soft)]',
              )}
              style={{ minHeight: 72 }}
            >
              <span aria-hidden="true" className="block w-1 self-stretch rounded-[var(--radius-full)]" style={{ background: 'var(--cyan)' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--cyan)]">
                    Scouting target{typeof finding.priority === 'number' ? ` · P${finding.priority}` : ''}
                  </span>
                  {finding.tier && (
                    <span
                      className={cn(
                        'text-[10px] font-semibold uppercase tracking-[var(--tracking-wider)] px-1.5 py-0.5 rounded-[var(--radius-sm)]',
                        finding.tier === 'T2'
                          ? 'bg-[var(--cyan)]/15 text-[var(--cyan)]'
                          : 'bg-[var(--yellow)]/15 text-[var(--yellow)]',
                      )}
                    >
                      {finding.tier === 'T2' ? 'T2 · Regulatory' : 'T3 · Screening'}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[15px] font-semibold text-[var(--fg)] truncate">{finding.title}</div>
                {finding.address && (
                  <div className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--fg-muted)]">
                    <MapPin className="size-3.5 mt-0.5 shrink-0" />
                    <span className="truncate">{finding.address}</span>
                  </div>
                )}
                {finding.screeningOnly && (
                  <div className="mt-1 text-[11px] text-[var(--yellow)]">
                    Screening-grade — probable, verify on site (not confirmed).
                  </div>
                )}
                {finding.integrityNote && (
                  <div className="mt-1 text-[11px] text-[var(--fg-muted)] italic truncate">{finding.integrityNote}</div>
                )}
              </div>
              {finding.lat != null && finding.lon != null && (
                <a
                  href={`geo:${finding.lat},${finding.lon}?q=${finding.lat},${finding.lon}(${encodeURIComponent(finding.title)})`}
                  aria-label="Navigate to field"
                  className="grid place-items-center size-11 rounded-[var(--radius-full)] bg-[var(--cyan)] text-[var(--fg-on-accent)] shrink-0"
                >
                  <Navigation className="size-4" />
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function statusColor(status: FieldJob['status']) {
  switch (status) {
    case 'assigned':    return 'var(--blue)';
    case 'en_route':    return 'var(--cyan)';
    case 'on_site':     return 'var(--green)';
    case 'in_progress': return 'var(--accent)';
    case 'paused':      return 'var(--yellow)';
    case 'completed':   return 'var(--fg-subtle)';
    case 'cancelled':   return 'var(--red)';
    default:            return 'var(--fg-subtle)';
  }
}

export function JobsTab() {
  const { fix } = useGeolocation();
  const { data: jobs = [], refetch, isFetching, isError, error } = useQuery({
    queryKey: ['field-jobs'],
    queryFn:  () => apiGet<FieldJob[]>('/field/jobs'),
  });

  // Refetch on socket events.
  useFieldEvents(React.useMemo(() => ({
    'field.job.assigned':        () => { refetch(); },
    'field.job.status_changed':  () => { refetch(); },
  }), [refetch]));

  const [openJob, setOpenJob] = React.useState<FieldJob | null>(null);
  const [opsOpen, setOpsOpen] = React.useState(false);

  const enriched = React.useMemo(() => {
    return jobs.map((j) => {
      const distance =
        fix && j.lat != null && j.lon != null
          ? haversineMeters({ lat: fix.lat, lon: fix.lon }, { lat: j.lat, lon: j.lon })
          : null;
      return { job: j, distance };
    });
  }, [jobs, fix]);

  const sorted = React.useMemo(() => {
    const xs = [...enriched];
    xs.sort((a, b) => {
      // Active jobs first
      const aActive = ACTIVE_JOB_STATUSES.includes(a.job.status) ? 0 : 1;
      const bActive = ACTIVE_JOB_STATUSES.includes(b.job.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;

      if (a.distance != null && b.distance != null) return a.distance - b.distance;
      if (a.distance != null) return -1;
      if (b.distance != null) return 1;
      const sa = a.job.scheduled_start_at ?? '';
      const sb = b.job.scheduled_start_at ?? '';
      return sa.localeCompare(sb);
    });
    return xs;
  }, [enriched]);

  // ---- pull-to-refresh -----------------------------------------------------
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [pullPx, setPullPx] = React.useState(0);
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startY = 0;
    let pulling = false;
    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop > 0) return;
      startY = e.touches[0]?.clientY ?? 0;
      pulling = true;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pulling) return;
      const y = e.touches[0]?.clientY ?? 0;
      const delta = Math.max(0, Math.min(120, y - startY));
      setPullPx(delta);
    };
    const onTouchEnd = () => {
      if (pulling && pullPx > 80) refetch();
      pulling = false;
      setPullPx(0);
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove',  onTouchMove,  { passive: true });
    el.addEventListener('touchend',   onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchend',   onTouchEnd);
    };
  }, [pullPx, refetch]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto bg-[var(--bg)]"
      style={{ overscrollBehaviorY: 'contain' }}
    >
      {/* Pull-to-refresh indicator */}
      <div
        aria-hidden="true"
        style={{
          height: pullPx,
          transition: pullPx === 0 ? 'height var(--duration-fast) ease' : undefined,
        }}
        className="flex items-end justify-center text-[var(--fg-muted)]"
      >
        {pullPx > 30 && (
          <RefreshCw
            className={cn(
              'size-5 mb-2',
              pullPx > 80 ? 'text-[var(--accent)] animate-spin' : '',
            )}
          />
        )}
      </div>

      {/* Header */}
      <header className="px-4 pt-4 pb-2">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              My Jobs
            </div>
            <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] leading-tight">
              {jobs.length === 0 ? 'No jobs yet' : `${jobs.length} assigned`}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Ops channel"
              title="Message ops"
              onClick={() => setOpsOpen(true)}
              className={cn(
                'grid place-items-center size-11 rounded-[var(--radius-full)]',
                'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
              )}
            >
              <MessageSquare className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Refresh"
              onClick={() => refetch()}
              className={cn(
                'grid place-items-center size-11 rounded-[var(--radius-full)]',
                'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
              )}
            >
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>
      </header>

      {/* Manager-dispatched findings (gateway detections at status=sent_to_field) */}
      <DispatchQueue />

      {isError && (
        <div className="mx-4 my-3 p-3 rounded-[var(--radius-lg)] bg-[var(--red-soft)] text-[var(--fg)] flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 text-[var(--red)]" />
          <div className="text-[12px]">
            Failed to load jobs: {error instanceof Error ? error.message : 'unknown'}
          </div>
        </div>
      )}

      {/* Empty */}
      {!isFetching && jobs.length === 0 && (
        <div className="px-4 pt-8 pb-12 flex flex-col items-center gap-3 text-center">
          <div className="size-16 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] grid place-items-center">
            <Briefcase className="size-8 text-[var(--fg-subtle)]" />
          </div>
          <div className="text-[14px] text-[var(--fg-muted)]">
            Nothing assigned right now.<br />
            Your manager will dispatch jobs when they come in.
          </div>
        </div>
      )}

      {/* List */}
      <ul className="px-3 pb-6 space-y-2" role="list">
        {sorted.map(({ job, distance }) => {
          const color = statusColor(job.status);
          return (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => setOpenJob(job)}
                className={cn(
                  'w-full text-left rounded-[var(--radius-xl)] p-4',
                  'bg-[var(--surface)] border border-[var(--border)]',
                  'shadow-[var(--shadow-soft)]',
                  'active:bg-[var(--surface-sunken)] active:scale-[0.99] transition-transform duration-[var(--duration-fast)]',
                  'flex items-start gap-3',
                )}
                style={{ minHeight: 80 }}
              >
                {/* Status indicator */}
                <span
                  aria-hidden="true"
                  className="block w-1 self-stretch rounded-[var(--radius-full)]"
                  style={{ background: color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block size-2 rounded-[var(--radius-full)]"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    <span className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
                      {JOB_STATUS_LABEL[job.status]}
                    </span>
                    {job.priority === 'critical' && (
                      <span className="ml-1 text-[10px] font-semibold uppercase tracking-[var(--tracking-wider)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--red-soft)] text-[var(--red)]">
                        Critical
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[15px] font-semibold text-[var(--fg)] truncate">
                    {job.title}
                  </div>
                  {job.address && (
                    <div className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--fg-muted)]">
                      <MapPin className="size-3.5 mt-0.5 shrink-0" />
                      <span className="truncate">{job.address}</span>
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--fg-muted)]">
                    {distance != null && (
                      <span className="font-mono font-medium text-[var(--fg)]">
                        {formatDistance(distance)}
                      </span>
                    )}
                    {job.scheduled_start_at && (
                      <span>
                        {new Date(job.scheduled_start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {typeof job.open_tasks === 'number' && (
                      <span>
                        {job.open_tasks}/{job.total_tasks ?? job.open_tasks} tasks
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  {job.lat != null && job.lon != null && (
                    <a
                      href={`geo:${job.lat},${job.lon}?q=${job.lat},${job.lon}(${encodeURIComponent(job.title)})`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Navigate"
                      className={cn(
                        'grid place-items-center size-11 rounded-[var(--radius-full)]',
                        'bg-[var(--accent)] text-[var(--fg-on-accent)]',
                      )}
                    >
                      <Navigation className="size-4" />
                    </a>
                  )}
                  <ChevronRight className="size-4 text-[var(--fg-muted)]" />
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {openJob && (
        <JobSheet
          job={openJob}
          onClose={() => setOpenJob(null)}
          onJobChanged={() => refetch()}
        />
      )}

      {/* Ops channel bottom-sheet */}
      {opsOpen && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-end"
          style={{ background: 'var(--overlay)' }}
          role="dialog"
          aria-modal="true"
          aria-label="Ops channel"
          onClick={() => setOpsOpen(false)}
        >
          <div
            className="w-full bg-[var(--bg-elevated)] text-[var(--fg)] rounded-t-[var(--radius-2xl)] border-t border-[var(--border)] shadow-[var(--shadow-overlay)] overflow-y-auto"
            style={{ maxHeight: '85dvh', minHeight: '50dvh', paddingBottom: 'env(safe-area-inset-bottom)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-[1] bg-[var(--bg-elevated)] px-4 pt-3 pb-3 flex items-center justify-between border-b border-[var(--border)]">
              <h2 className="flex items-center gap-2 text-[16px] font-semibold">
                <MessageSquare className="size-4" /> Ops Channel
              </h2>
              <button
                type="button"
                onClick={() => setOpsOpen(false)}
                aria-label="Close"
                className="grid place-items-center size-9 rounded-[var(--radius-full)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)]"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="px-4 py-3">
              <FieldChatPanel mode="ops" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
