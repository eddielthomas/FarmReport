// =============================================================================
// TwinDetail — the per-twin workspace (dossier). Ported from the concept
// prototype's studio.twins.$twinId, re-skinned to Report.Farm tokens. Core tabs
// shipped: Overview, Telemetry, Maintenance, Docs, Calendar. (Advanced tabs —
// yields, treatments, predictions, sensor fusion, supply — land next.)
// =============================================================================

import * as React from 'react';
import {
  ArrowLeft, Copy, Trash2, Layers3, Activity, Wrench, FileText, CalendarDays,
  Plus, X, Check, LayoutGrid,
} from 'lucide-react';
import {
  useTwins, healthScore, CATEGORY_LABEL,
  type Twin, type MaintenanceEntry, type TwinDoc, type CalendarEvent,
} from '@crm/lib/twins-store';
import { ParcelCutaway } from '@crm/components/farm/studio/ParcelCutaway';
import {
  StudioHeader, GhostBtn, PrimaryBtn, Card, Field, Input, Textarea, Select,
  StatusPill, MetricRing, MetricStat, EmptyState, timeAgo, sparklinePoints,
} from './studio-ui';

type Tab = 'overview' | 'telemetry' | 'maintenance' | 'calendar' | 'docs';
const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'telemetry', label: 'Telemetry', icon: Activity },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'docs', label: 'Docs', icon: FileText },
];

