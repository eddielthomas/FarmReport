// =============================================================================
// dashboard/panels/RightPanel.tsx — asset + intel feed sidebar.
// =============================================================================

import { X, AlertTriangle, Activity, Brain } from 'lucide-react';
import { cn } from '@crm/lib/utils';

interface Props {
  open?: boolean;
  onClose?: () => void;
}

export function RightPanel({ open = false, onClose }: Props) {
  return (
    <aside
      data-coachmark="dash.right"
      className={cn(
        'border-l border-[var(--border)] glass overflow-hidden flex flex-col z-50',
        'fixed lg:static top-9 lg:top-auto bottom-5 lg:bottom-auto right-0 w-[72vw] max-w-[380px] lg:w-auto lg:max-w-none',
        'transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
      )}
      style={{ gridRow: 2, gridColumn: 3 }}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-[var(--rwr-t2)]">
          <Activity className="size-2.5 text-[var(--signal-amber)]" />
          Asset Intel
        </div>
        <button
          onClick={onClose}
          className="lg:hidden size-6 flex items-center justify-center rounded text-[var(--rwr-t2)] hover:text-[var(--signal-red)]"
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-2.5 py-2 border-b border-[var(--border)]">
          <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] mb-1.5">
            Selected Detection
          </div>
          <div className="space-y-1.5">
            <div>
              <div className="text-[10px] font-semibold text-[var(--rwr-t1)]">DET-2294</div>
              <div className="text-[7.5px] text-[var(--rwr-t3)]">Pipe segment 422 · 14 days monitored</div>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {[
                ['SEVERITY', 'HIGH'],
                ['MATERIAL', 'PVC'],
                ['DIAMETER', '300mm'],
                ['BURIED',   '1.8m'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-[var(--border)] py-0.5">
                  <span className="text-[7.5px] uppercase text-[var(--rwr-t3)] tracking-[0.04em]">{k}</span>
                  <span className="text-[7.5px] text-[var(--rwr-t1)] font-semibold">{v}</span>
                </div>
              ))}
            </div>
            <div className="text-[8px] text-[var(--rwr-t2)] leading-relaxed bg-black/25 rounded p-1.5 border border-[var(--border)]">
              Soil-moisture anomaly trending upward 14d. Spectral signature matches PVC fissure pattern. Recommend on-site walk-down within 72h.
            </div>
          </div>
        </div>

        <div className="px-2.5 py-2 border-b border-[var(--border)]">
          <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] mb-1.5">
            Live Feed
          </div>
          <div className="space-y-1">
            {STUB_FEED.map((f, i) => (
              <div key={i} className="panel rounded p-1.5 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[8px] font-mono text-[var(--signal-cyan)]">{f.id}</span>
                  <span className="text-[6.5px] font-mono text-[var(--rwr-t3)]">{f.t}</span>
                </div>
                <div className="text-[8px] text-[var(--rwr-t1)]">{f.msg}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-2.5 py-2">
          <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] mb-1.5 flex items-center gap-1.5">
            <Brain className="size-2.5" /> AI Summary
          </div>
          <div className="text-[8px] text-[var(--rwr-t2)] leading-relaxed">
            Service area shows nominal SAR coherence. 3 detections active. No customer GIS uploads in last 24h. Pipe network coverage: 94%.
          </div>
        </div>
      </div>
    </aside>
  );
}

const STUB_FEED = [
  { id: 'EVT-104', t: '14:32', msg: 'Detection DET-2294 confirmed' },
  { id: 'EVT-103', t: '13:18', msg: 'New SAR scene ingested' },
  { id: 'EVT-102', t: '11:45', msg: 'Case CASE-882 assigned to T. Chen' },
];
