// =============================================================================
// orgs.ts — Sprint A5.1 (ADR-0024) org-tier client helpers.
// -----------------------------------------------------------------------------
// Minimal but real path for the org hierarchy: list "my districts under <org>"
// and switch the active district (re-mints the JWT with the new tenant_id).
// The full grouped switcher UI is deferred polish; these helpers + the
// tenant-store action below are enough to drive a small dropdown in the shell.
// =============================================================================

import { api } from './api';
import { useAuthStore } from './auth-store';
import { useTenantStore } from './tenant-store';
import type { MyOrg, User } from './types';

// GET /iam/my-orgs — cross-tenant; returns the caller's orgs + the districts
// (tenants) they can act in. Skip the X-Tenant-Id header (cross-tenant route).
export async function fetchMyOrgs(): Promise<MyOrg[]> {
  const data = await api<{ orgs: MyOrg[] }>('/iam/my-orgs', { skipTenant: true });
  return data.orgs ?? [];
}

// POST /auth/switch-tenant { tenant_slug } — re-mints the JWT for a different
// district the caller belongs to, then updates the auth + tenant stores so the
// rest of the app (every X-Tenant-Id header + bearer token) follows. Throws
// (ApiError 403) when the caller is not a member of the target district.
export async function switchTenant(tenantSlug: string): Promise<User> {
  const data = await api<{ token: string; user: User }>('/auth/switch-tenant', {
    method: 'POST',
    body: { tenant_slug: tenantSlug } as unknown as BodyInit,
    skipTenant: true,
  });
  // Update auth (new token + user, incl. the org claim) and the active tenant.
  useAuthStore.getState().setSession(data.token, data.user);
  useTenantStore
    .getState()
    .setTenant(data.user.tenant_id, data.user.tenant_slug ?? tenantSlug, data.user.display_name);
  return data.user;
}