export function TwinDetail({ twinId }: { twinId: string }) {
  const { twins, updateTwin, removeTwin, duplicateTwin } = useTwins();
  const twin = React.useMemo(() => twins.find((t) => t.id === twinId), [twins, twinId]);
  const [tab, setTab] = React.useState<Tab>('overview');
  const [saving, setSaving] = React.useState<null | 'saving' | 'saved'>(null);
  const saveTimer = React.useRef<number | null>(null);

  const patch = (p: Partial<Twin>) => {
    if (!twin) return;
    updateTwin(twin.id, p);
    setSaving('saving');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaving('saved'), 400);
  };

  if (!twin) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--bg)] text-[var(--fg)]">
        <div className="max-w-md text-center">
          <Layers3 className="mx-auto size-8 text-[var(--fg-subtle)]" />
          <div className="mt-3 text-lg font-medium">Twin not found</div>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">Twins are stored in this browser's studio library. Open it where you created it, or head back to the explorer.</p>
          <a href="/studio.html" className="mt-4 inline-block rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--accent)] hover:border-[var(--accent)]">Back to Studio</a>
        </div>
      </div>
    );
  }

  const health = healthScore(twin);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <StudioHeader
        crumbs={
          <>
            <a href="/studio.html" className="hover:text-[var(--fg)]">Studio</a>
            <span className="mx-2 opacity-40">/</span>
            <span className="text-[var(--fg)]">{twin.name}</span>
            {saving && (
              <span className="ml-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                <span className={`h-1.5 w-1.5 rounded-full ${saving === 'saving' ? 'animate-pulse bg-[var(--accent)]' : 'bg-[var(--risk-healthy)]'}`} />
                {saving === 'saving' ? 'Saving' : 'Saved'}
              </span>
            )}
          </>
        }
        right={
          <>
            <a href="/studio.html" className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)] hover:text-[var(--accent)]"><ArrowLeft className="size-3.5" /> Explorer</a>
            <GhostBtn onClick={() => duplicateTwin(twin.id)}><Copy className="size-3.5" /> Duplicate</GhostBtn>
            <button
              onClick={() => { if (confirm(`Delete "${twin.name}"?`)) { removeTwin(twin.id); window.location.href = '/studio.html'; } }}
              className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--risk-critical)_50%,transparent)] bg-[color-mix(in_oklch,var(--risk-critical-fill)_50%,transparent)] px-3 py-1.5 text-xs text-[var(--risk-critical)] hover:brightness-110"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </>
        }
      />

      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* Hero */}
        <section className="relative overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
          <div className="absolute inset-0 opacity-30" style={{ background: `radial-gradient(600px circle at 15% 0%, ${twin.color}44, transparent 60%)` }} />
          <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-center">
            <div className="flex size-24 shrink-0 items-center justify-center rounded-[var(--radius-2xl)] text-5xl" style={{ background: `linear-gradient(135deg, ${twin.color}33, ${twin.color}11)`, border: `1px solid ${twin.color}55` }}>
              {twin.icon}
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-[var(--fg-subtle)]">
                <span>{CATEGORY_LABEL[twin.category]}</span><span className="opacity-30">·</span>
                <span>{twin.kind}</span><span className="opacity-30">·</span>
                <span>ID {twin.id.slice(-6)}</span>
              </div>
              <input
                value={twin.name}
                onChange={(e) => patch({ name: e.target.value })}
                className="mt-1 w-full bg-transparent text-3xl font-semibold tracking-tight text-[var(--fg)] outline-none focus:text-[var(--accent)]"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--fg-muted)]">
                <StatusPill online={twin.status.online} onToggle={(v) => patch({ status: { ...twin.status, online: v } })} />
                <span>Placed {new Date(twin.createdAt).toLocaleDateString()}</span>
                <span>· Updated {timeAgo(twin.updatedAt)}</span>
              </div>
            </div>
            <div className="flex gap-3">
              <MetricRing label="Health" value={health} color={twin.color} />
              <MetricStat label="Readings" value={String(twin.status.readings.length)} />
              <MetricStat label="Logs" value={String(twin.maintenance.length)} />
              <MetricStat label="Docs" value={String(twin.docs.length)} />
            </div>
          </div>
        </section>

        {/* Tabs */}
        <div className="mt-6 flex flex-wrap gap-1 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-1 text-xs">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1.5 rounded-[var(--radius-lg)] px-3 py-2 transition ${
                tab === id ? 'bg-[var(--accent)] text-[var(--fg-on-accent)] shadow-[var(--shadow-accent)]' : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--fg)]'
              }`}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {tab === 'overview' && <OverviewPanel twin={twin} onSwitch={setTab} />}
          {tab === 'telemetry' && <TelemetryPanel twin={twin} onUpdate={patch} />}
          {tab === 'maintenance' && <MaintenancePanel entries={twin.maintenance} onChange={(next) => patch({ maintenance: next })} />}
          {tab === 'calendar' && <CalendarPanel events={twin.events ?? []} onChange={(next) => patch({ events: next })} color={twin.color} />}
          {tab === 'docs' && <DocsPanel docs={twin.docs} onChange={(next) => patch({ docs: next })} />}
        </div>
      </main>
    </div>
  );
}

/* ---------- panels ---------- */

function OverviewPanel({ twin, onSwitch }: { twin: Twin; onSwitch: (t: Tab) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-4 md:col-span-2">
        <Card title="Summary">
          <p className="text-sm leading-relaxed text-[var(--fg)]/80">
            {twin.specs.notes || <span className="italic text-[var(--fg-muted)]">No description yet. Add operating notes below to document what this {twin.kind} is for and who maintains it.</span>}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryCell label="Vendor" value={twin.specs.vendor || '—'} />
            <SummaryCell label="Installed" value={twin.specs.installDate || '—'} />
            <SummaryCell label="Size" value={twin.specs.sizeLabel || '—'} />
            <SummaryCell label="Cost" value={twin.specs.costUsd ? `$${twin.specs.costUsd.toLocaleString()}` : '—'} />
          </div>
        </Card>
        <Card title="Live telemetry" action={<button onClick={() => onSwitch('telemetry')} className="text-[11px] text-[var(--accent)] hover:underline">Manage →</button>}>
          {twin.status.readings.length === 0 ? (
            <EmptyState>No readings yet. Add sensor values in the Telemetry tab.</EmptyState>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {twin.status.readings.map((r, i) => <ReadingCard key={i} label={r.label} value={r.value} unit={r.unit} color={twin.color} seed={i + twin.id.length} />)}
            </div>
          )}
        </Card>
        <Card title="Recent maintenance" action={<button onClick={() => onSwitch('maintenance')} className="text-[11px] text-[var(--accent)] hover:underline">View all →</button>}>
          {twin.maintenance.length === 0 ? (
            <EmptyState>No maintenance events logged.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {twin.maintenance.slice(0, 3).map((e) => (
                <li key={e.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                  <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                  <div className="flex-1"><div className="text-xs text-[var(--fg-muted)]">{e.date} · {e.type}</div><div className="text-sm text-[var(--fg)]">{e.notes || <span className="italic text-[var(--fg-muted)]">no notes</span>}</div></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Parcel cutaway">
          <ParcelCutaway twin={twin} height={240} />
          <div className="mt-3 text-[11px] text-[var(--fg-muted)]">
            <div><span className="font-[var(--font-mono)]">{twin.geom.type}</span> geometry</div>
          </div>
        </Card>
        <Card title="Geometry">
          <div className="space-y-1.5 text-[11px] text-[var(--fg-muted)]">
            <div className="flex items-center justify-between"><span className="text-[var(--fg-subtle)]">Type</span><span className="font-[var(--font-mono)] text-[var(--fg)]">{twin.geom.type}</span></div>
            {twin.geom.type === 'circle' && <div className="flex items-center justify-between"><span className="text-[var(--fg-subtle)]">Radius</span><span className="font-[var(--font-mono)] text-[var(--fg)]">{twin.geom.radiusM.toFixed(0)} m</span></div>}
            {twin.geom.type === 'rect' && <div className="flex items-center justify-between"><span className="text-[var(--fg-subtle)]">Size</span><span className="font-[var(--font-mono)] text-[var(--fg)]">{twin.geom.widthM.toFixed(0)} × {twin.geom.heightM.toFixed(0)} m</span></div>}
            <div className="flex items-center justify-between"><span className="text-[var(--fg-subtle)]">Parcel</span><span className="font-[var(--font-mono)] text-[var(--fg)]">{twin.parcelId ? twin.parcelId.slice(0, 8) : 'unassigned'}</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5">
      <div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
      <div className="mt-0.5 truncate text-sm text-[var(--fg)]">{value}</div>
    </div>
  );
}

function ReadingCard({ label, value, unit, color, seed }: { label: string; value: string; unit?: string; color: string; seed: number }) {
  const points = React.useMemo(() => sparklinePoints(seed), [seed]);
  return (
    <div className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1"><span className="text-lg font-semibold text-[var(--fg)] tabular-nums">{value}</span>{unit && <span className="text-[11px] text-[var(--fg-muted)]">{unit}</span>}</div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-8 w-full">
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={`${points} 100,30 0,30`} fill={color} fillOpacity="0.15" />
      </svg>
    </div>
  );
}

function TelemetryPanel({ twin, onUpdate }: { twin: Twin; onUpdate: (p: Partial<Twin>) => void }) {
  const [label, setLabel] = React.useState('');
  const [value, setValue] = React.useState('');
  const [unit, setUnit] = React.useState('');
  const set = (readings: Twin['status']['readings']) => onUpdate({ status: { ...twin.status, readings } });
  return (
    <div className="space-y-4">
      <Card title="Connection" action={<StatusPill online={twin.status.online} onToggle={(v) => onUpdate({ status: { ...twin.status, online: v } })} />}>
        <p className="text-xs text-[var(--fg-muted)]">Toggle the connection state to simulate the twin coming online or dropping off. Live readings render as sparkline cards for at-a-glance monitoring.</p>
      </Card>
      <Card title="Live readings" action={<span className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{twin.status.readings.length} channels</span>}>
        {twin.status.readings.length === 0 ? (
          <EmptyState>No readings yet. Add your first channel below.</EmptyState>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {twin.status.readings.map((r, i) => (
              <div key={i} className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                <button onClick={() => set(twin.status.readings.filter((_, j) => j !== i))} className="absolute right-2 top-2 text-xs text-[var(--fg-subtle)] hover:text-[var(--risk-critical)]"><X className="size-3" /></button>
                <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{r.label}</div>
                <div className="mt-0.5 flex items-baseline gap-1"><span className="text-lg font-semibold text-[var(--fg)] tabular-nums">{r.value}</span>{r.unit && <span className="text-[11px] text-[var(--fg-muted)]">{r.unit}</span>}</div>
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-8 w-full">
                  <polyline points={sparklinePoints(i + twin.id.length)} fill="none" stroke={twin.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-sunken)]/40 p-3">
          <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Moisture" /></Field>
          <Field label="Value"><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="22" /></Field>
          <Field label="Unit"><Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="%" /></Field>
          <PrimaryBtn onClick={() => { if (!label) return; set([...twin.status.readings, { label, value, unit }]); setLabel(''); setValue(''); setUnit(''); }}><Plus className="size-3.5" /> Add channel</PrimaryBtn>
        </div>
      </Card>
    </div>
  );
}

function MaintenancePanel({ entries, onChange }: { entries: MaintenanceEntry[]; onChange: (next: MaintenanceEntry[]) => void }) {
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = React.useState('Inspection');
  const [notes, setNotes] = React.useState('');
  return (
    <div className="space-y-4">
      <Card title="Log a new event">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)}>{['Inspection', 'Repair', 'Service', 'Calibration', 'Replacement'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <div className="md:col-span-2"><Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was done?" /></Field></div>
        </div>
        <div className="mt-3 flex justify-end"><PrimaryBtn onClick={() => { onChange([{ id: `m_${Date.now()}`, date, type, notes }, ...entries]); setNotes(''); }}><Plus className="size-3.5" /> Log entry</PrimaryBtn></div>
      </Card>
      <Card title={`Timeline · ${entries.length} entries`}>
        {entries.length === 0 ? (
          <EmptyState>No maintenance logged yet.</EmptyState>
        ) : (
          <ol className="relative space-y-4 border-l border-[var(--border)] pl-6">
            {entries.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-[var(--bg)] bg-[var(--accent)]" />
                <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)]"><span>{e.date}</span><span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 uppercase tracking-wider">{e.type}</span></div>
                    <div className="mt-1 text-sm text-[var(--fg)]">{e.notes || <span className="italic text-[var(--fg-muted)]">no notes</span>}</div>
                  </div>
                  <button onClick={() => onChange(entries.filter((x) => x.id !== e.id))} className="text-xs text-[var(--fg-subtle)] hover:text-[var(--risk-critical)]"><X className="size-3.5" /></button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function DocsPanel({ docs, onChange }: { docs: TwinDoc[]; onChange: (next: TwinDoc[]) => void }) {
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  return (
    <div className="space-y-4">
      <Card title="Attach a document">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Owner's manual" /></Field>
          <div className="md:col-span-2"><Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field></div>
        </div>
        <div className="mt-3 flex justify-end"><PrimaryBtn onClick={() => { if (!name) return; onChange([...docs, { id: `d_${Date.now()}`, name, url }]); setName(''); setUrl(''); }}><Plus className="size-3.5" /> Attach</PrimaryBtn></div>
      </Card>
      <Card title={`Attachments · ${docs.length}`}>
        {docs.length === 0 ? (
          <EmptyState>No documents attached.</EmptyState>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {docs.map((d) => (
              <div key={d.id} className="group flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-sm hover:border-[var(--accent)]">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-[color-mix(in_oklch,var(--accent)_12%,transparent)]"><FileText className="size-4 text-[var(--accent)]" /></div>
                  <div><div className="font-medium text-[var(--fg)]">{d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)] hover:underline">{d.name}</a> : d.name}</div>{d.url && <div className="max-w-[220px] truncate text-[10px] text-[var(--fg-subtle)]">{d.url}</div>}</div>
                </div>
                <button onClick={() => onChange(docs.filter((x) => x.id !== d.id))} className="text-xs text-[var(--fg-subtle)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--risk-critical)]"><X className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function CalendarPanel({ events, onChange, color }: { events: CalendarEvent[]; onChange: (next: CalendarEvent[]) => void; color: string }) {
  const [cursor, setCursor] = React.useState(() => new Date());
  const [draft, setDraft] = React.useState<Partial<CalendarEvent>>({ kind: 'task', date: new Date().toISOString().slice(0, 10), title: '' });
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const monthLabel = cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const todayIso = new Date().toISOString().slice(0, 10);
  const byDate = React.useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date)!.push(e); }
    return m;
  }, [events]);
  const upcoming = React.useMemo(() => [...events].sort((a, b) => a.date.localeCompare(b.date)).filter((e) => e.date >= todayIso).slice(0, 6), [events, todayIso]);
  const kindStyle: Record<CalendarEvent['kind'], string> = {
    task: 'bg-[color-mix(in_oklch,var(--accent)_20%,transparent)] text-[var(--accent)]',
    scan: 'bg-sky-400/20 text-sky-500',
    treatment: 'bg-fuchsia-400/20 text-fuchsia-500',
    harvest: 'bg-amber-400/20 text-amber-600',
    maintenance: 'bg-orange-400/20 text-orange-600',
    note: 'bg-[var(--surface-sunken)] text-[var(--fg-muted)]',
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card title={monthLabel} action={
          <div className="flex gap-1">
            <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px]">←</button>
            <button onClick={() => setCursor(new Date())} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px]">Today</button>
            <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px]">→</button>
          </div>
        }>
          <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="p-1 text-center">{d}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: startDay }).map((_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const list = byDate.get(iso) ?? [];
              const isToday = iso === todayIso;
              return (
                <div key={day} className={`min-h-[60px] rounded-lg border p-1.5 text-[10px] ${isToday ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]' : 'border-[var(--border)] bg-[var(--surface-sunken)]/40'}`}>
                  <div className="flex items-center justify-between"><span className={isToday ? 'font-semibold text-[var(--accent)]' : 'text-[var(--fg-muted)]'}>{day}</span>{list.length > 0 && <span className="rounded-full px-1 text-[9px]" style={{ background: color + '33', color }}>{list.length}</span>}</div>
                  <div className="mt-1 space-y-0.5">
                    {list.slice(0, 2).map((e) => <div key={e.id} className={`truncate rounded px-1 py-0.5 ${kindStyle[e.kind]}`} title={e.title}>{e.title}</div>)}
                    {list.length > 2 && <div className="text-[9px] text-[var(--fg-subtle)]">+{list.length - 2}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Schedule event">
          <div className="grid gap-2">
            <Input placeholder="Title" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={draft.date ?? ''} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              <Input type="time" value={draft.time ?? ''} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </div>
            <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as CalendarEvent['kind'] })}>
              {(['task', 'scan', 'treatment', 'harvest', 'maintenance', 'note'] as const).map((k) => <option key={k}>{k}</option>)}
            </Select>
            <PrimaryBtn onClick={() => { if (!draft.title || !draft.date) return; onChange([...events, { id: `e_${Date.now()}`, title: draft.title!, date: draft.date!, time: draft.time, kind: draft.kind as CalendarEvent['kind'], notes: '' }]); setDraft({ kind: 'task', date: draft.date, title: '' }); }}><Plus className="size-3.5" /> Add event</PrimaryBtn>
          </div>
        </Card>
        <Card title="Upcoming">
          {upcoming.length === 0 ? <div className="text-[11px] text-[var(--fg-subtle)]">Nothing scheduled.</div> : (
            <ul className="space-y-1.5">
              {upcoming.map((e) => (
                <li key={e.id} className="flex items-start justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-2 text-xs">
                  <div><div className="text-[var(--fg-muted)]">{e.date}{e.time ? ` · ${e.time}` : ''}</div><div className="font-medium text-[var(--fg)]">{e.title}</div><span className={`mt-1 inline-block rounded px-1.5 text-[9px] uppercase tracking-wider ${kindStyle[e.kind]}`}>{e.kind}</span></div>
                  <div className="flex flex-col gap-1">
                    <button onClick={() => onChange(events.map((x) => x.id === e.id ? { ...x, done: !x.done } : x))} className="text-[var(--fg-subtle)] hover:text-[var(--risk-healthy)]">{e.done ? <Check className="size-3.5" /> : '○'}</button>
                    <button onClick={() => onChange(events.filter((x) => x.id !== e.id))} className="text-[var(--fg-subtle)] hover:text-[var(--risk-critical)]"><X className="size-3.5" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
