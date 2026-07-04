// =============================================================================
// dashboard/panels/BottomPanel.tsx — time scrubber + weather + intel.
// =============================================================================

import { ChevronDown, ChevronUp, Calendar, CloudSun, Thermometer, Wind } from 'lucide-react';
import { useDashboardStore } from '../store';

export function BottomPanel() {
  const collapsed = useDashboardStore((s) => s.bottomCollapsed);
  const setCollapsed = useDashboardStore((s) => s.setBottomCollapsed);

  return (
    <section
      data-coachmark="dash.bottom"
      className="bottom-panel col-span-3 border-t border-[var(--border)] glass-2 overflow-hidden hidden lg:flex"
      style={{ gridRow: 3, gridColumn: '1 / -1' }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute top-1 right-2 z-10 size-5 flex items-center justify-center rounded text-[var(--rwr-t2)] hover:text-[var(--signal-cyan)] hover:bg-[var(--accent)]"
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        {collapsed ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>

      {collapsed ? (
        <div className="flex-1 flex items-center px-3 text-[8px] font-mono uppercase tracking-wider text-[var(--rwr-t3)]">
          <span>TIME: 2025-11-15 · WEATHER: 24°C · WIND: 12kn · CHARTS COLLAPSED</span>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-[1fr_240px_200px] gap-3 p-2">
          <div className="space-y-1">
            <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] flex items-center gap-1.5">
              <Calendar className="size-2.5" /> Time Scrubber
              <span className="flex-1 h-px bg-[var(--border)]" />
              <span className="text-[var(--signal-cyan)] font-mono">2025-11-15</span>
            </div>
            <div className="relative h-8 bg-black/25 rounded border border-[var(--border)] overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-transparent via-[rgba(0,212,255,0.12)] to-transparent"
                style={{ width: '60%' }}
              />
              <div className="absolute inset-y-0 left-[60%] w-px bg-[var(--signal-cyan)] shadow-[0_0_8px_var(--signal-cyan)]" />
              <div className="absolute inset-0 flex items-center justify-between px-2 text-[6.5px] font-mono text-[var(--rwr-t3)] pointer-events-none">
                <span>2024-01</span>
                <span>2025-11 (NOW)</span>
                <span>2026-06</span>
              </div>
            </div>
            <div className="text-[7px] font-mono text-[var(--rwr-t3)]">
              42 SAR captures · 14 detections · 3 customer GIS uploads
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)] flex items-center gap-1.5">
              <CloudSun className="size-2.5" /> Weather
              <span className="flex-1 h-px bg-[var(--border)]" />
            </div>
            <div className="grid grid-cols-3 gap-1">
              {[
                { icon: <Thermometer className="size-2.5" />, label: 'TEMP', value: '24°C' },
                { icon: <Wind className="size-2.5" />,       label: 'WIND', value: '12kn' },
                { icon: <CloudSun className="size-2.5" />,   label: 'SKY',  value: 'CLEAR' },
              ].map((w) => (
                <div key={w.label} className="panel rounded p-1.5 text-center">
                  <div className="text-[var(--signal-cyan)] mb-0.5 flex justify-center">{w.icon}</div>
                  <div className="text-[7.5px] uppercase text-[var(--rwr-t3)]">{w.label}</div>
                  <div className="text-[9px] font-mono text-[var(--rwr-t1)]">{w.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[7px] font-bold uppercase tracking-[0.15em] text-[var(--rwr-t3)]">
              System Intelligence
            </div>
            <div className="text-[8px] text-[var(--rwr-t2)] leading-relaxed panel rounded p-1.5">
              Pipeline coverage: 94%. New scene expected: 18h. AI confidence: high (0.91).
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
