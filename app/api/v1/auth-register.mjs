// =============================================================================
// /api/v1/auth/register* — public self-service registration (request-access).
// -----------------------------------------------------------------------------
// Opt-in, OFF by default. Everything here no-ops (404) unless the app flag
// ALLOW_SELF_REGISTRATION=1 is set, so the invite-only posture is preserved and
// the Register button/route simply don't exist when the flag is off.
//
//   GET  /auth/registration-config        → { enabled }              (public)
//   POST /auth/register-request           → submit a registration    (public)
//        body { email, first_name, last_name, company?, code }
//        code = staff-issued iam.registration_code → resolves the tenant + role.
//        Creates a PENDING iam.registration_request and emails an app-owned
//        verify link (Resend). No login is created here.
//   GET  /auth/register/verify?token=…     → mark email_verified, redirect  (public)
//
// Approval (staff) lives in crm/registration-admin.mjs. Email verification is
// app-owned (Resend) so no Keycloak realm SMTP is required.
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { q } from './db/pool.mjs';
import { readBody, ok, badReq, send } from './http.mjs';
import { send as sendEmail } from './email/send.mjs';

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const VERIFY_TTL_HOURS = 24;

export function selfRegistrationEnabled() {
  return process.env.ALLOW_SELF_REGISTRATION === '1';
}

function appBaseFrom(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'report.farm').split(',')[0].trim();
  return `${proto}://${host}`;
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// -----------------------------------------------------------------------------
// GET /auth/registration-config — does the Register UI show at all?
// -----------------------------------------------------------------------------
export async function registrationConfig(req, res) {
  ok(res, { enabled: selfRegistrationEnabled() });
}

// Resolve a usable code (active, unexpired, uses left). Returns the row or null.
async function resolveCode(codePlain) {
  const code = String(codePlain ?? '').trim();
  if (!code) return null;
  const { rows } = await q(
    `SELECT id, tenant_id, role, project_id, max_uses, used_count, expires_at, active
       FROM iam.registration_code
      WHERE lower(code) = lower($1)
      LIMIT 1`,
    [code],
  );
  const c = rows[0];
  if (!c || !c.active) return null;
  if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) return null;
  if (c.max_uses != null && c.used_count >= c.max_uses) return null;
  return c;
}

