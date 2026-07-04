// =============================================================================
// TenantsConsole — the tenants/account surface router.
// -----------------------------------------------------------------------------
// tenants.html mounts this. Billing lives under the same surface (the Stripe
// Checkout/Portal redirects land on /tenants.html?billing=…):
//   /tenants.html                    → Tenant Admin (default)
//   /tenants.html?view=billing       → Billing & Subscription
//   /tenants.html?billing=success|…  → Billing (post-checkout / portal return)
// =============================================================================

import { TenantAdmin } from './TenantAdmin';
import { BillingPanel } from '@crm/components/billing/BillingPanel';

export function TenantsConsole() {
  const p = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  if (p.get('view') === 'billing' || p.has('billing')) return <BillingPanel />;
  return <TenantAdmin />;
}
