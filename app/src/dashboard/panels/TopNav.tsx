// =============================================================================
// dashboard/panels/TopNav.tsx — shell top navigation.
// =============================================================================

import { Menu, Bell, Settings, User, Radio, HelpCircle } from 'lucide-react';
import { useDashboardStore } from '../store';

const SURFACE_LINKS = [
  { href: '/dashboard.html',  label: 'Map',       active: true  },
  { href: '/sales.html',      label: 'Sales',     active: false },
  { href: '/pm.html',         label: 'Projects',  active: false },
  { href: '/analytics.html',  label: 'Analytics', active: false },
  { href: '/operations.html', label: 'Ops',       active: false },
  { href: '/tenants.html',    label: 'Tenants',   active: false },
];

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'detections', label: 'Detections' },
  { id: 'analytics',  label: 'Analytics' },
  { id: 'assets',     label: 'Assets' },
  { id: 'reports',    label: 'Reports' },
  { id: 'settings',   label: 'Settings' },
] as const;

export function TopNav() {
  const setLeft   = useDashboardStore((s) => s.setLeftDrawerOpen);
  const setRight  = useDashboardStore((s) => s.setRightDrawerOpen);
  const activeTab = useDashboardStore((s) => s.activeTab);
  const setActive = useDashboardStore((s) => s.setActiveTab);

  return (
    <nav
      data-coachmark="dash.topnav"
      className="col-span-3 flex items-center gap-2 px-2 sm:px-3 border-b border-[var(--border)] glass-3 z-50"
      style={{ gridColumn: '1 / -1', height: 36 }}
    >
      {/* mobile hamburger — only visible <=900px via CSS */}
      <button
        onClick={() => setLeft(true)}
        className="lg:hidden size-8 flex items-center justify-center rounded text-[var(--signal-cyan)] hover:bg-[var(--accent)]"
        aria-label="Open mission panel"
      >
        <Menu className="size-4" />
      </button>

      <div className="flex items-center gap-1.5 shrink-0">
        <div className="size-5 rounded-sm bg-gradient-to-br from-[var(--signal-blue)] to-[var(--signal-cyan)] flex items-center justify-center text-[8px] font-bold text-black">
          S
        </div>
        <span className="hidden sm:inline text-[10px] font-mono tracking-[0.18em] text-[var(--rwr-t1)]">
          SENTINEL
        </span>
        <span className="hidden md:inline text-[7.5px] font-mono text-[var(--rwr-t3)] border-l border-[var(--border)] pl-2">
          OPS COMMAND v4.2
        </span>
      </div>

      {/* Cross-surface links */}
      <div className="hidden md:flex items-center gap-0.5 border-l border-[var(--border)] pl-2 ml-1 overflow-x-auto">
        {SURFACE_LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className={`shrink-0 px-2 h-6 flex items-center rounded text-[8px] font-mono uppercase tracking-wider transition-colors ${
              l.active
                ? 'text-[var(--signal-cyan)] bg-[rgba(0,212,255,0.06)] border border-[rgba(0,212,255,0.18)]'
                : 'text-[var(--rwr-t3)] border border-transparent hover:text-[var(--rwr-t1)] hover:bg-[var(--accent)]'
            }`}
          >
            {l.label}
          </a>
        ))}
      </div>

      {/* Section tabs */}
      <div className="hidden xl:flex items-center gap-0 ml-2 h-full">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`relative px-3 h-full flex items-center text-[8px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
              activeTab === t.id
                ? 'text-[var(--signal-cyan)] border-[var(--signal-cyan)]'
                : 'text-[var(--rwr-t3)] border-transparent hover:text-[var(--rwr-t2)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="hidden sm:flex items-center gap-1.5 text-[8px] font-semibold text-[var(--signal-green)]">
          <span className="size-1.5 rounded-full bg-[var(--signal-green)] shadow-[0_0_6px_var(--signal-green)] animate-pulse" />
          ALL SYSTEMS NOMINAL
        </div>
        <button className="hidden md:flex size-7 items-center justify-center rounded border border-[var(--border)] text-[var(--rwr-t2)] hover:text-[var(--signal-cyan)] hover:border-[var(--rwr-borderH)] transition-colors relative">
          <Bell className="size-3" />
          <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-[var(--signal-red)] text-[6px] font-bold text-white flex items-center justify-center">5</span>
        </button>
        <button className="hidden md:flex size-7 items-center justify-center rounded border border-[var(--border)] text-[var(--rwr-t2)] hover:text-[var(--signal-cyan)] hover:border-[var(--rwr-borderH)] transition-colors">
          <Settings className="size-3" />
        </button>
        <button className="hidden md:flex size-7 items-center justify-center rounded border border-[var(--border)] text-[var(--rwr-t2)] hover:text-[var(--signal-cyan)] hover:border-[var(--rwr-borderH)] transition-colors">
          <User className="size-3" />
        </button>

        {/* mobile right-drawer toggle */}
        <button
          onClick={() => setRight(true)}
          className="lg:hidden size-8 flex items-center justify-center rounded text-[var(--signal-cyan)] hover:bg-[var(--accent)]"
          aria-label="Open detection feed"
        >
          <Radio className="size-4" />
        </button>
      </div>
    </nav>
  );
}
