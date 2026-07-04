// =============================================================================
// SignalTimeline — the "what changed and why" feed for one farm.
// -----------------------------------------------------------------------------
// Until the AlphaGeo connection (P2) ingests real satellite passes,
// /farm/observations returns []. We render an HONEST empty-state — a subtle
// placeholder axis and a plain statement that monitoring begins with the
// connection — never a fabricated NDVI line. When observations land, each
// becomes a dated change-event card with an optional index value; a thin NDVI
// sparkline is drawn only from real points.
// =============================================================================

import * as React from 'react';
import { Activity, Satellite, TrendingDown, TrendingUp, Circle } from 'lucide-react';

// Loose shape: the observation feed isn't finalized until P2, so we read the
// fields we know and degrade for anything absent rather than assume a schema.
export interface Observation {
  id: string;
  farm_id?: string;
  zone_id?: string | null;
  captured_at?: string | null;
  observed_at?: string | null;
  date?: string | null;
  kind?: string | null;
  category?: string | null;
  metric?: string | null;
  value?: number | string | null;
  ndvi?: number | string | null;
  delta?: number | string | null;
  summary?: string | null;
  title?: string | null;
}

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isNaN(n) ? null : n;
};
const obsDate = (o: Observation) => o.captured_at ?? o.observed_at ?? o.date ?? null;
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export function SignalTimeline({ observations }: { observations: Observation[] }) {
  if (!observations || observations.length === 0) {
    return <EmptyTimeline />;
  }

  // Sort newest-first for the feed.
  const rows = [...observations].sort((a, b) => {
    const da = obsDate(a) ? Date.parse(obsDate(a)!) : 0;
    const db = obsDate(b) ? Date.parse(obsDate(b)!) : 0;
    return db - da;
  });

  return (
    <ul className="relative space-y-3 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-[var(--border)]">
      {rows.map((o) => {
        const delta = toNum(o.delta);
        const value = toNum(o.value ?? o.ndvi);
        const down = delta != null && delta < 0;
        const TrendIcon = delta == null ? Circle : down ? TrendingDown : TrendingUp;
        const tint = delta == null ? 'var(--fg-subtle)' : down ? 'var(--risk-high)' : 'var(--risk-healthy)';
        return (
          <li key={o.id} className="relative pl-6">
            <span
              className="absolute left-0 top-1 grid size-3.5 place-items-center rounded-full border-2 border-[var(--surface)]"
              style={{ background: tint }}
              aria-hidden
            />
            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-[var(--fg)]">
                  {o.title ?? o.category ?? o.kind ?? o.metric ?? 'Observation'}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] tabular-nums" style={{ color: tint }}>
                  <TrendIcon className="size-3.5" />
                  {value != null ? value.toFixed(2) : delta != null ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)}` : ''}
                </span>
              </div>
              {o.summary && <p className="mt-1 text-[12px] text-[var(--fg-muted)]">{o.summary}</p>}
              <div className="mt-1.5 text-[11px] tabular-nums text-[var(--fg-subtle)]">{fmtDate(obsDate(o))}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// --- Honest empty-state ----------------------------------------------------
function EmptyTimeline() {
  // A recessive, obviously-inert placeholder axis: evenly spaced ghost ticks on
  // a dashed baseline. It reads as "axis awaiting data", not a chart.
  const ticks = Array.from({ length: 7 }, (_, i) => i);
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-8 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-sunken)] text-[var(--fg-subtle)]">
          <Satellite className="size-4" />
        </span>
        <div>
          <p className="text-[13px] font-semibold text-[var(--fg)]">No satellite observations yet</p>
          <p className="mt-1 text-[12px] text-[var(--fg-muted)] max-w-[42ch]">
            Monitoring begins with the AlphaGeo connection. Each pass will land here as a dated
            change event — NDVI shifts, thermal anomalies, water-level moves — with its evidence and confidence.
          </p>
        </div>
      </div>

      {/* Ghost baseline axis — visibly a placeholder, no data drawn. */}
      <div className="mt-5" aria-hidden>
        <div className="flex items-end justify-between gap-2 h-16 opacity-40">
          {ticks.map((t) => (
            <div key={t} className="flex-1 flex flex-col items-center justify-end gap-1">
              <span className="w-px flex-1 bg-[var(--border)]" style={{ height: '100%' }} />
              <span className="size-1 rounded-full bg-[var(--fg-subtle)]" />
            </div>
          ))}
        </div>
        <div className="mt-1 border-t border-dashed border-[var(--border-strong)]" />
        <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">
          <span className="inline-flex items-center gap-1"><Activity className="size-3" /> 90-day window</span>
          <span>awaiting first pass</span>
        </div>
      </div>
    </div>
  );
}
