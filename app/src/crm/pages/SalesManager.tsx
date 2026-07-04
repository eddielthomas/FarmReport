// =============================================================================
// SalesManager — Sales surface shell (S7B pixel-perfect rebuild)
// -----------------------------------------------------------------------------
// Internal multi-view shell that mirrors the Sales Dashboard concept boards
// stored under `mvp/concepts/Sales Dashboard-…/`. Five pill tabs on the top
// nav (Overview / Analytics / Companies / Documents / Calculator) plus a
// separate "Workspace" toggle to enter the dark-mode lead-pipeline view.
//
//   Concept → View map
//   ──────────────────────────────────────────────────────────────────────
//   1.webp / a767d…/8e9f74…/89558a…/8296929…  Overview Panel (desktop)
//   556fd…/eff8ba…/c2ab68…                    Overview close-ups (still Overview)
//   2.webp / original-5f47…/original-6b903…   Analytics (Income Statement)
//   0aec…/9b5694…/a3f977…                     Mobile Overview Panel
//   original-9d6acc…                          Foundation (Urbanist + tokens)
//
// Pixel-perfect targets:
//   • Top nav h-12 → 56px; pill tabs h-10 → 40px.
//   • Card radius `--radius-2xl` (28px); page max-w 1600px.
//   • Hero "Overview Panel" headline `--font-size-7xl` (72px) on >= md.
//   • Account Insights uses `--accent` linear gradient (GlassPanel).
// =============================================================================

import * as React from 'react';
import { useSurfaceMode } from '@crm/lib/surface-store';
import { PillTabs, type PillTabItem } from '@crm/components/ui/pill-tabs';
import { Search, Bell, Settings, LayoutDashboard, Sparkles } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { useAuthStore } from '@crm/lib/auth-store';
import { Input } from '@crm/components/ui/input';

import { OverviewPanel }   from '@crm/components/sales/OverviewPanel';
import { AnalyticsView }   from '@crm/components/sales/AnalyticsView';
import { CompaniesView }   from '@crm/components/sales/CompaniesView';
import { DocumentsView }   from '@crm/components/sales/DocumentsView';
import { CalculatorView }  from '@crm/components/sales/CalculatorView';
import { WorkspaceView }   from '@crm/components/sales/WorkspaceView';
import { FieldOpsPanel }   from '@crm/components/field/FieldOpsPanel';

type SalesTab = 'overview' | 'analytics' | 'companies' | 'documents' | 'calculator' | 'field';

const TABS: ReadonlyArray<PillTabItem<SalesTab>> = [
  { key: 'overview',   label: 'Overview' },
  { key: 'analytics',  label: 'Analytics' },
  { key: 'companies',  label: 'Companies' },
  { key: 'documents',  label: 'Documents' },
  { key: 'calculator', label: 'Calculator' },
  { key: 'field',      label: 'Field' },
];

// S9B — Field surface shown in the dedicated Field tab.
const FieldView: React.FC = () => (
  <div className="p-4 sm:p-6 max-w-[1500px] mx-auto">
    <FieldOpsPanel defaultOpen />
  </div>
);

