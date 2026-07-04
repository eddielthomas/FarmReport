// =============================================================================
// dashboard/panels/LeftPanel.tsx — mission + layers + detections sidebar.
// =============================================================================

import { X, Layers, Target, Radio, ChevronRight } from 'lucide-react';
import { useDashboardStore } from '../store';
import { cn } from '@crm/lib/utils';

interface Props {
  open?: boolean;
  onClose?: () => void;
}

export function LeftPanel({ open = false, onClose }: Props) {
  const layers = useDashboardStore((s) => s.layers);
  const toggle = useDashboardStore((s) => s.toggleLayer);

  return (
    <aside
      data-coachmark="dash.left"
      className={cn(
        'border-r border-[var(--border)] glass overflow-hidden flex flex-col z-50',
        // Mobile: fixed drawer that slides in
        'fixed lg:static top-9 lg:top-auto bottom-5 lg:bottom-auto left-0 w-[72vw] max-w-[380px] lg:w-auto lg:max-w-none',
        'transition-transform duration-200 ease-out',
        open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
      style={{ gridRow: 2, gridColumn: 1 }}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-[var(--rwr-t2)]">
          <Target className="size-2.5 text-[var(--signal-cyan)]" />
          Mission
        </div>
        <button
          onClick={onClose}
          className="lg:hidden size-6 flex items-center justify-center rounded text-[var(--rwr-t2)] hover:text-[var(--signal-red)]"
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="px-2.5 py-2 border-b border-[var(--border)]">
        <div className="text-[10px] font-semibold text-[var(--rwr-t1)] mb-0.5">Demoville-A · 676251</div>
        <div className="text-[8px] text-[var(--rwr-t3)] mb-1.5">Data Release 2 · 14 detections</div>
        <div className="flex gap-1">
          <span className="px-1.5 py-0.5 rounded text-[6.5px] font-bold uppercase tracking-wider bg-[rgba(0,230,138,0.08)] border border-[rgba(0,230,138,0.15)] text-[var(--signal-green)]">
            Active
          </span>
          <span className="px-1.5 py-0.5 rounded text-[6.5px] font-bold uppercase tracking-wider bg-[rgba(77,159,255,0.08)] border border-[rgba(77,159,255,0.15)] text-[var(--signal-blue)]">
            SAR
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-2.5 py-2 border-b border-[var(--border)]">
          <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] flex items-center gap-1.5 mb-1.5">
            <Layers className="size-2.5" /> Layers
            <span className="flex-1 h-px bg-[var(--border)]" />
          </div>
          <div className="space-y-0.5">
            {layers.map((l) => (
              <button
                key={l.id}
                onClick={() => toggle(l.id)}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[rgba(60,140,255,0.04)] border border-transparent hover:border-[var(--border)] transition-all text-left"
              >
                <div
                  className={cn(
                    'w-6 h-3 rounded-full relative transition-colors shrink-0',
                    l.on ? 'bg-[var(--signal-blue)]' : 'bg-[var(--rwr-bg3)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 size-2 rounded-full bg-white transition-transform',
                      l.on ? 'translate-x-3' : 'translate-x-0.5',
                    )}
                  />
                </div>
                <span className="size-1 rounded-sm" style={{ background: l.color }} />
                <span className="text-[8px] text-[var(--rwr-t1)] flex-1 truncate">{l.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="px-2.5 py-2">
          <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] flex items-center gap-1.5 mb-1.5">
            <Radio className="size-2.5" /> Detections
            <span className="flex-1 h-px bg-[var(--border)]" />
          </div>
          <div className="space-y-1">
            {STUB_DETECTIONS.map((d) => (
              <button
                key={d.id}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[rgba(60,140,255,0.04)] border border-transparent hover:border-[var(--border)] transition-all text-left"
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{
                    background: d.severity === 'high' ? 'var(--signal-red)' : d.severity === 'med' ? 'var(--signal-amber)' : 'var(--signal-cyan)',
                    boxShadow: `0 0 6px ${d.severity === 'high' ? 'rgba(255,64,96,0.6)' : 'rgba(255,176,32,0.4)'}`,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[8px] text-[var(--rwr-t1)] truncate">{d.id}</div>
                  <div className="text-[6.5px] font-mono text-[var(--rwr-t3)]">{d.note}</div>
                </div>
                <ChevronRight className="size-2.5 text-[var(--rwr-t3)]" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

const STUB_DETECTIONS = [
  { id: 'DET-2294', note: '14d · pipe-segment-422', severity: 'high' },
  { id: 'DET-2280', note: '21d · pipe-segment-118', severity: 'med'  },
  { id: 'DET-2271', note: '28d · pipe-segment-901', severity: 'low'  },
  { id: 'DET-2266', note: '32d · pipe-segment-014', severity: 'med'  },
];
