// =============================================================================
// UploadTab — capture media + post to /field/jobs/:id/uploads (S9B).
// -----------------------------------------------------------------------------
// Native <input type="file" accept="image/*,video/*,audio/*" capture="environment">
// triggers the phone's camera. After capture we preview the file and show the
// current GPS coordinates that will be sent as query params. On submit, the
// response renders the gps_verified badge.
// =============================================================================

import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiGet, apiUpload } from '@crm/lib/api';
import { useGeolocation } from '@crm/lib/useGeolocation';
import {
  type FieldJob, type FieldUploadResponse, ACTIVE_JOB_STATUSES,
} from '@crm/lib/field-types';
import { cn } from '@crm/lib/utils';
import {
  Camera, ShieldCheck, ShieldAlert, Upload as UploadIcon,
  Video, Mic, FileImage,
} from 'lucide-react';

interface PendingFile {
  file: File;
  url:  string;
  kind: 'image' | 'video' | 'audio' | 'file';
}

function kindOf(file: File): PendingFile['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

export function UploadTab() {
  const { fix, requestOnce, permission } = useGeolocation();

  const { data: jobs = [] } = useQuery({
    queryKey: ['field-jobs'],
    queryFn:  () => apiGet<FieldJob[]>('/field/jobs'),
  });

  const activeJobs = React.useMemo(
    () => jobs.filter((j) => ACTIVE_JOB_STATUSES.includes(j.status)),
    [jobs],
  );

  const [jobId, setJobId] = React.useState<string>('');
  React.useEffect(() => {
    if (!jobId && activeJobs.length > 0) setJobId(activeJobs[0].id);
  }, [activeJobs, jobId]);

  const [pending, setPending] = React.useState<PendingFile | null>(null);
  const [lastResponse, setLastResponse] = React.useState<FieldUploadResponse | null>(null);

  React.useEffect(() => {
    return () => { if (pending?.url) URL.revokeObjectURL(pending.url); };
  }, [pending]);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPending({ file, url: URL.createObjectURL(file), kind: kindOf(file) });
    setLastResponse(null);
  };

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!pending) throw new Error('no_file');
      // Always grab the freshest fix at submit time so the server's geofence
      // check uses the exact location of upload, not the stale watcher value.
      let here = fix;
      try { here = await requestOnce(); } catch { /* fall back to watcher fix */ }
      if (!here) throw new Error('gps_unavailable');
      const form = new FormData();
      form.append('file', pending.file, pending.file.name);
      const qs = new URLSearchParams({
        lat: String(here.lat),
        lon: String(here.lon),
        accuracy_m: String(here.accuracy_m),
        captured_at: here.captured_at,
      });
      return apiUpload<FieldUploadResponse>(
        `/field/jobs/${jobId}/uploads?${qs.toString()}`,
        form,
      );
    },
    onSuccess: (resp) => {
      setLastResponse(resp);
      if (pending?.url) URL.revokeObjectURL(pending.url);
      setPending(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });

  const noJobs = activeJobs.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] px-4 py-4 space-y-4">
      <header>
        <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
          Upload
        </div>
        <h1 className="text-[24px] font-semibold tracking-[var(--tracking-tight)] leading-tight">
          Capture media
        </h1>
        <p className="mt-1 text-[12px] text-[var(--fg-muted)]">
          Photos, videos, or audio. GPS is attached on submit and verified against the job's geofence.
        </p>
      </header>

      {/* Job picker */}
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
          Job
        </span>
        <select
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          disabled={noJobs}
          className="mt-1 block w-full bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-md)] px-3 py-3 text-[14px] text-[var(--fg)]"
          style={{ minHeight: 48 }}
        >
          {noJobs && <option>No active jobs</option>}
          {activeJobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title}
            </option>
          ))}
        </select>
      </label>

      {/* GPS readout */}
      <div className="rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] p-3">
        <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
          Current GPS
        </div>
        {fix ? (
          <div className="mt-1 text-[13px] font-mono text-[var(--fg)]">
            {fix.lat.toFixed(5)}, {fix.lon.toFixed(5)}{' '}
            <span className="text-[var(--fg-muted)]">±{Math.round(fix.accuracy_m)} m</span>
          </div>
        ) : (
          <div className="mt-1 text-[13px] text-[var(--fg-muted)]">
            {permission === 'denied'
              ? 'Location denied — enable in settings'
              : 'Acquiring fix…'}
          </div>
        )}
      </div>

      {/* Capture buttons */}
      {!pending && (
        <div className="grid grid-cols-3 gap-2">
          <CaptureButton
            label="Photo"
            icon={<Camera className="size-7" />}
            accept="image/*"
            capture="environment"
            onChange={onFile}
            disabled={noJobs}
            ref={fileInputRef}
          />
          <CaptureButton
            label="Video"
            icon={<Video className="size-7" />}
            accept="video/*"
            capture="environment"
            onChange={onFile}
            disabled={noJobs}
          />
          <CaptureButton
            label="Audio"
            icon={<Mic className="size-7" />}
            accept="audio/*"
            capture
            onChange={onFile}
            disabled={noJobs}
          />
          <CaptureButton
            label="Gallery"
            icon={<FileImage className="size-7" />}
            accept="image/*,video/*"
            onChange={onFile}
            disabled={noJobs}
          />
        </div>
      )}

      {/* Preview + upload */}
      {pending && (
        <div className="space-y-3">
          <div className="aspect-video rounded-[var(--radius-lg)] overflow-hidden bg-[var(--surface-sunken)] border border-[var(--border)] grid place-items-center">
            {pending.kind === 'image' && (
              <img src={pending.url} alt={pending.file.name} className="size-full object-contain" />
            )}
            {pending.kind === 'video' && (
              <video src={pending.url} controls className="size-full object-contain" />
            )}
            {pending.kind === 'audio' && (
              <audio src={pending.url} controls className="w-full" />
            )}
            {pending.kind === 'file' && (
              <span className="text-[12px] text-[var(--fg-muted)]">{pending.file.name}</span>
            )}
          </div>
          <div className="text-[12px] text-[var(--fg-muted)] flex items-center justify-between">
            <span>{pending.file.name}</span>
            <span className="font-mono">{(pending.file.size / 1024).toFixed(1)} KB</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => uploadMut.mutate()}
              disabled={!jobId || !fix || uploadMut.isPending}
              className="flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--fg-on-accent)] font-semibold disabled:opacity-50"
              style={{ minHeight: 48 }}
            >
              <UploadIcon className="size-5" />
              {uploadMut.isPending ? 'Uploading…' : 'Upload now'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (pending.url) URL.revokeObjectURL(pending.url);
                setPending(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="px-4 rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)]"
              style={{ minHeight: 48 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Result */}
      {lastResponse && (
        <div
          role="status"
          className={cn(
            'rounded-[var(--radius-lg)] p-3 flex items-center gap-3',
            lastResponse.gps_verified
              ? 'bg-[color-mix(in_oklch,var(--green)_22%,var(--surface))]'
              : 'bg-[color-mix(in_oklch,var(--orange)_22%,var(--surface))]',
          )}
        >
          {lastResponse.gps_verified
            ? <ShieldCheck className="size-5 text-[var(--green)]" />
            : <ShieldAlert className="size-5 text-[var(--orange)]" />}
          <div className="flex-1 text-[12px] text-[var(--fg)]">
            {lastResponse.gps_verified
              ? 'GPS verified — recorded inside the geofence.'
              : `Uploaded but GPS could not be verified ${
                  lastResponse.gps_distance_from_job_m != null
                    ? `(${Math.round(lastResponse.gps_distance_from_job_m)} m from job)`
                    : ''
                }.`}
          </div>
        </div>
      )}

      {uploadMut.isError && (
        <div className="rounded-[var(--radius-lg)] p-3 bg-[var(--red-soft)] text-[var(--fg)] text-[12px]">
          Upload failed — check connection and try again.
        </div>
      )}
    </div>
  );
}

// ---- helpers ---------------------------------------------------------------
interface CaptureButtonProps {
  label:    string;
  icon:     React.ReactNode;
  accept:   string;
  capture?: boolean | 'user' | 'environment';
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}
const CaptureButton = React.forwardRef<HTMLInputElement, CaptureButtonProps>(
  ({ label, icon, accept, capture, onChange, disabled }, ref) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => inputRef.current!, []);
    return (
      <label
        className={cn(
          'grid place-items-center gap-1.5 p-3 rounded-[var(--radius-lg)] cursor-pointer',
          'bg-[var(--surface)] border border-[var(--border)] text-[var(--fg)]',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        style={{ minHeight: 88 }}
      >
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-[var(--tracking-wide)]">{label}</span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          {...(capture ? { capture: capture === true ? '' : capture } : {})}
          onChange={onChange}
          disabled={disabled}
          className="sr-only"
        />
      </label>
    );
  },
);
CaptureButton.displayName = 'CaptureButton';
