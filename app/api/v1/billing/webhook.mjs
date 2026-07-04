// =============================================================================
// billing/webhook.mjs — Stripe webhook receiver (public, signature-verified).
// -----------------------------------------------------------------------------
// POST /api/v1/billing/webhook. MUST be in the public allowlist (no auth/tenant)
// and MUST read the RAW request body (Stripe signs the exact bytes). Verifies
// the signature with STRIPE_WEBHOOK_SECRET, dedupes on stripe_event_id, and
// mirrors subscription/invoice changes into billing.* via the platform pool.
//
// Handled events:
//   checkout.session.completed            → sync the new subscription
//   customer.subscription.created/updated/deleted → sync subscription
//   invoice.paid / invoice.payment_failed / invoice.finalized → sync invoice
// =============================================================================

import { q } from '../db/pool.mjs';
import { send } from '../http.mjs';
import { getStripe } from './stripe.mjs';
import { syncSubscription, syncInvoice } from './stripe.mjs';

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = await getStripe();
  if (!stripe || !secret) {
    return send(res, 503, { success: false, error: 'stripe_not_configured' });
  }

  let raw;
  try { raw = await readRaw(req); }
  catch { return send(res, 413, { success: false, error: 'payload_too_large' }); }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.warn('[billing] webhook signature verify failed:', err?.message ?? err);
    return send(res, 400, { success: false, error: 'invalid_signature' });
  }

  // Idempotency: record the event id; if it already existed, ack and skip.
  const ins = await q(
    `INSERT INTO billing.webhook_event (stripe_event_id, type)
     VALUES ($1, $2) ON CONFLICT (stripe_event_id) DO NOTHING RETURNING stripe_event_id`,
    [event.id, event.type]);
  if (ins.rows.length === 0) {
    return send(res, 200, { success: true, data: { deduped: true } });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          if (!sub.metadata?.tenant_id && s.metadata?.tenant_id) sub.metadata = { ...sub.metadata, ...s.metadata };
          await syncSubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(event.data.object);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.finalized':
      case 'invoice.updated':
        await syncInvoice(event.data.object);
        break;
      default:
        // Unhandled event types are acked (Stripe sends many); no-op.
        break;
    }
    await q('UPDATE billing.webhook_event SET handled = TRUE WHERE stripe_event_id = $1', [event.id]);
    return send(res, 200, { success: true, data: { received: true, type: event.type } });
  } catch (err) {
    console.error('[billing] webhook handler error for', event.type, ':', err?.message ?? err);
    await q('UPDATE billing.webhook_event SET error = $2 WHERE stripe_event_id = $1',
      [event.id, String(err?.message ?? err)]).catch(() => {});
    // 500 so Stripe retries.
    return send(res, 500, { success: false, error: 'webhook_handler_error' });
  }
}
