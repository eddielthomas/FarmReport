// =============================================================================
// MapTab — field map screen with TWO maps (S18): Project + Directions.
// -----------------------------------------------------------------------------
//   * Project    — tech GPS + assigned-job pins + geofences (tap a pin → sheet)
//   * Directions — routed line from the agronomist's GPS to the assigned field, with
//                  distance/ETA, a step list, and an "Open in Maps" handoff.
// A segmented control switches between them. The directions map targets the
// most-actionable assigned job (en_route → assigned → on_site → in_progress).
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import { useGeolocation } from '@crm/lib/useGeolocation';
import { useFieldEvents } from '@crm/lib/field-socket';
import { type FieldJob } from '@crm/lib/field-types';
import { cn } from '@crm/lib/utils';
import { Map as MapIcon, Navigation } from 'lucide-react';
import { ProjectMap } from './ProjectMap';
import { DirectionsMap } from './DirectionsMap';
import { JobSheet } from './JobSheet';

const NAV_PRIORITY: FieldJob['status'][] = ['en_route', 'assigned', 'on_site', 'in_progress', 'paused'];

function pickNavJob(jobs: FieldJob[]): FieldJob | null {
  const located = jobs.filter((j) => j.lat != null && j.lon != null);
  for (const st of NAV_PRIORITY) {
    const hit = located.find((j) => j.status === st);
    if (hit) return hit;
  }
  return located[0] ?? null;
}

export function MapTab() {
  const { fix } = useGeolocation();
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ['field-jobs'],
    queryFn:  () => apiGet<FieldJob[]>('/field/jobs'),
  });
  useFieldEvents(React.useMemo(() => ({
    'field.job.assigned':       () => { refetch(); },
    'field.job.status_changed': () => { refetch(); },
  }), [refetch]));

  const [view, setView] = React.useState<'project' | 'directions'>('project');
  const [openJob, setOpenJob] = React.useState<FieldJob | null>(null);

  // The directions target: an explicit pick (from "Directions" on a job sheet)
  // wins; otherwise the most-actionable assigned job.
  const [navJobId, setNavJobId] = React.useState<string | null>(null);
  const autoNav = React.useMemo(() => pickNavJob(jobs), [jobs]);
  const navJob = React.useMemo(
    () => jobs.find((j) => j.id === navJobId) ?? autoNav,
    [jobs, navJobId, autoNav],
  );

  // Allow a job sheet to deep-link into the directions view for a specific job.
  const navigateToJob = React.useCallback((job: FieldJob) => {
    setNavJobId(job.id);
    setView('directions');
    setOpenJob(null);
  }, []);

  return (
    <div className="relative h-full w-full flex flex-col bg-[var(--bg)]" style={{ minHeight: 280 }}>
      {/* Segmented control */}
      <div className="shrink-0 p-2">
        <div className="flex p-1 rounded-[var(--radius-full)] bg-[var(--surface-sunken)] border border-[var(--border)]" role="tablist" aria-label="Map view">
          {([['project', 'Project', MapIcon], ['directions', 'Directions', Navigation]] as const).map(([id, label, Icon]) => (
            <button
              key={id} type="button" role="tab" aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[var(--radius-full)] text-[13px] font-semibold transition-colors',
                view === id ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)]',
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Active map */}
      <div className="relative flex-1 min-h-0">
        {view === 'project'
          ? <ProjectMap fix={fix} jobs={jobs} onOpenJob={setOpenJob} />
          : <DirectionsMap fix={fix} job={navJob} />}
      </div>

      {openJob && (
        <JobSheet
          job={openJob}
          onClose={() => setOpenJob(null)}
          onNavigate={navigateToJob}
        />
      )}
    </div>
  );
}
