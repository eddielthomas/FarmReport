// =============================================================================
// FieldApp — top-level shell for the field PWA (S9B).
// -----------------------------------------------------------------------------
// Layout (mobile-first, 375px minimum width):
//
//   ┌─────────────────────────────────────────────────────┐
//   │ top bar (56px)                                       │
//   │   BrandMark · "Field"        [⚡net] [🔋bat] [☼/☾] │
//   ├─────────────────────────────────────────────────────┤
//   │                                                      │
//   │ active tab content (flex-1, scrollable)              │
//   │                                                      │
//   ├─────────────────────────────────────────────────────┤
//   │ bottom tab bar (72px, big touch targets)            │
//   │   [Jobs] [Map] [Upload] [Time] [Me]                 │
//   └─────────────────────────────────────────────────────┘
//
// Auth gate: if no token, replace location to /login.html?next=/field.html.
// =============================================================================

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@crm/lib/api';
import { useAuthStore } from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';
import { useSurfaceMode } from '@crm/lib/surface-store';
import { BrandMark } from '@crm/components/ui/brand-mark';
import { SurfaceModeToggle } from '@crm/components/ui/surface-mode-toggle';
import { useGeolocation } from '@crm/lib/useGeolocation';
import { useFieldEvents } from '@crm/lib/field-socket';
import { cn } from '@crm/lib/utils';
import {
  Briefcase, Map as MapIcon, Camera, Clock, User as UserIcon,
  Wifi, WifiOff, Battery, BatteryLow, BatteryWarning,
} from 'lucide-react';

import { JobsTab }   from './field/JobsTab';
import { MapTab }    from './field/MapTab';
import { UploadTab } from './field/UploadTab';
import { TimeTab }   from './field/TimeTab';
import { MeTab }     from './field/MeTab';

export type FieldTabKey = 'jobs' | 'map' | 'upload' | 'time' | 'me';

interface TabDef {
  key:   FieldTabKey;
  label: string;
  icon:  React.ReactNode;
  Component: React.FC;
}

const TABS: TabDef[] = [
  { key: 'jobs',   label: 'Jobs',   icon: <Briefcase className="size-6" />, Component: JobsTab },
  { key: 'map',    label: 'Map',    icon: <MapIcon   className="size-6" />, Component: MapTab },
  { key: 'upload', label: 'Upload', icon: <Camera    className="size-6" />, Component: UploadTab },
  { key: 'time',   label: 'Time',   icon: <Clock     className="size-6" />, Component: TimeTab },
  { key: 'me',     label: 'Me',     icon: <UserIcon  className="size-6" />, Component: MeTab },
];

const HASH_TO_TAB: Record<string, FieldTabKey> = {
  '#jobs': 'jobs', '#map': 'map', '#upload': 'upload', '#time': 'time', '#me': 'me',
};

