// =============================================================================
// billing/stripe.mjs — Stripe client + core billing operations.
// -----------------------------------------------------------------------------
// The Stripe SDK is imported lazily so the app boots fine WITHOUT keys (billing
// endpoints then return a clear 503 'stripe_not_configured' instead of crashing).
// Requires: `npm install stripe`, and env STRIPE_SECRET_KEY (sk_test_… / sk_live_…).
// Optional: STRIPE_WEBHOOK_SECRET (whsec_…), BILLING_SUCCESS_URL / BILLING_CANCEL_URL.
//
// Stripe is the source of truth; syncSubscription / syncInvoice mirror the
// objects we render into billing.* so the UI needs no live round-trip.
// =============================================================================

import { withTenantConn, q } from '../db/pool.mjs';
import { planKeyForPrice } from './plans.mjs';

let _stripe = null;
let _loadErr = null;

/** Lazily construct the Stripe client. Returns null if unconfigured/unavailable. */
export async function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const { default: Stripe } = await import('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    return _stripe;
  } catch (err) {
    _loadErr = err;
    console.error('[billing] stripe SDK not installed — run `npm install stripe`:', err?.message ?? err);
    return null;
  }
}

export function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

const APP_ORIGIN = () => process.env.APP_ORIGIN || 'http://localhost:5275';
const toDate = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

// ---- customer ---------------------------------------------------------------
// Ensure a Stripe Customer exists for this tenant; upsert billing.customer.
export async function ensureCustomer(req, stripe) {
  const tenantId = req.tenant.id;
  const existing = await withTenantConn(req, async (c) => {
    const r = await c.query('SELECT stripe_customer_id FROM billing.customer WHERE tenant_id = $1', [tenantId]);
    return r.rows[0]?.stripe_customer_id ?? null;
  });
  if (existing) return existing;

  const email = req.user?.email ?? null;
  const cust = await stripe.customers.create({
    email: email ?? undefined,
    name: req.tenant.slug ?? undefined,
    metadata: { tenant_id: tenantId, tenant_slug: req.tenant.slug ?? '' },
  });
  await withTenantConn(req, async (c) => {
    await c.query(
      `INSERT INTO billing.customer (tenant_id, stripe_customer_id, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()`,
      [tenantId, cust.id, email]);
  });
  return cust.id;
}

// ---- checkout / portal ------------------------------------------------------
export async function createCheckoutSession(req, stripe, { priceId, planKey }) {
  const customerId = await ensureCustomer(req, stripe);
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: (process.env.BILLING_SUCCESS_URL || `${APP_ORIGIN()}/tenants.html?billing=success&session_id={CHECKOUT_SESSION_ID}`),
    cancel_url: (process.env.BILLING_CANCEL_URL || `${APP_ORIGIN()}/tenants.html?billing=cancelled`),
    subscription_data: { metadata: { tenant_id: req.tenant.id, plan_key: planKey } },
    metadata: { tenant_id: req.tenant.id, plan_key: planKey },
  });
}

export async function createPortalSession(req, stripe) {
  const customerId = await ensureCustomer(req, stripe);
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_ORIGIN()}/tenants.html?billing=portal`,
  });
}

// ---- sync (mirror Stripe → billing.*) --------------------------------------
// Resolve the tenant a Stripe customer belongs to (used by the webhook, which
// has no tenant session — runs via the platform pool `q`, bypassing RLS).
async function tenantForCustomer(customerId) {
  const r = await q('SELECT tenant_id FROM billing.customer WHERE stripe_customer_id = $1', [customerId]);
  return r.rows[0]?.tenant_id ?? null;
}

export async function syncSubscription(sub) {
  const tenantId = sub.metadata?.tenant_id || await tenantForCustomer(sub.customer);
  if (!tenantId) return;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const planKey = sub.metadata?.plan_key || planKeyForPrice(priceId);
  await q(
    `INSERT INTO billing.subscription
       (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan_key,
        status, quantity, current_period_start, current_period_end, cancel_at_period_end,
        canceled_at, trial_end, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       stripe_price_id = EXCLUDED.stripe_price_id, plan_key = EXCLUDED.plan_key,
       status = EXCLUDED.status, quantity = EXCLUDED.quantity,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       canceled_at = EXCLUDED.canceled_at, trial_end = EXCLUDED.trial_end, updated_at = now()`,
    [tenantId, sub.customer, sub.id, priceId, planKey, sub.status,
     sub.items?.data?.[0]?.quantity ?? 1,
     toDate(sub.current_period_start), toDate(sub.current_period_end),
     !!sub.cancel_at_period_end, toDate(sub.canceled_at), toDate(sub.trial_end),
     JSON.stringify(sub.metadata ?? {})]);
}

export async function syncInvoice(inv) {
  const tenantId = inv.metadata?.tenant_id || await tenantForCustomer(inv.customer);
  if (!tenantId) return;
  await q(
    `INSERT INTO billing.invoice
       (tenant_id, stripe_invoice_id, stripe_customer_id, number, status,
        amount_due, amount_paid, currency, hosted_invoice_url, invoice_pdf,
        period_start, period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (stripe_invoice_id) DO UPDATE SET
       status = EXCLUDED.status, amount_due = EXCLUDED.amount_due,
       amount_paid = EXCLUDED.amount_paid, hosted_invoice_url = EXCLUDED.hosted_invoice_url,
       invoice_pdf = EXCLUDED.invoice_pdf`,
    [tenantId, inv.id, inv.customer, inv.number, inv.status,
     inv.amount_due, inv.amount_paid, inv.currency,
     inv.hosted_invoice_url, inv.invoice_pdf,
     toDate(inv.period_start), toDate(inv.period_end)]);
}
