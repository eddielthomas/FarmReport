// =============================================================================
// TopNav — top app shell (S7C re-skin)
// -----------------------------------------------------------------------------
// Concept layout:
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │  [Mark] RWR · COMMAND   [PillTabs cross-surface]   [θ] [tenant] [me] │
//   └──────────────────────────────────────────────────────────────────────┘
// Cross-surface links render via PillTabs styling. Tenant switcher + sign-out
// + surface-mode toggle live in the right cluster. BrandMark is the logo.
// =============================================================================

import { useAuthStore, allowedSurfacesForRoles } from '@crm/lib/auth-store';
import { useTenantStore } from '@crm/lib/tenant-store';
import { disconnectFieldSocket } from '@crm/lib/field-socket';
import { TenantSwitcher } from './TenantSwitcher';
import { DistrictSwitcher } from './DistrictSwitcher';
import { cn } from '@crm/lib/utils';
import { BrandMark } from '@crm/components/ui/brand-mark';
import { SurfaceModeToggle } from '@crm/components/ui/surface-mode-toggle';
import {
  Globe2, Users2, ClipboardCheck, BarChart3, Building,
  UserCog, LayoutDashboard, Headset, LogOut, Truck,
} from 'lucide-react';

interface NavLink {
  href: string;
  label: string;
  icon: React.ReactNode;
  key: string;
  /** The HTML entry filename this link points at — matched against
   *  `allowedSurfacesForRoles()` (Sprint 12 single source of truth). */
  surface: string;
}

// Sprint 12 — link visibility is now driven by the canonical
// allowedSurfacesForRoles() allow-list, NOT by per-link role lists. This
// ensures the nav, the post-login redirect, and the inline role-gate stay in
// lockstep — change the allow-list in auth-store.ts and every UX surface
// updates together.
// NOTE: the legacy '/dashboard.html' "Map" surface (RWR water-distribution
// concept map) is intentionally NOT in the farm nav — the farm map experience
// lives in Portfolio (operations) + Farm Detail. dashboard.html is a legacy
// file pending removal.
const LINKS: NavLink[] = [
  { href: '/operations.html', label: 'Portfolio',  icon: <LayoutDashboard className="size-3.5" />, key: 'operations', surface: 'operations.html' },
  { href: '/sales.html',      label: 'Buyers',     icon: <Users2 className="size-3.5" />,         key: 'sales',      surface: 'sales.html' },
  { href: '/pm.html',         label: 'Programs',   icon: <ClipboardCheck className="size-3.5" />, key: 'pm',         surface: 'pm.html' },
  { href: '/analytics.html',  label: 'Analytics',  icon: <BarChart3 className="size-3.5" />,      key: 'analytics',  surface: 'analytics.html' },
  { href: '/staff.html',      label: 'Staff',      icon: <UserCog className="size-3.5" />,        key: 'staff',      surface: 'staff.html' },
  { href: '/tenants.html',    label: 'Tenants',    icon: <Building className="size-3.5" />,       key: 'tenants',    surface: 'tenants.html' },
  { href: '/customer.html',   label: 'Growers',    icon: <Headset className="size-3.5" />,        key: 'customer',   surface: 'customer.html' },
  { href: '/vendor.html',     label: 'Suppliers',  icon: <Truck className="size-3.5" />,          key: 'vendor',     surface: 'vendor.html' },
];

function VisibleLinks() {
  const userRoles = useAuthStore((s) => s.user?.roles) ?? [];
  const allowed = allowedSurfacesForRoles(userRoles);
  return LINKS.filter((l) => allowed.has(l.surface));
}