export function FieldApp() {
  useSurfaceMode(); // syncs <html data-surface> to the persisted preference.

  const token  = useAuthStore((s) => s.token);
  const user   = useAuthStore((s) => s.user);
  const tenant = useTenantStore((s) => s.currentTenantId);

  // ---- auth gate ----------------------------------------------------------
  React.useEffect(() => {
    if (!token || !user || !tenant) {
      const here = window.location.pathname + window.location.search;
      window.location.replace(`/login.html?next=${encodeURIComponent(here)}`);
    }
  }, [token, user, tenant]);

  // ---- tab routing (URL hash) ---------------------------------------------
  const initialHash = typeof window !== 'undefined' ? window.location.hash : '';
  const [tab, setTab] = React.useState<FieldTabKey>(HASH_TO_TAB[initialHash] ?? 'jobs');

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = () => {
      const next = HASH_TO_TAB[window.location.hash];
      if (next) setTab(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const changeTab = React.useCallback((key: FieldTabKey) => {
    setTab(key);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${key}`);
    }
  }, []);

  // ---- on-shift detection -------------------------------------------------
  // Poll the open time entry so we only stream location while the field
  // agronomist is actually clocked in. Falls back to scanning jobs when the dedicated
  // endpoint is unavailable (mirrors TimeTab's resolver).
  const { data: active } = useQuery({
    queryKey: ['field-active-time'],
    queryFn: async (): Promise<{ time_entry: { id?: string; ended_at?: string | null } | null }> => {
      try {
        return await apiGet('/field/time/active');
      } catch {
        return { time_entry: null };
      }
    },
    enabled: !!token,
    refetchInterval: 60_000,
  });
  const isOnShift = !!active?.time_entry?.id && !active.time_entry.ended_at;

  // ---- GPS watcher (the hook owns the heartbeat to /field/location) -------
  // Watcher always runs for a live in-tab marker; the 10-minute network
  // heartbeat only fires while on shift.
  const geo = useGeolocation({
    enabled: !!token,
    postIntervalMs: 10 * 60 * 1000,
    postingEnabled: isOnShift,
  });

  // ---- socket connection status ------------------------------------------
  const connectedRef = useFieldEvents(React.useMemo(() => ({}), []));
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);
  void tick; // re-render every 5s so the indicators refresh

  // ---- battery + network indicators (best-effort APIs) --------------------
  const [battery, setBattery] = React.useState<{ level: number; charging: boolean } | null>(null);
  React.useEffect(() => {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number;
        charging: boolean;
        addEventListener: (e: string, cb: () => void) => void;
      }>;
    };
    if (typeof nav.getBattery !== 'function') return;
    let cancelled = false;
    nav.getBattery().then((b) => {
      if (cancelled) return;
      const sync = () => setBattery({ level: b.level, charging: b.charging });
      sync();
      b.addEventListener('levelchange', sync);
      b.addEventListener('chargingchange', sync);
    }).catch(() => { /* unsupported */ });
    return () => { cancelled = true; };
  }, []);
  const networkType = React.useMemo(() => {
    const c = (navigator as Navigator & {
      connection?: { effectiveType?: string };
    }).connection;
    return c?.effectiveType ?? null;
  }, []);

  const Active = TABS.find((t) => t.key === tab)?.Component ?? JobsTab;

  // Don't render anything if we're about to redirect — avoids a flash of UI.
  if (!token || !user || !tenant) return null;

  return (
    <div
      className="flex flex-col w-full bg-[var(--bg)] text-[var(--fg)]"
      style={{ height: '100dvh' }}
    >
      {/* ─── top bar ─────────────────────────────────────────────────────── */}
      <header
        className={cn(
          'shrink-0 flex items-center gap-3 px-4',
          'bg-[var(--bg-elevated)] border-b border-[var(--border)]',
        )}
        style={{ minHeight: 56 }}
        role="banner"
      >
        <BrandMark size={28} />
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[10px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">
            Report.Farm Field
          </span>
          <span className="text-[14px] font-semibold text-[var(--fg)] truncate">
            {user.display_name ?? user.email}
          </span>
        </div>
        <div className="flex-1" />

        {/* connection status dot */}
        <span
          aria-label={connectedRef.current ? 'Connected' : 'Disconnected'}
          title={connectedRef.current ? 'Live' : 'Offline'}
          className={cn(
            'inline-flex items-center justify-center size-9 rounded-[var(--radius-full)]',
            'bg-[var(--surface)] border border-[var(--border)]',
          )}
        >
          {connectedRef.current
            ? <Wifi  className="size-4 text-[var(--green)]" />
            : <WifiOff className="size-4 text-[var(--orange)]" />}
        </span>

        {/* battery */}
        {battery && (
          <span
            aria-label={`Battery ${Math.round(battery.level * 100)}%`}
            title={`Battery ${Math.round(battery.level * 100)}%${battery.charging ? ' (charging)' : ''}`}
            className={cn(
              'inline-flex items-center justify-center size-9 rounded-[var(--radius-full)]',
              'bg-[var(--surface)] border border-[var(--border)]',
            )}
          >
            {battery.level < 0.15
              ? <BatteryWarning className="size-4 text-[var(--red)]" />
              : battery.level < 0.30
                ? <BatteryLow className="size-4 text-[var(--orange)]" />
                : <Battery   className="size-4 text-[var(--green)]" />}
          </span>
        )}

        <SurfaceModeToggle compact />
      </header>

      {/* ─── permission banner ───────────────────────────────────────────── */}
      {geo.permission === 'denied' && (
        <div
          role="alert"
          className="shrink-0 px-4 py-2 text-[12px] bg-[var(--red-soft)] text-[var(--fg)] border-b border-[var(--border)]"
        >
          Location access is required to check in. Enable it in your phone settings, then reload.
        </div>
      )}
      {geo.permission === 'prompt' && (
        <div className="shrink-0 px-4 py-2 text-[12px] bg-[var(--surface-sunken)] text-[var(--fg-muted)] border-b border-[var(--border)] flex items-center justify-between gap-2">
          <span>Location is needed for check-in &amp; job navigation.</span>
          <button
            type="button"
            onClick={geo.requestPermission}
            className="px-3 py-1 rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--fg-on-accent)] text-[12px] font-semibold"
          >
            Grant
          </button>
        </div>
      )}

      {/* ─── active tab ──────────────────────────────────────────────────── */}
      {/* MapTab needs a fixed-height parent (absolute canvas inside).
          Other tabs scroll. Apply overflow only when not on map. */}
      <main
        className={cn('flex-1 min-h-0', tab === 'map' ? 'relative overflow-hidden' : 'overflow-y-auto')}
        data-active-tab={tab}
      >
        <Active />
      </main>

      {/* ─── bottom tab bar ──────────────────────────────────────────────── */}
      <nav
        className={cn(
          'shrink-0 grid grid-cols-5',
          'bg-[var(--bg-elevated)] border-t border-[var(--border)]',
        )}
        style={{
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        role="tablist"
        aria-label="Field tabs"
      >
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={t.label}
              onClick={() => changeTab(t.key)}
              className={cn(
                'flex flex-col items-center justify-center gap-1',
                'transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-none focus-visible:bg-[var(--surface-sunken)]',
                active
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
              style={{ minHeight: 56, paddingTop: 8, paddingBottom: 8 }}
            >
              <span className={cn('grid place-items-center', active ? '' : '')}>
                {t.icon}
              </span>
              <span className="text-[11px] font-semibold tracking-[var(--tracking-wide)] uppercase">
                {t.label}
              </span>
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute -mt-[44px] block size-1.5 rounded-[var(--radius-full)] bg-[var(--accent)]"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Hidden footer carrying network type for the Me tab to display. */}
      <span hidden data-network-type={networkType ?? ''} />
    </div>
  );
}
