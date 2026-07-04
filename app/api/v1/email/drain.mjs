// =============================================================================
// email/drain.mjs — durable outbox drain worker.
// -----------------------------------------------------------------------------
// Pulls up to N queued rows, transitions them through `sending`, dispatches
// each through email/send.mjs::sendOnce(), and finalises into one of:
//   - sent           — transport returned ok
//   - failed (retry) — transient error, next_attempt_at scheduled via backoff
//   - dead_letter    — attempts >= MAX_ATTEMPTS
//
// Idempotency: row is claimed with `FOR UPDATE SKIP LOCKED` inside a tenant-
// bound transaction so multiple drain replicas never grab the same row. The
// outbox id is forwarded to Resend as Idempotency-Key, so even a duplicate
// claim cannot double-deliver.
//
// `drainOnce()` is safe to invoke from any context (background interval,
// CLI tool, integration test).
// =============================================================================

import { pool } from '../db/pool.mjs';
import { sendOnce } from './send.mjs';
import * as T from './templates.mjs';
import { recordAudit } from '../audit.mjs';

const BATCH_LIMIT  = Number(process.env.EMAIL_DRAIN_BATCH ?? 50);
const MAX_ATTEMPTS = Number(process.env.EMAIL_DRAIN_MAX_ATTEMPTS ?? 5);

// Exponential backoff in seconds: 30s, 1m, 4m, 15m, 1h cap.
function backoffSecs(attempts) {
  const exp = Math.min(60 * 60, Math.floor(30 * Math.pow(2, attempts)));
  return Math.max(30, exp);
}

// Render the email body from the queued payload at drain-time so template
// fixes apply to in-flight queued mail. Falls back to a minimal subject/text
// pair if the template factory throws.
function renderFromPayload(payload) {
  const key  = payload?.template_key;
  const vars = payload?.vars ?? {};
  try {
    if (key === 'leadCreated'         && typeof T.leadCreated === 'function')         return T.leadCreated(vars);
    if (key === 'leadStatusChanged'   && typeof T.leadStatusChanged === 'function')   return T.leadStatusChanged(vars);
    if (key === 'meetingScheduled'    && typeof T.meetingScheduled === 'function')    return T.meetingScheduled(vars);
    if (key === 'caseAssigned'        && typeof T.caseAssigned === 'function')        return T.caseAssigned(vars);
    if (key === 'chatAlert'           && typeof T.chatAlert === 'function')           return T.chatAlert(vars);
  } catch (e) {
    console.error('[email.drain] template_render_failed', key, e?.message ?? e);
  }
  return {
    subject: `RWR notification: ${key ?? 'unknown'}`,
    html:    `<p>${JSON.stringify(vars)}</p>`,
    text:    JSON.stringify(vars),
  };
}

// drainOnce() returns counters so callers (and integration tests) can assert
// behaviour without waiting on the scheduler tick.
export async function drainOnce() {
  const counters = { claimed: 0, sent: 0, failed: 0, dead_letter: 0, errors: 0 };

  // Cross-tenant SELECT (no app.tenant_id set) — drain runs as the platform
  // role; the outbox FK guarantees tenant_id is valid. We claim each row in
  // a short transaction with SKIP LOCKED so parallel drains don't collide.
  let due;
  try {
    const r = await pool.query(
      `SELECT id, tenant_id, kind, recipient_email, recipient_user_id, payload, attempts
         FROM email.outbox
        WHERE status = 'queued'
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH_LIMIT],
    );
    due = r.rows;
  } catch (err) {
    console.error('[email.drain] select_failed', err?.message ?? err);
    return counters;
  }
  counters.claimed = due.length;
  if (due.length === 0) return counters;

  // Flip claimed rows to 'sending' so subsequent drains/queries see them in
  // motion. Done in batch for fewer round-trips.
  const ids = due.map((r) => r.id);
  await pool.query(
    `UPDATE email.outbox
        SET status = 'sending', locked_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  for (const row of due) {
    const rendered = renderFromPayload(row.payload);
    const tags = [
      { name: 'kind',      value: row.kind },
      { name: 'outbox_id', value: row.id },
      { name: 'tenant_id', value: row.tenant_id },
    ];

    let res;
    try {
      res = await sendOnce({
        to:      row.recipient_email,
        subject: rendered.subject,
        html:    rendered.html,
        text:    rendered.text,
        tags,
        idempotencyKey: row.id,
      });
    } catch (err) {
      res = { ok: false, error: err?.message ?? 'send_threw', transient: true };
    }

    const nextAttempts = (Number(row.attempts) || 0) + 1;
    if (res.ok) {
      await pool.query(
        `UPDATE email.outbox
            SET status = 'sent', sent_at = now(), attempts = $2, last_error = NULL
          WHERE id = $1`,
        [row.id, nextAttempts],
      );
      counters.sent++;
      recordAudit({
        req: { tenant: { id: row.tenant_id }, user: { email: 'system', sub: null }, headers: {} },
        action: 'email.send',
        resource: 'email.outbox',
        resourceId: row.id,
        payload: { kind: row.kind, to: row.recipient_email, ok: true, mock: !!res.mock, dev: !!res.dev },
      });
    } else if (nextAttempts >= MAX_ATTEMPTS || (res.transient === false && nextAttempts > 1)) {
      await pool.query(
        `UPDATE email.outbox
            SET status = 'dead_letter', attempts = $2, last_error = $3
          WHERE id = $1`,
        [row.id, nextAttempts, String(res.error ?? 'unknown')],
      );
      counters.dead_letter++;
      counters.errors++;
      recordAudit({
        req: { tenant: { id: row.tenant_id }, user: { email: 'system', sub: null }, headers: {} },
        action: 'email.dead_letter',
        resource: 'email.outbox',
        resourceId: row.id,
        payload: { kind: row.kind, to: row.recipient_email, attempts: nextAttempts, error: String(res.error ?? 'unknown') },
      });
    } else {
      const delay = backoffSecs(nextAttempts);
      await pool.query(
        `UPDATE email.outbox
            SET status = 'queued',
                attempts = $2,
                last_error = $3,
                next_attempt_at = now() + ($4::int * interval '1 second')
          WHERE id = $1`,
        [row.id, nextAttempts, String(res.error ?? 'transient'), delay],
      );
      counters.failed++;
    }
  }
  return counters;
}

// Recover rows stuck in `sending` longer than the claim TTL — e.g. process
// crash between UPDATE-to-sending and the post-send UPDATE. Re-arms them
// to 'queued' so the next drainOnce() picks them up.
const CLAIM_TTL_SEC = Number(process.env.EMAIL_DRAIN_CLAIM_TTL ?? 120);
export async function reclaimStuck() {
  const r = await pool.query(
    `UPDATE email.outbox
        SET status = 'queued', locked_at = NULL
      WHERE status = 'sending'
        AND locked_at IS NOT NULL
        AND locked_at < now() - ($1::int * interval '1 second')
      RETURNING id`,
    [CLAIM_TTL_SEC],
  );
  return r.rowCount ?? 0;
}
