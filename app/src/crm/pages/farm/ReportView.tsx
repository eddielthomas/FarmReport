// =============================================================================
// ReportView — print-grade viewer for a generated farm.report.
// -----------------------------------------------------------------------------
// report.html mounts this. The report id arrives on the query string
// (?report=<uuid>), set by FarmDetail's "Generate field report" → "View report"
// link. Fetches GET /api/v1/farm/reports/:id and renders the stored `sections`
// JSON (built server-side over REAL twin data) as a readable, printable page.
//
// The report row shape (see api/v1/farm/reports.mjs REPORT_SELECT):
//   { id, farm_id, type, title, period_start, period_end, status, summary,
//     sections: { kind, data_quality[], sections: [{key,title,data,notes?,
//     data_quality?}] }, created_at, … }
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FileText, ArrowLeft, Printer, Loader2, AlertTriangle, Sprout,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';

interface ReportSection {
  key: string;
  title: string;
  data: Record<string, unknown>;
  notes?: string[];
  data_quality?: string[];
  suppliers?: Array<Record<string, unknown>>;
}
interface ReportRow {
  id: string;
  farm_id: string;
  type: string;
  title: string;
  status: string;
  summary: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  sections: { kind?: string; data_quality?: string[]; sections?: ReportSection[] } | null;
}

function reportId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('report');
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Turn a snake_case / dotted key into a readable label.
function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fmtScalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// Compact single-line rendering for a table cell — objects/arrays are flattened
// to a readable "key: val · key: val" so nested shapes (e.g. a zone's intent
// config) never leak "[object Object]" into a cell.
function fmtCell(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (v.every((x) => !isPlainObject(x) && !Array.isArray(x))) return v.map(fmtScalar).join(', ');
    return v.map(fmtCell).join(' · ');
  }
  if (isPlainObject(v)) {
    const parts = Object.entries(v).map(([k, val]) => `${humanize(k)}: ${fmtCell(val)}`);
    return parts.length ? parts.join(' · ') : '—';
  }
  return fmtScalar(v);
}

