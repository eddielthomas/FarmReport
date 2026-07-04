// =============================================================================
// MeTab — profile + diagnostics (S9B).
// -----------------------------------------------------------------------------
// Shows the tech's identity, current GPS readout, accuracy, battery level,
// network type, app version, and a Sign out button.
// =============================================================================

import * as React from 'react';
import { useAuthStore } from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';
import { useGeolocation } from '@crm/lib/useGeolocation';
import { disconnectFieldSocket } from '@crm/lib/field-socket';
import { cn } from '@crm/lib/utils';
import { LogOut, MapPin, Wifi, Battery, Building2, BadgeCheck } from 'lucide-react';

export function MeTab() {
  const user   = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clear);
  const tenantName = useTenantStore((s) => s.currentTenantName);
  const tenantSlug = useTenantStore((s) => s.currentTenantSlug);
  const clearTenant = useTenantStore((s) => s.clear);

  const { fix, permission } = useGeolocation();

  const [battery, setBattery] = React.useState<{ level: number; charging: boolean } | null>(null);
  React.useEffect(() => {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        level: number; charging: boolean;
        addEventListener: (e: string, cb: () => void) => void;
      }>;
    };
    if (typeof nav.getBattery !== 'function') return;
    nav.getBattery().then((b) => {
      const sync = () => setBattery({ level: b.level, charging: b.charging });
      sync();
      b.addEventListener('levelchange', sync);
      b.addEventListener('chargingchange', sync);
    }).catch(() => { /* unsupported */ });
  }, []);

  const networkType = React.useMemo(() => {
    const c = (navigator as Navigator & {
      connection?: { effectiveType?: string; downlink?: number };
    }).connection;
    return c?.effectiveType ?? null;
  }, []);

  const initials = (user?.display_name ?? user?.email ?? '?').trim().charAt(0).toUpperCase();

  const signOut = () => {
    try { disconnectFieldSocket(); } catch { /* ignore */ }
    clearAuth();
    clearTenant();
    window.location.replace('/login.html');
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] px-4 py-4 space-y-4">
      {/* Identity */}
      <section className="rounded-[var(--radius-2xl)] bg-[var(--surface)] border border-[var(--border)] p-4 flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid place-items-center size-14 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] text-[20px] font-semibold"
        >
          {initials}
        </span>
        <div className="min-w-0">
          <div className="text-[16px] font-semibold truncate">{user?.display_name ?? '—'}</div>
          <div className="text-[12px] text-[var(--fg-muted)] truncate">{user?.email ?? '—'}</div>
          {(user?.roles ?? []).length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {(user?.roles ?? []).slice(0, 3).map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[var(--tracking-wider)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] text-[var(--fg-muted)]"
                >
                  <BadgeCheck className="size-3" />{r}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Tenant */}
      <Row
        icon={<Building2 className="size-4 text-[var(--fg-muted)]" />}
        label="Tenant"
        value={`${tenantName ?? tenantSlug ?? 'unknown'}${tenantSlug ? ` · ${tenantSlug}` : ''}`}
      />

      {/* GPS */}
      <Row
        icon={<MapPin className="size-4 text-[var(--fg-muted)]" />}
        label="Location"
        value={
          fix
            ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (±${Math.round(fix.accuracy_m)} m)`
            : permission === 'denied'
              ? 'denied — open Settings'
              : 'acquiring…'
        }
        mono
      />

      {/* Network */}
      <Row
        icon={<Wifi className="size-4 text-[var(--fg-muted)]" />}
        label="Network"
        value={networkType ? networkType.toUpperCase() : 'unknown'}
      />

      {/* Battery */}
      <Row
        icon={<Battery className="size-4 text-[var(--fg-muted)]" />}
        label="Battery"
        value={
          battery
            ? `${Math.round(battery.level * 100)}%${battery.charging ? ' · charging' : ''}`
            : 'unavailable'
        }
      />

      {/* Build */}
      <Row
        icon={<BadgeCheck className="size-4 text-[var(--fg-muted)]" />}
        label="Build"
        value={`Field PWA v1.0.0 · S9B`}
        mono
      />

      <button
        type="button"
        onClick={signOut}
        className={cn(
          'mt-4 w-full inline-flex items-center justify-center gap-2',
          'py-3 rounded-[var(--radius-lg)]',
          'bg-[var(--red)] text-[var(--fg-inverted)] font-semibold',
        )}
        style={{ minHeight: 52 }}
      >
        <LogOut className="size-5" />
        Sign out
      </button>
    </div>
  );
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}
function Row({ icon, label, value, mono }: RowProps) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--surface)] border border-[var(--border)] p-3 flex items-start gap-3">
      <span className="mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">{label}</div>
        <div className={cn('text-[14px] text-[var(--fg)] break-words', mono && 'font-mono')}>
          {value}
        </div>
      </div>
    </div>
  );
}
