import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MyOrg } from './types';

interface TenantState {
  /** UUID or slug of the active tenant. Sent as X-Tenant-Id on every request. */
  currentTenantId: string | null;
  currentTenantSlug: string | null;
  currentTenantName: string | null;
  /**
   * Sprint A5.1 (ADR-0024) — the caller's orgs and, per org, the districts
   * (tenants) they can act in. Populated by loadMyOrgs() (GET /iam/my-orgs).
   * Empty for standalone tenants (org_id IS NULL) — the switcher stays hidden.
   */
  myOrgs: MyOrg[];
  setTenant: (id: string, slug: string, name?: string) => void;
  setMyOrgs: (orgs: MyOrg[]) => void;
  clear: () => void;
}

export const useTenantStore = create<TenantState>()(
  persist(
    (set) => ({
      currentTenantId: null,
      currentTenantSlug: null,
      currentTenantName: null,
      myOrgs: [],
      setTenant: (id, slug, name) =>
        set({ currentTenantId: id, currentTenantSlug: slug, currentTenantName: name ?? null }),
      setMyOrgs: (orgs) => set({ myOrgs: orgs }),
      clear: () => set({ currentTenantId: null, currentTenantSlug: null, currentTenantName: null, myOrgs: [] }),
    }),
    {
      name: 'rwr.tenant',
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name);
          return raw ? JSON.parse(raw) : null;
        },
        setItem: (name, value) => localStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
);

// Load the caller's orgs + districts into the store (idempotent). Lives here
// (not in the store body) to avoid importing the api client into the store
// module — keeps the store dependency-light. Safe no-op on failure.
export async function loadMyOrgs(): Promise<void> {
  try {
    const { fetchMyOrgs } = await import('./orgs');
    const orgs = await fetchMyOrgs();
    useTenantStore.getState().setMyOrgs(orgs);
  } catch {
    /* org tier unavailable (standalone tenant / pre-A5.1) — leave myOrgs empty */
  }
}