// Recursive, shape-tolerant value renderer: scalars → text, arrays of objects →
// table, objects → key/value rows. Keeps the viewer robust to section shape.
function Value({ value }: { value: unknown }): React.ReactElement {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--fg-subtle)]">None</span>;
    if (value.every((r) => isPlainObject(r))) {
      const cols = Array.from(
        new Set(value.flatMap((r) => Object.keys(r as Record<string, unknown>))),
      );
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {cols.map((c) => (
                  <th key={c} className="text-left font-semibold text-[var(--fg-muted)] py-1.5 pr-4 whitespace-nowrap">
                    {humanize(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((r, i) => (
                <tr key={i} className="border-b border-[var(--border-subtle,var(--border))]">
                  {cols.map((c) => (
                    <td key={c} className="py-1.5 pr-4 tabular-nums">
                      {fmtCell((r as Record<string, unknown>)[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <span>{value.map((v) => fmtScalar(v)).join(', ')}</span>;
  }
  if (isPlainObject(value)) {
    return <KeyValues obj={value} />;
  }
  return <span className="tabular-nums">{fmtScalar(value)}</span>;
}

function KeyValues({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="text-[var(--fg-subtle)]">—</span>;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-[var(--fg-subtle)]">{humanize(k)}</dt>
          <dd className="text-[13px] text-[var(--fg)]"><Value value={v} /></dd>
        </div>
      ))}
    </dl>
  );
}

function NoteList({ items, tone }: { items: string[]; tone: 'note' | 'quality' }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`mt-3 rounded-[var(--radius-lg,10px)] border px-3 py-2 text-[12px] leading-relaxed ${
      tone === 'quality'
        ? 'border-[var(--warn-border,#e5b567)] bg-[var(--warn-surface,rgba(229,181,103,0.08))] text-[var(--warn-fg,#8a6d3b)]'
        : 'border-[var(--border)] bg-[var(--surface-muted,var(--surface))] text-[var(--fg-muted)]'
    }`}>
      <div className="flex items-center gap-1.5 font-semibold mb-1">
        <AlertTriangle size={13} /> {tone === 'quality' ? 'Data quality' : 'Notes'}
      </div>
      <ul className="list-disc pl-4 space-y-0.5">
        {items.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  );
}

export function ReportView() {
  const id = reportId();

  const q = useQuery({
    queryKey: ['farm-report', id],
    queryFn: () => apiGet<ReportRow>(`/farm/reports/${id}`),
    enabled: !!id,
    retry: 1,
  });

  if (!id) {
    return (
      <Frame>
        <EmptyState icon={<AlertTriangle size={28} />} title="No report specified"
          body="This page needs a report id (?report=…). Open a farm and generate a field report to view one." />
      </Frame>
    );
  }
  if (q.isLoading) {
    return (
      <Frame>
        <div className="flex items-center gap-2 text-[var(--fg-muted)] py-24 justify-center">
          <Loader2 className="animate-spin" size={18} /> Loading report…
        </div>
      </Frame>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Frame>
        <EmptyState icon={<AlertTriangle size={28} />} title="Report not found"
          body="This report could not be loaded. It may have been removed, or you may not have access to it." />
      </Frame>
    );
  }

  const r = q.data;
  const sections = r.sections?.sections ?? [];
  const topQuality = r.sections?.data_quality ?? [];

  return (
    <Frame>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <a href={`/operations.html?farm=${r.farm_id}`}
           className="inline-flex items-center gap-1.5 text-[13px] text-[var(--fg-muted)] hover:text-[var(--accent)]">
          <ArrowLeft size={15} /> Back to farm
        </a>
        <button onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-lg,10px)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
          <Printer size={15} /> Print / Save PDF
        </button>
      </div>

      <header className="mb-8 border-b border-[var(--border)] pb-6">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--accent)] font-semibold mb-2">
          <FileText size={14} /> {r.type === 'on-demand' ? 'Field Report' : humanize(r.type)}
          <span className="text-[var(--fg-subtle)]">· {r.status}</span>
        </div>
        <h1 className="text-[26px] font-bold text-[var(--fg)] leading-tight text-balance">{r.title}</h1>
        <p className="mt-2 text-[14px] text-[var(--fg-muted)] max-w-[70ch]">{r.summary}</p>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-1 text-[12px] text-[var(--fg-subtle)]">
          <span><strong className="text-[var(--fg-muted)] font-semibold">Period:</strong> {fmtDate(r.period_start)} – {fmtDate(r.period_end)}</span>
          <span><strong className="text-[var(--fg-muted)] font-semibold">Generated:</strong> {fmtDate(r.created_at)}</span>
        </div>
        <NoteList items={topQuality} tone="quality" />
      </header>

      <div className="space-y-8">
        {sections.map((s) => (
          <section key={s.key}>
            <h2 className="text-[15px] font-semibold text-[var(--fg)] mb-3 flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-[var(--accent)]" /> {s.title}
            </h2>
            <div className="rounded-[var(--radius-2xl,16px)] border border-[var(--border)] bg-[var(--surface)] p-5">
              <Value value={s.data} />
              {'suppliers' in s && Array.isArray(s.suppliers) && s.suppliers.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[var(--border)]">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--fg-subtle)] mb-2">Suppliers</div>
                  <Value value={s.suppliers} />
                </div>
              )}
              <NoteList items={s.notes ?? []} tone="note" />
              <NoteList items={s.data_quality ?? []} tone="quality" />
            </div>
          </section>
        ))}
      </div>

      <footer className="mt-12 pt-6 border-t border-[var(--border)] text-[11px] text-[var(--fg-subtle)]">
        Report.Farm · generated from live farm twin data · report {r.id}
      </footer>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg,var(--surface-muted))]">
      <div className="mx-auto max-w-[900px] px-6 py-10">
        <div className="mb-8 flex items-center gap-2 text-[15px] font-semibold text-[var(--fg)] print:mb-4">
          <Sprout size={18} className="text-[var(--accent)]" /> Report.Farm
        </div>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-24 text-[var(--fg-muted)]">
      <span className="text-[var(--fg-subtle)]">{icon}</span>
      <div className="text-[16px] font-semibold text-[var(--fg)]">{title}</div>
      <p className="max-w-[46ch] text-[13px]">{body}</p>
      <a href="/operations.html" className="mt-3 text-[13px] text-[var(--accent)] hover:underline">← Back to portfolio</a>
    </div>
  );
}
