// =============================================================================
// /api/v1/contact — public contact form submissions.
// -----------------------------------------------------------------------------
// Public (no auth required) endpoint. Validates input, applies a DB-backed
// per-IP rate limit, persists to public.contact_submission, opts the user
// into newsletter (double-opt-in) if requested, and fires confirmation +
// internal notification emails via Resend.
//
// ---- Required env vars ------------------------------------------------------
//   TURNSTILE_SECRET_KEY  Cloudflare Turnstile secret for CAPTCHA verify. If
//                         unset, captcha is skipped (dev mode) and a warning
//                         is logged.
//   RESEND_API_KEY        Required to actually send mail (notify.mjs).
//   EMAIL_FROM            Sender, e.g. "Report.Farm <noreply@report.farm>".
//   EMAIL_INTERNAL_TO     Comma-separated internal recipients for the mission
//                         desk notification.
//   PUBLIC_BASE_URL       Used to build newsletter-confirm links.
//
// ---- Error code → HTTP status map ------------------------------------------
//   first_name_required    400
//   last_name_required     400
//   email_invalid          400
//   email_disposable       400
//   company_required       400
//   industry_required      400
//   industry_invalid       400
//   mission_line_required  400
//   mission_line_invalid   400
//   message_too_short      400
//   message_too_long       400
//   consent_required       400
//   captcha_failed         400
//   rate_limited           429   (+ retry-after header)
//   internal_error         500
//
// ---- Lead-promotion workflow ------------------------------------------------
// Submissions land here as public.contact_submission rows with status='new'.
// A platform admin reviews them via /api/v1/contact/admin/list, then either:
//   * marks spam (POST /admin/:id/spam)                — status='spam'
//   * promotes to a tenant lead (POST /admin/:id/promote {tenant_id})
//     which inserts a sales.lead row and back-fills the contact submission
//     with promoted_lead_id, promoted_tenant_id, promoted_at.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { q } from './db/pool.mjs';
import { ok, created, badReq, readBody, send } from './http.mjs';
import { notifyContact, notifyNewsletterConfirm } from './email/notify.mjs';

// ---- enum sets ------------------------------------------------------------
const VALID_MISSION  = new Set(['leak_loss','asset_recovery','infra_risk','physical_ai','integration','ops']);
const VALID_INDUSTRY = new Set(['water','oil_gas','power','defense','insurance','asset_finance','other']);
const VALID_TIMELINE = new Set(['within_30','1_3_mo','3_6_mo','exploring']);
const VALID_HEARD    = new Set(['google','referral','conference','linkedin','other']);

// Stricter email check than the previous regex.
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Loose E.164-ish phone check.
const PHONE_RE = /^[+]?[0-9\s\-().]{6,30}$/;

// Built-in disposable-domain blocklist. Intentionally short — production should
// swap in a real list (e.g. disposable-email-domains npm). Substring match
// against the domain so subdomains like inbox.mailinator.com get caught.
const DISPOSABLE_DOMAINS = [
  'mailinator', 'guerrillamail', '10minutemail', 'tempmail',
  'throwaway',  'yopmail',
];

