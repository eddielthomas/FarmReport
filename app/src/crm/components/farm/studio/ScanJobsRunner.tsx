// =============================================================================
// ScanJobsRunner — drives background HD-twin build jobs and shows a small,
// non-blocking progress dock. Mounted once in the studio. The 5+ minute backend
// build runs here without blocking anything the user does; leaving and returning
// to the studio resumes any still-running job (the gateway job outlives the page).
// =============================================================================

import * as React from 'react';
import { Loader2, CheckCircle2, AlertTriangle, X, Satellite, ExternalLink } from 'lucide-react';
import { useScanJobs, driveJob, type ScanJob } from '@crm/lib/scan-jobs';

export function ScanJobsRunner({ onOpenTwin }: { onOpenTwin?: (twinId: string) => void }) {
  const { jobs, remove, clearFinished } = useScanJobs();
  const controllers = React.useRef(new Map<string, AbortController>());

  // Start a drive loop for any running job that isn't already being driven.
  React.useEffect(() => {
    for (const job of jobs) {
      if (job.status !== 'running' || controllers.current.has(job.id)) continue;
      const ctrl = new AbortController();
      controllers.current.set(job.id, ctrl);
      void driveJob(job.id, ctrl.signal, () => controllers.current.delete(job.id));
    }
  }, [jobs]);

  // Abort all in-flight drives on unmount (navigation) — jobs stay 'running' and
  // resume when the studio remounts.
  React.useEffect(() => {
    const map = controllers.current;
    return () => { for (const c of map.values()) c.abort(); map.clear(); };
  }, []);

  if (jobs.length === 0) return null;
  const running = jobs.filter((j) => j.status === 'running');
  const finished = jobs.filter((j) => j.status !== 'running');

  return (
    <div className="pointer-events-none absolute bottom-24 left-3 z-30 flex w-[300px] max-w-[80vw] flex-col gap-2">
      {jobs.slice(-4).map((job) => (
        <JobCard key={job.id} job={job} onDismiss={() => remove(job.id)} onOpenTwin={onOpenTwin} />
      ))}
      {finished.length > 1 && (
        <button
          onClick={clearFinished}
          className="pointer-events-auto self-start rounded-full border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_90%,transparent)] px-2.5 py-0.5 text-[10px] text-[var(--fg-muted)] backdrop-blur-xl hover:text-[var(--fg)]"
        >
          Clear {finished.length} finished
        </button>
      )}
      {running.length > 0 && (
        <div className="pointer-events-none self-start rounded-full bg-[color-mix(in_oklch,var(--surface)_70%,transparent)] px-2 py-0.5 text-[10px] text-[var(--fg-subtle)] backdrop-blur-sm">
          Builds keep running if you navigate away.
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onDismiss, onOpenTwin }: { job: ScanJob; onDismiss: () => void; onOpenTwin?: (id: string) => void }) {
  const tone = job.status === 'complete' ? 'var(--risk-healthy)' : job.status === 'error' ? 'var(--risk-critical)' : 'var(--accent)';
  const mins = Math.max(0, Math.round((Date.now() - job.startedAt) / 60000));
  return (
    <div className="pointer-events-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_94%,transparent)] p-3 shadow-[var(--shadow-popover)] backdrop-blur-xl">
      <div className="flex items-start gap-2">
        {job.status === 'running' ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" style={{ color: tone }} />
          : job.status === 'complete' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" style={{ color: tone }} />
          : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: tone }} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--fg)]">
            <Satellite className="size-3 text-[var(--fg-subtle)]" />
            <span className="truncate">{job.label}</span>
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
            {job.status === 'running' ? `HD twin building · ${job.pct || 0}% · ${job.stage ?? 'scanning'} · ${mins}m`
              : job.status === 'complete' ? (job.message ?? 'HD twin ready')
              : (job.message ?? 'Build failed')}
          </div>
        </div>
        <button onClick={onDismiss} className="text-[var(--fg-subtle)] hover:text-[var(--fg)]"><X className="size-3.5" /></button>
      </div>
      {job.status === 'running' && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(4, job.pct || 4)}%`, background: tone }} />
        </div>
      )}
      {job.status === 'complete' && job.resultTwinId && onOpenTwin && (
        <button
          onClick={() => onOpenTwin(job.resultTwinId!)}
          className="mt-2 inline-flex items-center gap-1 rounded-full bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--fg-on-accent)]"
        >
          View HD twin <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}
