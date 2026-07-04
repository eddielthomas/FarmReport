import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TopNav } from './components/shell/TopNav';
import { StatusBar } from './components/shell/StatusBar';
import { useAuthStore, primarySurfaceForRoles } from './lib/auth-store';
import { useTenantStore } from './lib/tenant-store';
import { useSurfaceMode } from './lib/surface-store';

import { SalesManager } from './pages/SalesManager';
import { ProjectManager } from './pages/ProjectManager';
import { AnalyticsManager } from './pages/AnalyticsManager';
import { TenantsConsole } from './pages/TenantsConsole';
import { StaffAdmin } from './pages/StaffAdmin';
import { OperationsDashboard } from './pages/OperationsDashboard';
import { CustomerConsole } from './pages/CustomerConsole';
import { VendorPortal } from './pages/VendorPortal';
import { FarmConsole } from './pages/farm/FarmConsole';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

export type Page =
  | 'sales' | 'pm' | 'analytics' | 'tenants'
  | 'staff' | 'operations' | 'customer' | 'vendor';

interface PageDef {
  component: React.FC;
  title: string;
  /** Roles that may view this page. Empty array = open to anyone authenticated. */
  roles: string[];
}

const PAGES: Record<Page, PageDef> = {
  sales:      { component: SalesManager,        title: 'Sales Manager',        roles: ['sales:manage'] },
  pm:         { component: ProjectManager,      title: 'Project Manager',      roles: ['ops:manage'] },
  analytics:  { component: AnalyticsManager,    title: 'Analytics Manager',    roles: ['analytics:view'] },
  tenants:    { component: TenantsConsole,      title: 'Tenant Admin',         roles: ['platform:admin'] },
  staff:      { component: StaffAdmin,          title: 'Staff & Teams',        roles: ['platform:admin'] },
  operations: { component: FarmConsole,         title: 'Portfolio Dashboard',  roles: ['ops:manage', 'farm:view', 'farm.portfolio.view'] },
  customer:   { component: CustomerConsole,     title: 'Customer Portal',      roles: ['customer:view'] },
  vendor:     { component: VendorPortal,        title: 'Vendor Portal',        roles: ['vendor:view'] },
};

export function App({ page }: { page: Page }) {
  // S7A — Surface-mode hook MUST run before children render so the
  // `data-surface` attribute is on `<html>` and `.crm` before any token cascade
  // is read by descendants.
  useSurfaceMode();

  const token = useAuthStore((s) => s.token);
  const user  = useAuthStore((s) => s.user);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [ready, setReady] = useState(false);

  // Authorization gate: enforce login + role-based routing.
  // (0) S10B — no access-code pass cookie → bounce to /access.html first.
  //     The pass cookie marks "human on the other side" but does NOT replace
  //     auth — login is still required below. Marketing pages bypass this
  //     check entirely (they never mount the CRM App).
  // (1) No token or no user → redirect to /login.html
  // (2) Logged in but lacks the role this surface requires → redirect to the
  //     primary surface their roles allow (no silent re-login as another user).
  useEffect(() => {
    const def = PAGES[page];
    const here = window.location.pathname + window.location.search;

    // The pilot access-code gate is a production concern (enforced server-side
    // by api/server.mjs). In local `vite dev` it is bypassed so development
    // isn't blocked behind the passcode — matches the ungated dev server.
    const hasAccessPass = import.meta.env.DEV || document.cookie
      .split(';')
      .some((c) => c.trim().startsWith('rwr.access_pass='));
    if (!hasAccessPass) {
      window.location.replace(`/access.html?next=${encodeURIComponent(here)}`);
      return;
    }

    // Genuinely unauthenticated → login.
    if (!token || !user) {
      window.location.replace(`/login.html?next=${encodeURIComponent(here)}`);
      return;
    }

    // Authenticated, but the persisted tenant store is empty — e.g. a cross-tab
    // login, a desynced `rwr.tenant`, or arriving via login.html's
    // "already-authenticated" early redirect (which does NOT set the tenant).
    // The token's tenant_id is authoritative, so hydrate from it rather than
    // bouncing to /login — which would LOOP, since login.html sees the token
    // and bounces straight back to the surface (login ⇄ surface redirect loop).
    let tenantId = currentTenantId;
    if (!tenantId && user.tenant_id) {
      useTenantStore.getState().setTenant(
        user.tenant_id,
        user.tenant_slug ?? user.tenant_id,
        user.tenant_slug ?? undefined,
      );
      tenantId = user.tenant_id;
    }
    if (!tenantId) {
      window.location.replace(`/login.html?next=${encodeURIComponent(here)}`);
      return;
    }

    const userRoles = user.roles ?? [];
    const isAdmin = userRoles.includes('platform:admin');
    const isVendor = userRoles.some((r) => r.startsWith('vendor:'));

    // Sprint 6B P-009 Phase 4: vendor isolation. Any user holding a `vendor:*`
    // role must land on `vendor.html` and CANNOT resolve any non-vendor surface.
    // platform:admin is exempt (admins manage vendors and may also need to
    // inspect other surfaces). The server-side route in api/server.mjs is the
    // final gate; this is the UX-level redirect to avoid a flash of 403.
    if (isVendor && !isAdmin && page !== 'vendor') {
      if (!window.location.pathname.endsWith('/vendor.html')) {
        window.location.replace('/vendor.html');
        return;
      }
    }

    const allowed = def.roles.length === 0 || isAdmin || def.roles.some((r) => userRoles.includes(r));

    if (!allowed) {
      const surface = primarySurfaceForRoles(userRoles);
      // Avoid redirect loops if the resolved surface is the same broken page.
      if (!window.location.pathname.endsWith(`/${surface}`)) {
        window.location.replace(`/${surface}`);
        return;
      }
    }
    setReady(true);
  }, [token, user, currentTenantId, page]);

  // Listen for tenant changes from the switcher → invalidate all queries.
  useEffect(() => {
    const onChange = () => queryClient.invalidateQueries();
    window.addEventListener('rwr.tenant-changed', onChange);
    return () => window.removeEventListener('rwr.tenant-changed', onChange);
  }, []);

  const def = PAGES[page];
  const Active = def.component;

  // The customer surface is a full-bleed map console with its own top bar —
  // render it without the CRM TopNav/StatusBar chrome.
  const bare = page === 'customer';

  if (bare) {
    return (
      <QueryClientProvider client={queryClient}>
        <div className="crm relative h-screen w-screen overflow-hidden">
          {!ready ? (
            <div className="h-full flex items-center justify-center text-label">
              <span className="animate-pulse">VERIFYING SESSION…</span>
            </div>
          ) : (
            <Active />
          )}
        </div>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="crm flex flex-col h-screen w-screen overflow-hidden">
        <TopNav active={page} />
        <main className="flex-1 overflow-hidden">
          {!ready ? (
            <div className="h-full flex items-center justify-center text-label">
              <span className="animate-pulse">VERIFYING SESSION…</span>
            </div>
          ) : (
            <Active />
          )}
        </main>
        <StatusBar status={def.title.toUpperCase()} />
      </div>
    </QueryClientProvider>
  );
}