export function SalesManager() {
  const [tab, setTab]         = React.useState<SalesTab>('overview');
  const [workspace, setWorkspace] = React.useState(false);
  const [query, setQuery]     = React.useState('');
  const user                  = useAuthStore((s) => s.user);
  const { mode } = useSurfaceMode();

  // Keyboard: g-then-letter quick switch (g o = overview, g a = analytics, …)
  React.useEffect(() => {
    let prefix = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        prefix = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { prefix = false; }, 700);
        return;
      }
      if (!prefix) return;
      const next: Record<string, SalesTab | 'workspace'> = {
        o: 'overview', a: 'analytics', c: 'companies', d: 'documents', k: 'calculator', w: 'workspace', f: 'field',
      };
      const target = next[e.key.toLowerCase()];
      if (!target) return;
      e.preventDefault();
      if (target === 'workspace') setWorkspace((v) => !v);
      else { setWorkspace(false); setTab(target); }
      prefix = false;
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ActiveView = workspace ? WorkspaceView : VIEWS[tab];
  const displayName = user?.display_name ?? user?.email?.split('@')[0] ?? 'User';
  const initials = (displayName || '?').trim().charAt(0).toUpperCase();
  const roleLabel = (user?.roles ?? []).find((r) => r.includes(':'))?.split(':')[0] ?? 'Manager';

  return (
    <div className="h-full flex flex-col bg-[var(--bg)] text-[var(--fg)] overflow-hidden">
      {/* Sales-surface internal top nav (concept matches this exactly) */}
      <header
        className={cn(
          'shrink-0 flex items-center gap-3 px-4 sm:px-6 lg:px-8 py-3 sm:py-4',
          'bg-[var(--bg)]',
        )}
        role="banner"
      >
        <PillTabs<SalesTab>
          value={tab}
          onChange={(k) => { setTab(k); setWorkspace(false); }}
          items={TABS}
          size="lg"
          aria-label="Sales sections"
        />

        <div className="flex-1" />

        {/* Search */}
        <label className="hidden md:flex relative items-center w-[260px] max-w-[28vw]">
          <Search className="absolute left-3 size-3.5 text-[var(--fg-muted)] pointer-events-none" aria-hidden="true" />
          <Input
            variant="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type Client Name or ID"
            className="pl-9"
            aria-label="Search clients"
          />
        </label>

        {/* Action chips */}
        <button
          type="button"
          aria-label="Notifications"
          className="grid place-items-center size-10 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)] relative"
        >
          <Bell className="size-4" />
          <span aria-hidden="true" className="absolute top-2 right-2 size-1.5 rounded-[var(--radius-full)] bg-[var(--accent)]" />
        </button>
        <button
          type="button"
          aria-label="Workspace mode"
          aria-pressed={workspace}
          onClick={() => setWorkspace((w) => !w)}
          title="Workspace (g w)"
          className={cn(
            'grid place-items-center size-10 rounded-[var(--radius-md)] border transition-colors duration-[var(--duration-fast)]',
            workspace
              ? 'bg-[var(--fg)] text-[var(--fg-inverted)] border-transparent shadow-[var(--shadow-card)]'
              : 'bg-[var(--surface)] text-[var(--fg)] border-[var(--border)] hover:bg-[var(--surface-sunken)]',
          )}
        >
          {workspace ? <Sparkles className="size-4" /> : <LayoutDashboard className="size-4" />}
        </button>
        <button
          type="button"
          aria-label="Settings"
          className="grid place-items-center size-10 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-sunken)] transition-colors duration-[var(--duration-fast)]"
        >
          <Settings className="size-4" />
        </button>

        {/* User chip */}
        <div className="flex items-center gap-3 pl-2">
          <span
            aria-hidden="true"
            className="grid place-items-center size-10 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] text-[13px] font-semibold shadow-[var(--shadow-soft)]"
          >
            {initials}
          </span>
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-[var(--fg)]">{displayName}</span>
            <span className="text-[11px] capitalize text-[var(--fg-muted)]">{roleLabel}</span>
          </div>
        </div>
      </header>

      {/* Active view */}
      <main
        className="flex-1 min-h-0 overflow-y-auto"
        aria-label={workspace ? 'Workspace' : tab}
        data-active-view={workspace ? 'workspace' : tab}
        data-surface-mode={mode}
      >
        <ActiveView />
      </main>
    </div>
  );
}

const VIEWS: Record<SalesTab, React.FC> = {
  overview:   OverviewPanel,
  analytics:  AnalyticsView,
  companies:  CompaniesView,
  documents:  DocumentsView,
  calculator: CalculatorView,
  field:      FieldView,
};