// -----------------------------------------------------------------------------
// POST /auth/register-request — capture a pending registration.
// -----------------------------------------------------------------------------
export async function submitRegistration(req, res) {
  if (!selfRegistrationEnabled()) return send(res, 404, { success: false, error: 'not_found' });

  const body = (await readBody(req).catch(() => null)) || {};
  const email = String(body.email ?? '').trim().toLowerCase();
  const first_name = String(body.first_name ?? '').trim().slice(0, 120) || null;
  const last_name = String(body.last_name ?? '').trim().slice(0, 120) || null;
  const company = String(body.company ?? '').trim().slice(0, 200) || null;
  const codePlain = String(body.code ?? '').trim();

  if (!EMAIL_RE.test(email)) return badReq(res, 'invalid_email');
  if (!codePlain) return badReq(res, 'access_code_required');

  const code = await resolveCode(codePlain);
  if (!code) return send(res, 422, { success: false, error: 'invalid_access_code',
    detail: 'That access code is not recognised, has expired, or is used up. Ask your contact for a current code.' });

  // Mint an app-owned verify token (hash stored; plaintext only ever emailed).
  const verifyToken = randomBytes(24).toString('hex');
  const verifyHash = sha256(verifyToken);
  const verifyExpires = new Date(Date.now() + VERIFY_TTL_HOURS * 3600 * 1000).toISOString();

  // Upsert the pending request (re-submitting refreshes the token, never
  // resurrects an already approved/rejected one without staff action).
  let request;
  try {
    const { rows } = await q(
      `INSERT INTO iam.registration_request
         (tenant_id, code_id, email, first_name, last_name, company, role, project_id,
          status, email_verified, verify_token_hash, verify_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',false,$9,$10, now())
       ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET
         code_id           = EXCLUDED.code_id,
         first_name        = EXCLUDED.first_name,
         last_name         = EXCLUDED.last_name,
         company           = EXCLUDED.company,
         role              = EXCLUDED.role,
         project_id        = EXCLUDED.project_id,
         status            = CASE WHEN iam.registration_request.status = 'approved'
                                  THEN 'approved' ELSE 'pending' END,
         email_verified    = CASE WHEN iam.registration_request.status = 'approved'
                                  THEN iam.registration_request.email_verified ELSE false END,
         verify_token_hash = EXCLUDED.verify_token_hash,
         verify_expires_at = EXCLUDED.verify_expires_at,
         updated_at        = now()
       RETURNING id, tenant_id, status, email_verified`,
      [code.tenant_id, code.id, email, first_name, last_name, company, code.role, code.project_id,
       verifyHash, verifyExpires],
    );
    request = rows[0];
  } catch (e) {
    return send(res, 500, { success: false, error: 'request_failed', detail: String(e?.message ?? e) });
  }

  // Already-approved email: don't re-trigger verification; tell them to sign in.
  if (request.status === 'approved') {
    return ok(res, { status: 'already_approved',
      message: 'This email already has access. Use the sign-in page (or "Forgot password").' });
  }

  // Send the app-owned verification email (Resend). dev/mock → not delivered.
  const verifyUrl = `${appBaseFrom(req)}/api/v1/auth/register/verify?token=${verifyToken}`;
  let emailDelivered = false;
  try {
    const r = await sendEmail({
      to: email,
      subject: 'Confirm your AlphaGeo portal request',
      html: `<p>Hi ${first_name ?? 'there'},</p>
             <p>Confirm your email to complete your AlphaGeo portal access request. A team member will review it after you confirm.</p>
             <p><a href="${verifyUrl}">Confirm my email</a></p>
             <p>This link expires in ${VERIFY_TTL_HOURS} hours. If you didn't request this, ignore this email.</p>`,
      text: `Confirm your email to complete your AlphaGeo portal access request:\n${verifyUrl}\n(expires in ${VERIFY_TTL_HOURS}h)`,
      tags: [{ name: 'kind', value: 'registration_verify' }],
    });
    emailDelivered = Boolean(r?.ok) && !r?.dev && !r?.mock;
  } catch (_e) { emailDelivered = false; }

  ok(res, {
    status: 'pending_verification',
    message: emailDelivered
      ? 'Check your email and confirm your address. A team member will review your request after that.'
      : 'Request received. Confirm your email using the link below, then a team member will review your request.',
    // Only surfaced when real delivery did not happen (dev / Resend unconfigured)
    // so the flow stays completable; never exposed once email actually sends.
    verify_url: emailDelivered ? undefined : verifyUrl,
  });
}

// -----------------------------------------------------------------------------
// GET /auth/register/verify?token=… — prove the mailbox, then bounce to the page.
// -----------------------------------------------------------------------------
export async function verifyRegistration(req, res) {
  if (!selfRegistrationEnabled()) return send(res, 404, { success: false, error: 'not_found' });

  const url = new URL(req.url, 'http://localhost');
  const token = String(url.searchParams.get('token') ?? '').trim();
  const redirect = (status) => {
    res.writeHead(302, { location: `/register.html?${status}` });
    res.end();
  };
  if (!token) return redirect('verify=invalid');

  const hash = sha256(token);
  const { rows } = await q(
    `SELECT id, status, verify_expires_at FROM iam.registration_request
      WHERE verify_token_hash = $1 LIMIT 1`,
    [hash],
  );
  const reqRow = rows[0];
  if (!reqRow || reqRow.status === 'rejected') return redirect('verify=invalid');
  if (reqRow.verify_expires_at && new Date(reqRow.verify_expires_at).getTime() < Date.now()) {
    return redirect('verify=expired');
  }

  await q(
    `UPDATE iam.registration_request
        SET email_verified = true, verify_token_hash = NULL, verify_expires_at = NULL, updated_at = now()
      WHERE id = $1`,
    [reqRow.id],
  );
  return redirect('verify=ok');
}