export function TopNav({ active }: { active: string }) {
  const { user, clear } = useAuthStore();
  const clearTenant = useTenantStore((s) => s.clear);
  const links = VisibleLinks();

  function signOut() {
    // Sprint 9.1 — sign-out reliability fix. Three-phase:
    //   1) Tear down any live socket.io connections so the server stops
    //      pushing field/chat envelopes against a stale token.
    //   2) Clear the zustand stores AND purge the persist-backed
    //      localStorage keys so a same-tab navigation cannot re-hydrate.
    //   3) Hard navigate via window.location.replace so the back button
    //      cannot return the user to the authenticated surface.
    //
    // The user's UI preference (rwr.surface-mode) is intentionally preserved
    // so light/dark mode survives the logout.
    try { disconnectFieldSocket(); } catch { /* ignore */ }
    try { clear(); } catch { /* ignore */ }
    try { clearTenant(); } catch { /* ignore */ }
    try {
      window.localStorage.removeItem('rwr.auth');
      window.localStorage.removeItem('rwr.tenant');
    } catch { /* ignore */ }
    window.location.replace('/login.html');
  }

  return (
    <nav
      className={cn(
        'h-14 flex items-center justify-between px-3 sm:px-4',
        'border-b border-[var(--border)] bg-[var(--bg-elevated)]',
        'text-[var(--fg)] z-50 gap-2',
      )}
      role="navigation"
      aria-label="Primary"
    >
      {/* ---- LEFT — brand + cross-surface tabs ---------------------------- */}
      <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
        <a
          href="/"
          className="flex items-center gap-2 shrink-0 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] rounded-[var(--radius-md)]"
          aria-label="Report.Farm home"
        >
          <BrandMark size={28} />
          <span className="hidden sm:flex flex-col leading-none">
            <span className="text-[12px] font-semibold tracking-[var(--tracking-tight)] text-[var(--fg)]">
              Report.Farm
            </span>
            <span className="text-[9px] tracking-[var(--tracking-widest)] uppercase text-[var(--fg-muted)]">
              Mission Control
            </span>
          </span>
        </a>

        <div className="hidden sm:block h-6 w-px bg-[var(--border)]" />

        <div
          role="tablist"
          aria-label="Surfaces"
          className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0"
        >
          {links.map((l) => {
            const isActive = active === l.key;
            return (
              <a
                key={l.key}
                href={l.href}
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                title={l.label}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-full)]',
                  'text-[12px] font-medium whitespace-nowrap',
                  'transition-colors duration-[var(--duration-fast)] ease-[var(--easing-standard)]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
                  isActive
                    ? 'bg-[var(--fg)] text-[var(--fg-inverted)] shadow-[var(--shadow-card)] focus-visible:ring-[var(--ring)]'
                    : 'bg-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-sunken)] focus-visible:ring-[var(--ring)]',
                )}
              >
                {l.icon}
                <span className="hidden md:inline">{l.label}</span>
              </a>
            );
          })}
        </div>
      </div>

      {/* ---- RIGHT — surface toggle · tenant switcher · user chip --------- */}
      <div className="flex items-center gap-2 shrink-0">
        <SurfaceModeToggle compact />
        {/* Sprint A5.1 — district switcher renders only when the user carries
            an org claim (parent-org tenant); standalone tenants are unaffected. */}
        <DistrictSwitcher />
        {(user?.roles ?? []).includes('platform:admin') && <TenantSwitcher />}
        {user && (
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <span className="text-[12px] font-medium text-[var(--fg)]">
                {user.display_name ?? user.email}
              </span>
              <span className="text-[9px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                {(user.roles ?? []).slice(0, 2).join(' · ') || 'no role'}
              </span>
            </div>
            <div
              aria-hidden="true"
              className={cn(
                'size-9 rounded-[var(--radius-full)]',
                'bg-[var(--accent)] text-[var(--fg-on-accent)]',
                'flex items-center justify-center text-[13px] font-semibold',
                'border border-[var(--border)] shadow-[var(--shadow-soft)]',
              )}
            >
              {user.email.charAt(0).toUpperCase()}
            </div>
            <button
              type="button"
              onClick={signOut}
              aria-label="Sign out"
              title="Sign out"
              className={cn(
                'inline-flex items-center justify-center size-9 rounded-[var(--radius-full)]',
                'border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)]',
                'hover:bg-[var(--surface-sunken)] hover:text-[var(--red)]',
                'transition-colors duration-[var(--duration-fast)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]',
              )}
            >
              <LogOut className="size-4" />
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
