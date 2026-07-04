// =============================================================================
// JobSheet — bottom-sheet detail view for a single job (S9B).
// -----------------------------------------------------------------------------
// Slides up from the bottom on tap. Shows:
//   * Title + status + address + geofence radius
//   * Tasks (checklist) with tap-to-complete
//   * Recent uploads (grid of thumbnails)
//   * Action buttons: Navigate / Check In / Upload
//
// Backdrop tap, swipe-down gesture, or the X button closes it.
// Uses dvh so the iOS dynamic toolbar doesn't clip the content.
// =============================================================================

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiDel, ApiError } from '@crm/lib/api';
// apiGet/apiPost/apiDel used across job detail, lifecycle, notes, and chat.
import { useGeolocation, haversineMeters, formatDistance } from '@crm/lib/useGeolocation';
import {
  type FieldJob, type FieldTask, type FieldUpload, JOB_STATUS_LABEL,
} from '@crm/lib/field-types';
import { cn } from '@crm/lib/utils';
import {
  X, Navigation, CheckCircle2, Circle, Camera, MapPin, Clock,
  Upload as UploadIcon, ShieldCheck, ShieldAlert, Plus,
  Play, Pause, Square, MessageSquare, StickyNote,
} from 'lucide-react';
import { FieldChatPanel } from './FieldChatPanel';

interface JobNote {
  id:           string;
  body:         string;
  author_id:    string | null;
  author_name?: string | null;
  author_email?: string | null;
  created_at:   string;
}

function noteRelTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface JobSheetProps {
  job: FieldJob;
  onClose: () => void;
  onJobChanged?: () => void;
  /** When provided, the Directions button opens the in-app routed map (S18). */
  onNavigate?: (job: FieldJob) => void;
}