// Rate-limit window (mirrored in the SQL function args below).
const RATE_WINDOW_SECONDS = 3600; // 1 h
const RATE_MAX            = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isDisposable(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return DISPOSABLE_DOMAINS.some((d) => domain.includes(d));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile verification
// ---------------------------------------------------------------------------
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('[contact] TURNSTILE_SECRET_KEY not set — skipping captcha (dev mode)');
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, reason: 'missing_token' };

  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);

    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:  'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:    form.toString(),
    });
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, reason: 'invalid_json' };
    return { ok: !!j.success, codes: j['error-codes'] ?? [] };
  } catch (err) {
    console.error('[contact] turnstile verify failed', err);
    return { ok: false, reason: 'verify_threw', error: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// DB-backed rate limit (replaces the in-memory Map of the prior impl).
// ---------------------------------------------------------------------------
async function rateLimited(ip) {
  if (!ip) return false;
  try {
    const { rows } = await q(
      `SELECT public.contact_rate_check($1::inet, $2::int, $3::int) AS allowed`,
      [ip, RATE_WINDOW_SECONDS, RATE_MAX],
    );
    return rows[0]?.allowed === false;
  } catch (err) {
    // If the rate-limit function is missing (e.g. migration not applied yet)
    // we fail open rather than blocking legitimate users.
    console.error('[contact] rate_check failed', err?.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/contact
// ---------------------------------------------------------------------------
export async function submit(req, res) {
  const body = (await readBody(req)) ?? {};
  const ip   = clientIp(req);
  const ua   = req.headers['user-agent'] ?? null;

  // ---- Honeypot — silently swallow and persist as spam ----
  if (body.website) {
    try {
      const id = randomUUID();
      await q(
        `INSERT INTO public.contact_submission
           (id, first_name, last_name, email, company, message,
            source, ip, user_agent, status, spam_score, consent_privacy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'spam',100,false)`,
        [
          id,
          (body.first_name ?? 'honeypot').toString().slice(0, 60),
          (body.last_name  ?? 'honeypot').toString().slice(0, 60),
          (body.email      ?? 'spam@honeypot.invalid').toString().slice(0, 254).toLowerCase(),
          (body.company    ?? 'honeypot').toString().slice(0, 120),
          (body.message    ?? '(honeypot)').toString().slice(0, 4000),
          (body.source     ?? 'honeypot').toString().slice(0, 60),
          ip,
          ua,
        ],
      );
    } catch (err) {
      // Honeypot persistence failure should NEVER reveal anything to the bot.
      console.warn('[contact] honeypot persist failed', err?.message);
    }
    return ok(res, { id: 'silent', ok: true });
  }

  // ---- normalise + validate inputs -----------------------------------------
  const firstName = (body.first_name ?? '').toString().trim().slice(0, 60);
  const lastName  = (body.last_name  ?? '').toString().trim().slice(0, 60);
  const email     = (body.email      ?? '').toString().trim().toLowerCase().slice(0, 254);
  const company   = (body.company    ?? '').toString().trim().slice(0, 120);
  const industry  = (body.industry   ?? '').toString().trim().toLowerCase();
  const mission   = (body.mission_line ?? '').toString().trim().toLowerCase();
  const message   = (body.message    ?? '').toString().trim().slice(0, 4001); // +1 so we can detect overflow
  const newsletter = !!body.newsletter;
  const source    = (body.source ?? 'contact_page').toString().slice(0, 60);

  // new fields
  const phone     = (body.phone ?? '').toString().trim().slice(0, 30) || null;
  const role      = (body.role  ?? '').toString().trim().slice(0, 120) || null;
  let   country   = (body.country ?? '').toString().trim().toUpperCase().slice(0, 2) || null;
  const timeline  = (body.timeline ?? '').toString().trim().toLowerCase() || null;
  const ndaReq    = !!body.nda_required;
  const howHeard  = (body.how_heard ?? '').toString().trim().toLowerCase() || null;
  const consent   = body.consent_privacy === true || body.consent_privacy === 'true' || body.consent_privacy === 'on';
  const captchaTk = (body.turnstile_token ?? body['cf-turnstile-response'] ?? '').toString();

  // ---- required-field gates ------------------------------------------------
  if (!firstName)                                  return badReq(res, 'first_name_required');
  if (!lastName)                                   return badReq(res, 'last_name_required');
  if (!EMAIL_RE.test(email))                       return badReq(res, 'email_invalid');
  if (isDisposable(email))                         return badReq(res, 'email_disposable');
  if (!company || company.length < 2)              return badReq(res, 'company_required');
  if (!industry)                                   return badReq(res, 'industry_required');
  if (!VALID_INDUSTRY.has(industry))               return badReq(res, 'industry_invalid');
  if (!mission)                                    return badReq(res, 'mission_line_required');
  if (!VALID_MISSION.has(mission))                 return badReq(res, 'mission_line_invalid');
  if (message.length < 20)                         return badReq(res, 'message_too_short');
  if (message.length > 4000)                       return badReq(res, 'message_too_long');
  if (!consent)                                    return badReq(res, 'consent_required');

  // ---- optional-field validation ------------------------------------------
  if (phone && !PHONE_RE.test(phone))                       return badReq(res, 'phone_invalid');
  if (country && !/^[A-Z]{2}$/.test(country))               return badReq(res, 'country_invalid');
  if (timeline && !VALID_TIMELINE.has(timeline))            return badReq(res, 'timeline_invalid');
  if (howHeard && !VALID_HEARD.has(howHeard))               return badReq(res, 'how_heard_invalid');

  // ---- captcha -------------------------------------------------------------
  const cap = await verifyTurnstile(captchaTk, ip);
  if (!cap.ok) {
    console.warn('[contact] captcha_failed', cap);
    return badReq(res, 'captcha_failed');
  }

  // ---- rate limit ----------------------------------------------------------
  if (await rateLimited(ip)) {
    res.setHeader('retry-after', String(RATE_WINDOW_SECONDS));
    return send(res, 429, {
      success: false,
      error:   'rate_limited',
      retry_after: RATE_WINDOW_SECONDS,
      detail:  'Too many submissions from this IP. Please email ops@report.farm directly.',
    });
  }

  // ---- persist -------------------------------------------------------------
  const id = randomUUID();
  try {
    await q(
      `INSERT INTO public.contact_submission
         (id, first_name, last_name, email, company, industry, mission_line, message,
          newsletter, source, ip, user_agent,
          phone, role, country, timeline, nda_required, how_heard,
          consent_privacy, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               $9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,
               $19, now())`,
      [
        id, firstName, lastName, email, company, industry, mission, message,
        newsletter, source, ip, ua,
        phone, role, country, timeline, ndaReq, howHeard,
        true, // consent_privacy — gated above
      ],
    );
  } catch (err) {
    console.error('[contact] insert failed', err);
    return send(res, 500, { success: false, error: 'internal_error' });
  }

  // ---- newsletter (double-opt-in) -----------------------------------------
  if (newsletter) {
    try {
      const token = randomUUID();
      await q(
        `INSERT INTO public.newsletter_subscriber (email, first_name, confirm_token, source)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
           SET first_name = EXCLUDED.first_name,
               confirm_token = EXCLUDED.confirm_token`,
        [email, firstName, token, source],
      );
      const base = process.env.PUBLIC_BASE_URL ?? 'https://report.farm';
      notifyNewsletterConfirm({
        email,
        first_name:  firstName,
        confirmUrl: `${base}/api/v1/contact/newsletter/confirm?token=${token}`,
      }).catch((e) => console.error('[contact] newsletter notify failed', e));
    } catch (err) {
      console.error('[contact] newsletter subscribe failed', err?.message);
    }
  }

  // ---- email notifications (fire-and-forget) ------------------------------
  notifyContact({
    submission: {
      first_name:   firstName,
      last_name:    lastName,
      email,
      company,
      industry,
      mission_line: mission,
      message,
      newsletter,
      // extra context fields rendered if the internal template supports them
      phone,
      role,
      country,
      timeline,
      nda_required: ndaReq,
      how_heard:    howHeard,
    },
    ip,
    user_agent: ua,
  }).catch((e) => console.error('[contact] notify failed', e));

  return created(res, { id, ok: true });
}

// ---------------------------------------------------------------------------
// GET /api/v1/contact/newsletter/confirm?token=…  — double-opt-in landing
// ---------------------------------------------------------------------------
export async function confirmNewsletter(req, res) {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (!token) return badReq(res, 'token_required');
  const { rows } = await q(
    `UPDATE public.newsletter_subscriber
        SET confirmed_at  = COALESCE(confirmed_at, now()),
            confirm_token = NULL
      WHERE confirm_token = $1
      RETURNING email`,
    [token],
  );
  if (rows.length === 0) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(htmlPage('Subscription link expired or invalid', 'Try subscribing again from the contact form.'));
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(htmlPage('Subscription confirmed', `Thanks — ${rows[0].email} is now on the list. Unsubscribe any time from the footer of our emails.`));
}

function htmlPage(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Report.Farm</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:0;background:#04060e;color:#e4eaf4;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:480px;padding:36px;background:rgba(8,16,32,0.85);border:1px solid rgba(60,140,255,0.25);border-radius:14px;text-align:center}
h1{font-size:22px;margin:0 0 12px;color:#fff}p{color:#8094b4;line-height:1.6;font-size:14px;margin:0 0 18px}
a{display:inline-block;padding:10px 22px;background:linear-gradient(120deg,#4ea8ff,#00d4ff);color:#04060e;text-decoration:none;border-radius:8px;font-weight:700;font-size:13px}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p><a href="/">Back to home</a></div></body></html>`;
}
