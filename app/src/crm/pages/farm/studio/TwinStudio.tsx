// =============================================================================
// TwinStudio — the Digital Twin Studio explorer (landing surface).
// -----------------------------------------------------------------------------
// Ported from the concept prototype's studio.twins.index, re-skinned to our
// theme. Grid of twin cards + category filter + search, plus a create-from-
// catalog flow (the prototype's full map placement editor is a later milestone).
// Navigation to a twin's workspace is by query string: /studio.html?twin=<id>.
// =============================================================================

import * as React from 'react';
import { Plus, Search, Sprout, X, Trash2, LayoutGrid } from 'lucide-react';
import {
  useTwins, CATALOG, CATEGORY_LABEL, makeTwinFromCatalog,
  type TwinCategory, type CatalogItem,
} from '@crm/lib/twins-store';
import { StudioHeader, GhostBtn, PrimaryBtn, EmptyState } from './studio-ui';

const CATS: (TwinCategory | 'all')[] = ['all', 'structure', 'equipment', 'crop', 'livestock', 'water'];

export function TwinStudio() {
  const { twins, addTwin, removeTwin } = useTwins();
  const [filter, setFilter] = React.useState<TwinCategory | 'all'>('all');
  const [q, setQ] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const filtered = React.useMemo(() =>
    twins
      .filter((t) => (filter === 'all' ? true : t.category === filter))
      .filter((t) => (q ? (t.name + ' ' + t.kind).toLowerCase().includes(q.toLowerCase()) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  [twins, filter, q]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: twins.length };
    for (const t of twins) c[t.category] = (c[t.category] ?? 0) + 1;
    return c;
  }, [twins]);

  const create = (item: CatalogItem) => {
    const twin = makeTwinFromCatalog(item);
    addTwin(twin);
    setCreating(false);
    window.location.href = `/studio.html?twin=${twin.id}`;
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <StudioHeader
        crumbs={<><span className="text-[var(--fg)]">Digital Twin Studio</span></>}
        right={
          <>
            <a href="/operations.html" className="text-xs text-[var(--fg-muted)] hover:text-[var(--accent)]">← Portfolio</a>
            <PrimaryBtn onClick={() => setCreating(true)}><Plus className="size-3.5" /> New twin</PrimaryBtn>
          </>
        }
      />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-widest,0.2em)] text-[var(--accent)]">
          <LayoutGrid className="size-3.5" /> Twin Explorer
        </div>
        <h1 className="mb-6 text-[26px] font-semibold tracking-[var(--tracking-tight)] font-[var(--font-display)]">
          Your farm, digitized
        </h1>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] p-1 text-xs">
            {CATS.map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`rounded-full px-3 py-1 capitalize transition ${
                  filter === c ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'
                }`}
              >
                {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
                <span className="ml-2 text-[10px] opacity-70">{counts[c] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search twins…"
              className="w-56 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-9 pr-4 text-sm text-[var(--fg)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState>
            <div className="text-3xl">🌱</div>
            <div className="mt-3">No twins yet. Create your first structure, sensor, crop bed or water asset.</div>
            <div className="mt-4"><PrimaryBtn onClick={() => setCreating(true)}><Plus className="size-3.5" /> New twin</PrimaryBtn></div>
          </EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((t) => (
              <a
                key={t.id}
                href={`/studio.html?twin=${t.id}`}
                className="group flex flex-col gap-2 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-card)] transition hover:border-[var(--accent)]"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-xl text-xl" style={{ background: t.color + '22', border: `1px solid ${t.color}55` }}>
                      {t.icon}
                    </div>
                    <div>
                      <div className="font-medium text-[var(--fg)]">{t.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{CATEGORY_LABEL[t.category]} · {t.kind}</div>
                    </div>
                  </div>
                  <span className={`mt-1 h-2 w-2 rounded-full ${t.status.online ? 'bg-[var(--risk-healthy)]' : 'bg-[var(--fg-subtle)]'}`} title={t.status.online ? 'Online' : 'Offline'} />
                </div>
                {t.status.readings.length > 0 && (
                  <div className="mt-1 grid grid-cols-2 gap-1 text-[11px]">
                    {t.status.readings.slice(0, 4).map((r, i) => (
                      <div key={i} className="rounded-md bg-[var(--surface-sunken)] px-2 py-1">
                        <div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)]">{r.label}</div>
                        <div className="font-medium text-[var(--fg)] tabular-nums">{r.value}{r.unit && <span className="ml-1 text-[var(--fg-muted)]">{r.unit}</span>}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--fg-subtle)]">
                  <span>Updated {new Date(t.updatedAt).toLocaleDateString()}</span>
                  <button
                    onClick={(e) => { e.preventDefault(); if (confirm(`Delete "${t.name}"?`)) removeTwin(t.id); }}
                    className="inline-flex items-center gap-1 opacity-0 transition group-hover:opacity-100 hover:text-[var(--risk-critical)]"
                  >
                    <Trash2 className="size-3" /> Delete
                  </button>
                </div>
              </a>
            ))}
          </div>
        )}
      </main>

      {creating && <CreateSheet onClose={() => setCreating(false)} onCreate={create} />}
    </div>
  );
}

function CreateSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (item: CatalogItem) => void }) {
  const [cat, setCat] = React.useState<TwinCategory>('structure');
  const items = CATALOG.filter((i) => i.category === cat);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-popover)] sm:rounded-[var(--radius-2xl)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--fg)]"><Sprout className="size-4 text-[var(--accent)]" /> Add a twin</div>
          <button onClick={onClose} className="text-[var(--fg-muted)] hover:text-[var(--fg)]"><X className="size-4" /></button>
        </div>
        <div className="mb-4 flex flex-wrap gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] p-1 text-xs">
          {(['structure', 'equipment', 'crop', 'livestock', 'water'] as TwinCategory[]).map((c) => (
            <button key={c} onClick={() => setCat(c)} className={`rounded-full px-3 py-1 transition ${cat === c ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {items.map((item) => (
            <button
              key={item.kind}
              onClick={() => onCreate(item)}
              className="flex flex-col items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4 text-center transition hover:border-[var(--accent)]"
            >
              <div className="flex size-11 items-center justify-center rounded-xl text-2xl" style={{ background: item.color + '22', border: `1px solid ${item.color}55` }}>{item.icon}</div>
              <div className="text-[13px] font-medium text-[var(--fg)]">{item.name}</div>
            </button>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-[var(--fg-subtle)]">
          A twin is placed on a default AOI you can refine later. Field boundaries and observations sync from your farm records.
        </p>
      </div>
    </div>
  );
}
