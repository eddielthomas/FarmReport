// =============================================================================
// studio-ui.tsx — shared primitives for the Twin Studio, in Report.Farm tokens.
// Ported from the concept prototype's inline helpers, re-skinned to our palette
// (cobalt accent / warm-neutral surfaces / risk ramp) instead of clay/ember/moss.
// =============================================================================

import * as React from 'react';

export function StudioHeader({ crumbs, right }: { crumbs: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_80%,transparent)] px-6 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-4">
        <a href="/operations.html" className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] font-semibold text-[var(--fg)] hover:border-[var(--accent)]">
          <span className="grid size-5 place-items-center rounded-md bg-[var(--accent)] text-[10px] font-bold text-[var(--fg-on-accent)]">R</span>
          Report.Farm
        </a>
        <nav className="text-xs text-[var(--fg-muted)]">{crumbs}</nav>
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </header>
  );
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-card)] ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <div className="text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">{label}</span>
      {children}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return (
    <input
      {...rest}
      className={`rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--fg)] outline-none transition focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${className}`}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`min-h-24 w-full resize-y rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--fg)] outline-none transition focus:border-[var(--accent)] ${className}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select
      {...rest}
      className={`rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--fg)] outline-none transition focus:border-[var(--accent)] ${className}`}
    >
      {children}
    </select>
  );
}

export function PrimaryBtn({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-[var(--fg-on-accent)] shadow-[var(--shadow-accent)] transition hover:brightness-110 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--fg)] transition hover:border-[var(--accent)] ${className}`}
    >
      {children}
    </button>
  );
}

export function StatusPill({ online, onToggle }: { online: boolean; onToggle?: (v: boolean) => void }) {
  const base = 'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]';
  const on = 'border-[color-mix(in_oklch,var(--risk-healthy)_50%,transparent)] bg-[color-mix(in_oklch,var(--risk-healthy-fill)_60%,transparent)] text-[var(--risk-healthy)]';
  const off = 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--fg-muted)]';
  const content = (
    <>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? 'animate-pulse bg-[var(--risk-healthy)]' : 'bg-[var(--fg-subtle)]'}`} />
      {online ? 'Online' : 'Offline'}
    </>
  );
  if (!onToggle) return <span className={`${base} ${online ? on : off}`}>{content}</span>;
  return <button onClick={() => onToggle(!online)} className={`${base} ${online ? on : off}`}>{content}</button>;
}

export function MetricRing({ label, value, color }: { label: string; value: number; color: string }) {
  const c = 2 * Math.PI * 22;
  const off = c - (value / 100) * c;
  return (
    <div className="relative flex h-20 w-20 items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface-sunken)]">
      <svg width="60" height="60" viewBox="0 0 60 60" className="-rotate-90">
        <circle cx="30" cy="30" r="22" fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle cx="30" cy="30" r="22" fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} style={{ transition: 'stroke-dashoffset 500ms ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-sm font-semibold text-[var(--fg)]">{value}</div>
        <div className="text-[8px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
      </div>
    </div>
  );
}

export function MetricStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-2 text-center">
      <div className="text-lg font-semibold text-[var(--fg)] tabular-nums">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 p-8 text-center text-xs text-[var(--fg-muted)]">
      {children}
    </div>
  );
}

export function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Deterministic sparkline points for a reading card.
export function sparklinePoints(seed: number): string {
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const n = 20;
  return Array.from({ length: n }, (_, i) => `${((i / (n - 1)) * 100).toFixed(1)},${(5 + rand() * 20).toFixed(1)}`).join(' ');
}
