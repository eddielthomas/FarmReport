// =============================================================================
// billing/subscriptions.mjs — account billing endpoints (self-serve Stripe).
// -----------------------------------------------------------------------------
//   GET  /billing/plans           public plan catalog (auth'd)
//   GET  /billing/subscription    the tenant's current subscription + status
//   GET  /billing/invoices        the tenant's invoices (mirrored from Stripe)
//   POST /billing/checkout        {plan_key} → hosted Stripe Checkout URL
//   POST /billing/portal          → hosted Stripe Customer Portal URL
// Reads: any authenticated tenant user. Mutations (checkout/portal): the tenant
// owner — gated on platform:admin OR the billing.manage permission.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, badReq, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { publicPlans, priceIdFor, PLANS } from './plans.mjs';
import { activePlanKeyFor, featuresForPlan, TIER_LABEL } from './entitlements.mjs';
import { getStripe, stripeConfigured, createCheckoutSession, createPortalSession } from './stripe.mjs';

function canManageBilling(req) {
  const roles = req.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  const perms = req.user?.permissions;
  return !!(perms && (perms.has('platform.admin.all') || perms.has('billing.manage')));
}
const notConfigured = (res) =>
  send(res, 503, { success: false, error: 'stripe_not_configured',
    detail: 'Set STRIPE_SECRET_KEY (and STRIPE_PRICE_* + STRIPE_WEBHOOK_SECRET) and run `npm install stripe`.' });

// GET /billing/plans
export async function plans(req, res) {
  ok(res, { configured: stripeConfigured(), plans: publicPlans() });
}

// GET /billing/subscription
export async function current(req, res) {
  const data = await withTenantConn(req, async (c) => {
    const sub = await c.query(
      `SELECT plan_key, status, quantity, current_period_start, current_period_end,
              cancel_at_period_end, canceled_at, trial_end, stripe_subscription_id
         FROM billing.subscription
        WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 1`, [req.tenant.id]);
    const cust = await c.query('SELECT stripe_customer_id, email FROM billing.customer WHERE tenant_id = $1', [req.tenant.id]);
    return { subscription: sub.rows[0] ?? null, customer: cust.rows[0] ?? null };
  });
  const active = data.subscription && ['active', 'trialing', 'past_due'].includes(data.subscription.status);
  ok(res, {
    configured: stripeConfigured(),
    hasCustomer: !!data.customer,
    subscription: data.subscription,
    activePlanKey: active ? data.subscription.plan_key : null,
    canManage: canManageBilling(req),
  });
}

// GET /billing/entitlements — the tenant's active plan + the feature keys it
// includes. The SPA loads this at session time to drive show/hide/upsell.
export async function entitlements(req, res) {
  const plan = await activePlanKeyFor(req);
  ok(res, { plan_key: plan, plan_label: TIER_LABEL[plan] ?? plan, features: featuresForPlan(plan) });
}

// GET /billing/invoices
export async function invoices(req, res) {
  const rows = await withTenantConn(req, async (c) => {
    const r = await c.query(
      `SELECT stripe_invoice_id, number, status, amount_due, amount_paid, currency,
              hosted_invoice_url, invoice_pdf, period_start, period_end, created_at
         FROM billing.invoice
        WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 100`, [req.tenant.id]);
    return r.rows;
  });
  ok(res, rows);
}

// POST /billing/checkout  {plan_key}
export async function checkout(req, res) {
  if (!canManageBilling(req)) return send(res, 403, { success: false, error: 'billing_admin_required' });
  if (!stripeConfigured()) return notConfigured(res);
  const stripe = await getStripe();
  if (!stripe) return notConfigured(res);

  const body = (await readBody(req)) || {};
  const planKey = String(body.plan_key ?? '').trim();
  const plan = PLANS.find((p) => p.key === planKey);
  if (!plan) return badReq(res, 'unknown_plan');
  if (plan.contactSales) return badReq(res, 'plan_requires_contact_sales');
  const priceId = priceIdFor(planKey);
  if (!priceId) return send(res, 503, { success: false, error: 'plan_price_not_configured', detail: `Set ${plan.priceEnv}` });

  try {
    const session = await createCheckoutSession(req, stripe, { priceId, planKey });
    recordAudit({ req, action: 'billing.checkout.start', resource: 'billing.subscription', resourceId: null, payload: { plan_key: planKey } });
    ok(res, { url: session.url, id: session.id });
  } catch (err) {
    console.error('[billing] checkout error:', err?.message ?? err);
    send(res, 502, { success: false, error: 'stripe_error', detail: String(err?.message ?? err) });
  }
}

// POST /billing/portal
export async function portal(req, res) {
  if (!canManageBilling(req)) return send(res, 403, { success: false, error: 'billing_admin_required' });
  if (!stripeConfigured()) return notConfigured(res);
  const stripe = await getStripe();
  if (!stripe) return notConfigured(res);
  try {
    const session = await createPortalSession(req, stripe);
    recordAudit({ req, action: 'billing.portal.open', resource: 'billing.customer', resourceId: null, payload: {} });
    ok(res, { url: session.url });
  } catch (err) {
    console.error('[billing] portal error:', err?.message ?? err);
    send(res, 502, { success: false, error: 'stripe_error', detail: String(err?.message ?? err) });
  }
}
