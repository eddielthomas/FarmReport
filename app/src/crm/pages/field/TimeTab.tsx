// =============================================================================
// TimeTab — check-in / check-out at the active job (S9B).
// -----------------------------------------------------------------------------
// Two modes:
//   (a) ACTIVE shift — header shows "ON SITE at <job> since <HH:MM>" plus a
//       live elapsed counter and a giant Check Out button.
//   (b) IDLE         — list of assigned jobs, each with a Check In button.
//                      The handler always uses the freshest GPS fix and
//                      surfaces the server's 422 gps_out_of_geofence with the
//                      reported distance.
// =============================================================================

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '@crm/lib/api';
import { useGeolocation, haversineMeters, formatDistance } from '@crm/lib/useGeolocation';
import { useFieldEvents } from '@crm/lib/field-socket';
import {
  type FieldJob, type FieldTimeEntry, ACTIVE_JOB_STATUSES,
} from '@crm/lib/field-types';
import { cn } from '@crm/lib/utils';
import { Clock, MapPin, ShieldCheck, ShieldAlert, LogOut, AlertCircle } from 'lucide-react';

interface ActiveTimeResp {
  time_entry: FieldTimeEntry | null;
  job:        FieldJob | null;
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function TimeTab() {
  const queryClient = useQueryClient();
  const { fix, requestOnce, permission } = useGeolocation();
  const [feedback, setFeedback] = React.useState<{ kind: 'ok' | 'warn' | 'err'; msg: string } | null>(null);

  // ---- active time entry --------------------------------------------------
  const { data: activeEntry, refetch: refetchActive } = useQuery({
    queryKey: ['field-time-active'],
    // The S9A backend exposes the open entry via /field/jobs + status. We use
    // the dedicated endpoint when available, otherwise fall back to scanning.
    queryFn:  async (): Promise<ActiveTimeResp> => {
      try {
        return await apiGet<ActiveTimeResp>('/field/time/active');
      } catch (_e) {
        const jobs = await apiGet<FieldJob[]>('/field/jobs').catch(() => [] as FieldJob[]);
        const onSite = jobs.find((j) => j.status === 'on_site' || j.status === 'in_progress');
        return { time_entry: null, job: onSite ?? null };
      }
    },
  });

  const { data: jobs = [], refetch: refetchJobs } = useQuery({
    queryKey: ['field-jobs'],
    queryFn:  () => apiGet<FieldJob[]>('/field/jobs'),
  });

  // Live socket updates
  useFieldEvents(React.useMemo(() => ({
    'field.time_entry.opened': () => { refetchActive(); refetchJobs(); },
    'field.time_entry.closed': () => { refetchActive(); refetchJobs(); },
    'field.job.status_changed': () => { refetchActive(); refetchJobs(); },
  }), [refetchActive, refetchJobs]));

  // ---- check-in mutation --------------------------------------------------
  const checkInMut = useMutation({
    mutationFn: async (jobId: string) => {
      let here = fix;
      try { here = await requestOnce(); } catch { /* fall through */ }
      if (!here) throw new Error('gps_unavailable');
      return apiPost(`/field/jobs/${jobId}/check-in`, {
        lat: here.lat,
        lon: here.lon,
        accuracy_m: here.accuracy_m,
        captured_at: here.captured_at,
      });
    },
    onSuccess: () => {
      setFeedback({ kind: 'ok', msg: 'Checked in. Time started.' });
      queryClient.invalidateQueries({ queryKey: ['field-time-active'] });
      queryClient.invalidateQueries({ queryKey: ['field-jobs'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.message === 'gps_out_of_geofence') {
        setFeedback({
          kind: 'warn',
          msg: `Outside geofence — too far from job site${err.detail ? `: ${err.detail}` : ''}`,
        });
      } else {
        setFeedback({ kind: 'err', msg: 'Check-in failed — try again.' });
      }
    },
  });

  const checkOutMut = useMutation({
    mutationFn: async (jobId: string) => apiPost(`/field/jobs/${jobId}/check-out`),
    onSuccess: () => {
      setFeedback({ kind: 'ok', msg: 'Checked out. Time saved.' });
      queryClient.invalidateQueries({ queryKey: ['field-time-active'] });
      queryClient.invalidateQueries({ queryKey: ['field-jobs'] });
    },
    onError: () => setFeedback({ kind: 'err', msg: 'Check-out failed — try again.' }),
  });

  // ---- live elapsed counter -----------------------------------------------
  const startedAt = activeEntry?.time_entry?.started_at;
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(force, 1_000);
    return () => clearInterval(t);
  }, [startedAt]);

  const activeJobs = React.useMemo(
    () => jobs.filter((j) => ACTIVE_JOB_STATUSES.includes(j.status)),
    [jobs],
  );

  const hasOpenEntry = !!startedAt;

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] px-4 py-4 space-y-4">
      <header>
        <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
          Time
        </div>
        <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] leading-tight">
          {hasOpenEntry ? 'On the clock' : 'Off the clock'}
        </h1>
      </header>

      {/* ---- Active shift card --------------------------------------------- */}
      {hasOpenEntry && activeEntry?.time_entry && (
        <section
          className="rounded-[var(--radius-2xl)] p-4 text-[var(--fg-on-accent)]"
          style={{
            background: 'linear-gradient(135deg, var(--accent) 0%, color-mix(in oklch, var(--accent) 55%, var(--surface)) 100%)',
          }}
        >
          <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] opacity-80">
            On site at
          </div>
          <div className="text-[18px] font-semibold leading-tight">
            {activeEntry.job?.title ?? 'job'}
          </div>
          <div className="mt-3 text-[44px] font-bold font-mono leading-none">
            {fmtElapsed(Date.now() - new Date(startedAt!).getTime())}
          </div>
          <div className="mt-1 text-[12px] opacity-80">
            Since {new Date(startedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          {activeEntry.job && (
            <button
              type="button"
              onClick={() => checkOutMut.mutate(activeEntry.job!.id)}
              disabled={checkOutMut.isPending}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 py-4 rounded-[var(--radius-lg)] bg-[var(--fg)] text-[var(--fg-inverted)] font-semibold disabled:opacity-50"
              style={{ minHeight: 56 }}
            >
              <LogOut className="size-5" />
              {checkOutMut.isPending ? 'Checking out…' : 'Check Out'}
            </button>
          )}
        </section>
      )}

      {/* ---- Permission warning -------------------------------------------- */}
      {permission === 'denied' && (
        <div className="rounded-[var(--radius-lg)] p-3 bg-[var(--red-soft)] text-[var(--fg)] flex items-start gap-2 text-[12px]">
          <AlertCircle className="size-4 mt-0.5 text-[var(--red)]" />
          <div>Location denied — check-in requires GPS access. Enable it in your phone settings.</div>
        </div>
      )}

      {/* ---- Available jobs ------------------------------------------------ */}
      {!hasOpenEntry && (
        <section>
          <h2 className="text-[13px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mb-2">
            Check in
          </h2>
          {activeJobs.length === 0 && (
            <div className="text-[12px] text-[var(--fg-subtle)] text-center p-6 rounded-[var(--radius-lg)] bg-[var(--surface)]">
              No jobs assigned. Your manager will dispatch jobs to you.
            </div>
          )}
          <ul className="space-y-2" role="list">
            {activeJobs.map((j) => {
              const distance =
                fix && j.lat != null && j.lon != null
                  ? haversineMeters({ lat: fix.lat, lon: fix.lon }, { lat: j.lat, lon: j.lon })
                  : null;
              const inGeofence = distance != null && distance <= j.geofence_radius_m;
              return (
                <li
                  key={j.id}
                  className="p-3 rounded-[var(--radius-xl)] bg-[var(--surface)] border border-[var(--border)] flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-semibold truncate">{j.title}</div>
                    <div className="text-[12px] text-[var(--fg-muted)] flex items-center gap-2 mt-0.5">
                      {j.address && <span className="flex items-center gap-1 truncate"><MapPin className="size-3" />{j.address}</span>}
                    </div>
                    <div className="text-[11px] mt-1 flex items-center gap-2">
                      {distance != null && (
                        <span className="font-mono text-[var(--fg)]">{formatDistance(distance)}</span>
                      )}
                      {distance != null && (
                        inGeofence
                          ? <span className="inline-flex items-center gap-1 text-[var(--green)]"><ShieldCheck className="size-3" />In geofence</span>
                          : <span className="inline-flex items-center gap-1 text-[var(--orange)]"><ShieldAlert className="size-3" />Out of geofence</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => checkInMut.mutate(j.id)}
                    disabled={checkInMut.isPending || !fix}
                    className={cn(
                      'inline-flex items-center gap-1.5 py-3 px-4 rounded-[var(--radius-lg)]',
                      'bg-[var(--accent)] text-[var(--fg-on-accent)] font-semibold',
                      'disabled:opacity-50',
                    )}
                    style={{ minHeight: 48 }}
                  >
                    <Clock className="size-4" />
                    Check in
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {feedback && (
        <div
          role="status"
          className={cn(
            'rounded-[var(--radius-lg)] p-3 text-[12px]',
            feedback.kind === 'ok'   && 'bg-[color-mix(in_oklch,var(--green)_22%,var(--surface))]',
            feedback.kind === 'warn' && 'bg-[color-mix(in_oklch,var(--orange)_22%,var(--surface))]',
            feedback.kind === 'err'  && 'bg-[var(--red-soft)]',
          )}
        >
          {feedback.msg}
        </div>
      )}
    </div>
  );
}