export function JobSheet({ job, onClose, onJobChanged, onNavigate }: JobSheetProps) {
  const queryClient = useQueryClient();
  const { fix } = useGeolocation();

  // ---- detail (tasks + uploads) -------------------------------------------
  const { data: detail } = useQuery({
    queryKey: ['field-job', job.id],
    queryFn:  () => apiGet<{ job: FieldJob; tasks: FieldTask[]; uploads: FieldUpload[] }>(`/field/jobs/${job.id}`),
    refetchInterval: 30_000,
  });
  const tasks   = detail?.tasks   ?? [];
  const uploads = detail?.uploads ?? [];

  // ---- check-in -----------------------------------------------------------
  const [checkInMsg, setCheckInMsg] = React.useState<string | null>(null);
  const checkInMut = useMutation({
    mutationFn: async () => {
      if (!fix) throw new Error('gps_unavailable');
      return apiPost(`/field/jobs/${job.id}/check-in`, {
        lat: fix.lat,
        lon: fix.lon,
        accuracy_m: fix.accuracy_m,
        captured_at: fix.captured_at,
      });
    },
    onSuccess: () => {
      setCheckInMsg('Checked in.');
      queryClient.invalidateQueries({ queryKey: ['field-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['field-time-active'] });
      onJobChanged?.();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.message === 'gps_out_of_geofence') {
        setCheckInMsg(`Outside geofence: ${err.detail ?? 'too far'}`);
      } else {
        setCheckInMsg('Check-in failed — try again');
      }
    },
  });

  // ---- task completion ----------------------------------------------------
  const completeTask = useMutation({
    mutationFn: (taskId: string) =>
      apiPost(`/field/jobs/${job.id}/tasks/${taskId}/complete`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['field-job', job.id] }),
  });

  const deleteTask = useMutation({
    mutationFn: (taskId: string) =>
      apiDel(`/field/jobs/${job.id}/tasks/${taskId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['field-job', job.id] }),
  });

  const [newTask, setNewTask] = React.useState('');
  const addTask = useMutation({
    mutationFn: (title: string) =>
      apiPost(`/field/jobs/${job.id}/tasks`, { title }),
    onSuccess: () => {
      setNewTask('');
      queryClient.invalidateQueries({ queryKey: ['field-job', job.id] });
    },
  });

  // ---- lifecycle: start / pause / resume / complete -----------------------
  const [lifecycleMsg, setLifecycleMsg] = React.useState<string | null>(null);
  const afterLifecycle = () => {
    queryClient.invalidateQueries({ queryKey: ['field-jobs'] });
    queryClient.invalidateQueries({ queryKey: ['field-job', job.id] });
    queryClient.invalidateQueries({ queryKey: ['field-active-time'] });
    onJobChanged?.();
  };
  const withFix = () =>
    fix ? { lat: fix.lat, lon: fix.lon, accuracy_m: fix.accuracy_m, captured_at: fix.captured_at } : {};

  const pauseMut = useMutation({
    mutationFn: () => apiPost(`/field/jobs/${job.id}/pause`, withFix()),
    onSuccess: () => { setLifecycleMsg('Paused — clock stopped.'); afterLifecycle(); },
    onError:   () => setLifecycleMsg('Could not pause.'),
  });
  const resumeMut = useMutation({
    mutationFn: () => apiPost(`/field/jobs/${job.id}/resume`, withFix()),
    onSuccess: () => { setLifecycleMsg('Resumed — clock running.'); afterLifecycle(); },
    onError:   () => setLifecycleMsg('Could not resume.'),
  });
  const completeMut = useMutation({
    mutationFn: () => apiPost(`/field/jobs/${job.id}/check-out`, withFix()),
    onSuccess: () => { setLifecycleMsg('Job completed.'); afterLifecycle(); },
    onError:   () => setLifecycleMsg('Could not complete.'),
  });

  const status = job.status;
  const canStart    = status === 'assigned' || status === 'en_route';
  const canPause    = status === 'in_progress';
  const canResume   = status === 'paused';
  const canComplete = status === 'in_progress' || status === 'on_site';

  // ---- notes --------------------------------------------------------------
  const { data: notes = [] } = useQuery({
    queryKey: ['field-job-notes', job.id],
    queryFn:  () => apiGet<JobNote[]>(`/field/jobs/${job.id}/notes`),
    refetchInterval: 30_000,
  });
  const [newNote, setNewNote] = React.useState('');
  const addNote = useMutation({
    mutationFn: (body: string) => apiPost(`/field/jobs/${job.id}/notes`, { body }),
    onSuccess: () => {
      setNewNote('');
      queryClient.invalidateQueries({ queryKey: ['field-job-notes', job.id] });
    },
  });

  // ---- close on escape ----------------------------------------------------
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const distance =
    fix && job.lat != null && job.lon != null
      ? haversineMeters({ lat: fix.lat, lon: fix.lon }, { lat: job.lat, lon: job.lon })
      : null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-end"
      style={{ background: 'var(--overlay)' }}
      role="dialog"
      aria-modal="true"
      aria-label={`Job: ${job.title}`}
      onClick={onClose}
    >
      <div
        className={cn(
          'w-full bg-[var(--bg-elevated)] text-[var(--fg)]',
          'rounded-t-[var(--radius-2xl)] border-t border-[var(--border)]',
          'shadow-[var(--shadow-overlay)]',
          'overflow-y-auto',
        )}
        style={{
          maxHeight: '90dvh',
          minHeight: '60dvh',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="sticky top-0 z-[1] bg-[var(--bg-elevated)] pt-2 pb-3 flex flex-col items-center gap-2 border-b border-[var(--border)]">
          <span
            aria-hidden="true"
            className="block w-10 h-1 rounded-[var(--radius-full)] bg-[var(--fg-subtle)]/40"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 grid place-items-center size-9 rounded-[var(--radius-full)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-4 pb-6 pt-3 space-y-4">
          {/* Header */}
          <div>
            <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
              {JOB_STATUS_LABEL[job.status]} · {job.priority}
            </div>
            <h2 className="text-[20px] font-semibold leading-tight">{job.title}</h2>
            {job.description && (
              <p className="mt-1 text-[13px] text-[var(--fg-muted)] leading-snug">
                {job.description}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-[var(--fg-muted)]">
              {job.address && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" />
                  {job.address}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3.5" />
                Geofence {job.geofence_radius_m} m
              </span>
              {distance != null && (
                <span className="inline-flex items-center gap-1 font-mono text-[var(--fg)]">
                  {formatDistance(distance)} away
                </span>
              )}
            </div>
          </div>

          {/* Directions: in-app routed map (S18) + native turn-by-turn handoff. */}
          {job.lat != null && job.lon != null && (
            onNavigate ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onNavigate(job)}
                  className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--fg-on-accent)] font-semibold"
                  style={{ minHeight: 52 }}
                >
                  <Navigation className="size-5" />
                  <span className="text-[13px] uppercase tracking-[var(--tracking-wide)]">Route</span>
                </button>
                <a
                  href={`geo:${job.lat},${job.lon}?q=${job.lat},${job.lon}(${encodeURIComponent(job.title)})`}
                  className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] font-semibold"
                  style={{ minHeight: 52 }}
                >
                  <Navigation className="size-5" />
                  <span className="text-[13px] uppercase tracking-[var(--tracking-wide)]">Maps</span>
                </a>
              </div>
            ) : (
              <a
                href={`geo:${job.lat},${job.lon}?q=${job.lat},${job.lon}(${encodeURIComponent(job.title)})`}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--fg-on-accent)] font-semibold"
                style={{ minHeight: 52 }}
              >
                <Navigation className="size-5" />
                <span className="text-[14px] uppercase tracking-[var(--tracking-wide)]">Directions</span>
              </a>
            )
          )}

          {/* Lifecycle: Start / Pause / Resume / Complete (status-conditioned). */}
          <div className="grid grid-cols-2 gap-2">
            {canStart && (
              <button
                type="button"
                onClick={() => checkInMut.mutate()}
                disabled={checkInMut.isPending || !fix}
                className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--green)] text-[var(--fg-inverted)] font-semibold disabled:opacity-50"
                style={{ minHeight: 52 }}
              >
                <Play className="size-5" />
                <span className="text-[12px] uppercase tracking-[var(--tracking-wide)]">
                  {checkInMut.isPending ? 'Starting…' : 'Start'}
                </span>
              </button>
            )}
            {canPause && (
              <button
                type="button"
                onClick={() => pauseMut.mutate()}
                disabled={pauseMut.isPending}
                className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] font-semibold disabled:opacity-50"
                style={{ minHeight: 52 }}
              >
                <Pause className="size-5" />
                <span className="text-[12px] uppercase tracking-[var(--tracking-wide)]">Pause</span>
              </button>
            )}
            {canResume && (
              <button
                type="button"
                onClick={() => resumeMut.mutate()}
                disabled={resumeMut.isPending}
                className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--green)] text-[var(--fg-inverted)] font-semibold disabled:opacity-50"
                style={{ minHeight: 52 }}
              >
                <Play className="size-5" />
                <span className="text-[12px] uppercase tracking-[var(--tracking-wide)]">Resume</span>
              </button>
            )}
            {canComplete && (
              <button
                type="button"
                onClick={() => completeMut.mutate()}
                disabled={completeMut.isPending}
                className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--fg-on-accent)] font-semibold disabled:opacity-50"
                style={{ minHeight: 52 }}
              >
                <Square className="size-5" />
                <span className="text-[12px] uppercase tracking-[var(--tracking-wide)]">
                  {completeMut.isPending ? 'Finishing…' : 'Complete'}
                </span>
              </button>
            )}
            <a
              href="#upload"
              className="flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)]"
              style={{ minHeight: 52 }}
            >
              <Camera className="size-5" />
              <span className="text-[12px] font-semibold uppercase tracking-[var(--tracking-wide)]">Upload</span>
            </a>
          </div>

          {lifecycleMsg && (
            <div role="status" className="p-2.5 rounded-[var(--radius-lg)] text-[12px] bg-[var(--surface-sunken)] text-[var(--fg)]">
              {lifecycleMsg}
            </div>
          )}

          {checkInMsg && (
            <div
              role="status"
              className={cn(
                'p-3 rounded-[var(--radius-lg)] text-[12px]',
                checkInMsg.startsWith('Checked')
                  ? 'bg-[color-mix(in_oklch,var(--green)_22%,var(--surface))] text-[var(--fg)]'
                  : 'bg-[var(--red-soft)] text-[var(--fg)]',
              )}
            >
              {checkInMsg}
            </div>
          )}

          {/* Tasks */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                Tasks
              </h3>
              <span className="text-[11px] text-[var(--fg-muted)]">
                {tasks.filter((t) => t.completed_at).length}/{tasks.length}
              </span>
            </div>
            <ul className="space-y-1.5" role="list">
              {tasks.map((t) => {
                const done = !!t.completed_at;
                return (
                  <li
                    key={t.id}
                    className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)]"
                  >
                    <button
                      type="button"
                      aria-label={done ? 'Mark incomplete' : 'Mark complete'}
                      onClick={() => !done && completeTask.mutate(t.id)}
                      className="grid place-items-center size-7 rounded-[var(--radius-full)]"
                    >
                      {done
                        ? <CheckCircle2 className="size-6 text-[var(--green)]" />
                        : <Circle       className="size-6 text-[var(--fg-muted)]" />}
                    </button>
                    <span
                      className={cn(
                        'flex-1 text-[14px]',
                        done && 'line-through text-[var(--fg-muted)]',
                      )}
                    >
                      {t.title}
                    </span>
                    {!done && (
                      <button
                        type="button"
                        aria-label="Delete task"
                        onClick={() => deleteTask.mutate(t.id)}
                        className="text-[11px] text-[var(--fg-muted)] underline-offset-2 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
              {tasks.length === 0 && (
                <li className="text-[12px] text-[var(--fg-subtle)] text-center py-2">
                  No tasks yet
                </li>
              )}
            </ul>

            {/* Add task */}
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newTask.trim()) addTask.mutate(newTask.trim());
              }}
            >
              <input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                placeholder="Add a task"
                className="flex-1 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] text-[14px]"
                style={{ minHeight: 44 }}
              />
              <button
                type="submit"
                aria-label="Add task"
                className="grid place-items-center size-11 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)]"
              >
                <Plus className="size-5" />
              </button>
            </form>
          </section>

          {/* Notes */}
          <section>
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mb-2">
              <StickyNote className="size-3.5" /> Notes
            </h3>
            <ul className="space-y-1.5" role="list">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="p-3 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)]"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--fg-muted)]">
                    <span className="truncate">{n.author_name ?? n.author_email ?? 'Unknown'}</span>
                    <span>{noteRelTime(n.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[14px] text-[var(--fg)] whitespace-pre-wrap break-words">
                    {n.body}
                  </div>
                </li>
              ))}
              {notes.length === 0 && (
                <li className="text-[12px] text-[var(--fg-subtle)] text-center py-2">
                  No notes yet
                </li>
              )}
            </ul>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newNote.trim()) addNote.mutate(newNote.trim());
              }}
            >
              <input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Add a note"
                className="flex-1 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)] text-[14px]"
                style={{ minHeight: 44 }}
              />
              <button
                type="submit"
                aria-label="Add note"
                disabled={addNote.isPending || !newNote.trim()}
                className="grid place-items-center size-11 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)] disabled:opacity-50"
              >
                <Plus className="size-5" />
              </button>
            </form>
          </section>

          {/* Message ops (per-job thread) */}
          <section>
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mb-2">
              <MessageSquare className="size-3.5" /> Message ops
            </h3>
            <FieldChatPanel mode="job" jobId={job.id} />
          </section>

          {/* Recent uploads */}
          <section>
            <h3 className="text-[13px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)] mb-2">
              Recent uploads
            </h3>
            {uploads.length === 0 && (
              <div className="text-[12px] text-[var(--fg-subtle)] text-center py-4 rounded-[var(--radius-md)] bg-[var(--surface)]">
                Capture a photo or video from the Upload tab.
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {uploads.slice(0, 9).map((u) => (
                <a
                  key={u.id}
                  href={u.signed_url ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="relative aspect-square overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-sunken)] border border-[var(--border)]"
                >
                  {u.signed_url && u.mime_type?.startsWith('image/') ? (
                    <img
                      src={u.signed_url}
                      alt={u.file_name}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="grid place-items-center size-full text-[var(--fg-muted)]">
                      <UploadIcon className="size-5" />
                    </div>
                  )}
                  <span
                    title={u.gps_verified ? 'GPS verified' : 'GPS unverified'}
                    className={cn(
                      'absolute top-1 right-1 grid place-items-center size-5 rounded-[var(--radius-full)] border',
                      u.gps_verified
                        ? 'bg-[var(--green)] border-[var(--green)] text-[var(--fg-inverted)]'
                        : 'bg-[var(--orange)] border-[var(--orange)] text-[var(--fg-on-accent)]',
                    )}
                  >
                    {u.gps_verified ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
