// =============================================================================
// email/send.mjs — Resend transport with inline retry classification.
// -----------------------------------------------------------------------------
// One module owns the Resend SDK. Exposes:
//   send({to, subject, html, text, replyTo, tags, idempotencyKey?}) -> {ok,...}
//   withRetry(fn, opts?) -> wraps a transport call with exponential backoff
//
// Transport modes:
//   - production: hits Resend (requires RESEND_API_KEY)
//   - mock:       EMAIL_RESEND_DISABLED=1   -> logs + returns ok:true (sent_mock)
//   - dev:        no RESEND_API_KEY         -> logs + returns ok:true (dev)
//
// Inline retry classifies failures as:
//   - transient (retry):  5xx, 408, 429, ECONN*, ETIMEDOUT, rate_limit_exceeded
//   - permanent (bail):   4xx except 408/429
// =============================================================================

import { Resend } from 'resend';

const API_KEY        = process.env.RESEND_API_KEY ?? '';
const FROM           = process.env.EMAIL_FROM     ?? 'Report.Farm <noreply@report.farm>';
const REPLY_TO       = process.env.EMAIL_REPLY_TO ?? 'ops@report.farm';
const RESEND_DISABLED = process.env.EMAIL_RESEND_DISABLED === '1';

let _client;
function client() {
  if (!_client && API_KEY) _client = new Resend(API_KEY);
  return _client;
}

const TRANSIENT_CODES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_RX    = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|rate_limit)/i;

export function isTransient(x) {
  if (!x) return false;
  const msg  = x?.error?.message ?? x?.error ?? x?.message ?? '';
  const code = x?.statusCode   ?? x?.error?.statusCode ?? x?.code ?? null;
  if (code != null && TRANSIENT_CODES.has(Number(code))) return true;
  return TRANSIENT_RX.test(String(msg));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// withRetry — wraps any `() => Promise<{ok, ...}>` with exponential backoff.
// Defaults: 3 retries at 250ms / 1000ms / 4000ms (= 4 attempts total).
export async function withRetry(fn, opts = {}) {
  const backoffsMs = opts.backoffsMs ?? [250, 1000, 4000];
  const maxAttempts = opts.attempts ?? (backoffsMs.length + 1);
  let lastErr = null;
  let lastRes = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = await fn();
      lastRes = r;
      if (r && r.ok) return r;
      if (!isTransient(r)) return r;        // permanent — bail
      lastErr = r?.error ?? 'unknown';
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
    }
    const sleepIdx = attempt;
    if (sleepIdx < backoffsMs.length && attempt < maxAttempts - 1) {
      await sleep(backoffsMs[sleepIdx]);
    }
  }
  return lastRes ?? { ok: false, error: String(lastErr?.message ?? lastErr) };
}

// Low-level send. Returns { ok, id?, error?, dev?, mock? }.
// `idempotencyKey` (typically email.outbox.id) is forwarded to Resend so a
// retry from the durable queue doesn't double-deliver.
async function _sendOnce({ to, subject, html, text, replyTo, tags, idempotencyKey }) {
  if (RESEND_DISABLED) {
    console.log(`[email:mock] would send → ${Array.isArray(to) ? to.join(',') : to}  subject="${subject}"`);
    return { ok: true, mock: true };
  }
  if (!API_KEY) {
    console.log(`[email:dev] would send → ${Array.isArray(to) ? to.join(',') : to}  subject="${subject}"`);
    return { ok: true, dev: true };
  }
  try {
    const c = client();
    const opts = {
      from: FROM,
      to:   Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      reply_to: replyTo ?? REPLY_TO,
      tags: tags?.map((t) => ({ name: t.name, value: String(t.value) })),
    };
    // Resend supports Idempotency-Key via the second arg in newer SDKs; older
    // versions ignore it without erroring, so this is forward-safe.
    const sendOpts = idempotencyKey ? { idempotencyKey } : undefined;
    const res = await c.emails.send(opts, sendOpts);
    if (res?.error) {
      const err = res.error;
      const transient = TRANSIENT_CODES.has(Number(err?.statusCode));
      return {
        ok: false,
        error: err?.message ?? 'resend_error',
        statusCode: err?.statusCode ?? null,
        transient,
      };
    }
    return { ok: true, id: res?.data?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? 'send_failed',
      code: err?.code ?? null,
      transient: isTransient(err),
    };
  }
}

// Public send — wraps _sendOnce in withRetry. Callers that want exactly-one
// attempt (the drain worker, which already does durable retry) should call
// sendOnce directly.
export async function send(args) {
  return withRetry(() => _sendOnce(args));
}

// Single-shot send (no inline retry). Used by the drain worker so durable
// retry policy is the only retry policy.
export async function sendOnce(args) {
  return _sendOnce(args);
}
