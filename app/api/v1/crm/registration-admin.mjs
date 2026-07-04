// =============================================================================
// /api/v1/crm/registration-* — staff review of self-service registrations.
// -----------------------------------------------------------------------------
// The public side (auth-register.mjs) captures a PENDING, email-verified request
// scoped to a tenant via an access code. Staff approve/reject here:
//
//   GET    /crm/registration-requests[?status=pending]   (crm.registration.read)
//   POST   /crm/registration-requests/:id/approve         (crm.registration.manage)
//   POST   /crm/registration-requests/:id/reject  { reason }
//
//   GET    /crm/registration-codes                        (crm.registration.read)
//   POST   /crm/registration-codes  { code?, role?, project_id?, label?, max_uses?, expires_at? }
//   POST   /crm/registration-codes/:id/deactivate         (crm.registration.manage)
//
// Approval provisions the Keycloak SSO user (via the rwr-admin service client),
// upserts iam.user_profile (login + role + tenant), and — when the code carries
// a project — links the customer to that project so the portal scopes them in.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { q, withTenantConn } from '../db/pool.mjs';
import { ok, created, badReq, notFound, send, readBody } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { recordAudit } from '../audit.mjs';
import { kcAdminConfigured, ensureUser } from '../iam/keycloak-admin.mjs';
import { send as sendEmail } from '../email/send.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITABLE_ROLES = new Set(['customer:view', 'vendor:view']);

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = randomBytes(12);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[b[i] % alphabet.length];
  return `Rwr-${s}`;
}

function appBaseFrom(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'report.farm').split(',')[0].trim();
  return `${proto}://${host}`;
}

// -----------------------------------------------------------------------------
// GET /crm/registration-requests[?status=]
// -----------------------------------------------------------------------------
export async function listRequests(req, res) {
  if (!requirePermission(req, res, 'crm.registration.read')) return;
  const url = new URL(req.url, 'http://localhost');
  const status = String(url.searchParams.get('status') ?? '').trim().toLowerCase();
  const rows = await withTenantConn(req, async (client) => {
    const params = [req.tenant.id];
    let where = 'tenant_id = $1';
    if (['pending', 'approved', 'rejected'].includes(status)) { params.push(status); where += ` AND status = $2`; }
    const r = await client.query(
      `SELECT id, email, first_name, last_name, company, role, project_id, status,
              email_verified, reviewed_at, reject_reason, created_at
         FROM iam.registration_request
        WHERE ${where}
        ORDER BY (status = 'pending') DESC, created_at DESC
        LIMIT 500`, params);
    return r.rows;
  });
  ok(res, { requests: rows });
}

// -----------------------------------------------------------------------------
// POST /crm/registration-requests/:id/approve
// -----------------------------------------------------------------------------
export async function approveRequest(req, res, id) {
  if (!requirePermission(req, res, 'crm.registration.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  if (!kcAdminConfigured()) {
    return send(res, 503, { success: false, error: 'sso_admin_unconfigured',
      detail: 'Set KEYCLOAK_ADMIN_CLIENT_ID/SECRET (rwr-admin service client) to approve registrations.' });
  }

  const reqRow = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, tenant_id, email, first_name, last_name, role, project_id, status, email_verified
         FROM iam.registration_request WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!reqRow) return notFound(res);
  if (reqRow.status === 'approved') return badReq(res, 'already_approved');
  if (reqRow.status === 'rejected') return badReq(res, 'already_rejected');
  if (!reqRow.email_verified) {
    return send(res, 422, { success: false, error: 'email_not_verified',
      detail: 'The registrant has not confirmed their email yet.' });
  }
  const role = INVITABLE_ROLES.has(reqRow.role) ? reqRow.role : 'customer:view';

  // tenant slug for the Keycloak tenant_slug attribute
  const { rows: trows } = await q('SELECT slug FROM iam.tenant WHERE id = $1 LIMIT 1', [reqRow.tenant_id]);
  const tenantSlug = trows[0]?.slug ?? req.tenant?.slug ?? null;

  // 1) Keycloak SSO user (email already app-verified → emailVerified:true).
  const pw = tempPassword();
  let kc;
  try {
    kc = await ensureUser({
      email: reqRow.email, firstName: reqRow.first_name, lastName: reqRow.last_name,
      tenantSlug, roles: [role], tempPassword: pw, emailVerified: true,
    });
  } catch (e) {
    return send(res, 502, { success: false, error: 'sso_provision_failed', detail: String(e?.message ?? e) });
  }

  // 2) App profile (login + role + tenant) — mirrors the dev-login upsert.
  await q(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, email)
       DO UPDATE SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles`,
    [reqRow.tenant_id, reqRow.email,
     [reqRow.first_name, reqRow.last_name].filter(Boolean).join(' ') || reqRow.email.split('@')[0],
     [role]]);

  // 3) Project visibility — ensure a sales.contact and bind it to the project.
  if (reqRow.project_id) {
    try {
      await withTenantConn(req, async (client) => {
        await client.query(
          `INSERT INTO sales.contact (tenant_id, organization_id, first_name, last_name, email, status)
           VALUES ($1, NULL, $2, $3, $4, 'active')
           ON CONFLICT (tenant_id, lower(email)) DO NOTHING`,
          [reqRow.tenant_id, reqRow.first_name, reqRow.last_name, reqRow.email]);
        const cr = await client.query(
          `SELECT id FROM sales.contact WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
          [reqRow.tenant_id, reqRow.email]);
        const contactId = cr.rows[0]?.id;
        if (contactId) {
          // Bind only when the project has no customer yet (don't steal an
          // existing binding); this is the direct customerScope path.
          await client.query(
            `UPDATE crm.project SET customer_contact_id = $1
              WHERE id = $2 AND tenant_id = $3 AND customer_contact_id IS NULL`,
            [contactId, reqRow.project_id, reqRow.tenant_id]);
        }
      });
    } catch (e) {
      console.error('[registration] project_link_failed', e?.message ?? e);
    }
  }

  // 4) Flip the request to approved.
  await withTenantConn(req, async (client) => {
    await client.query(
      `UPDATE iam.registration_request
          SET status = 'approved', kc_user_id = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE id = $3`,
      [kc.id, req.user?.sub ?? null, id]);
  });

  // 5) Notify the customer with their login + temp password (Resend).
  const loginUrl = `${appBaseFrom(req)}/api/v1/auth/oidc/login`;
  let emailDelivered = false;
  try {
    const r = await sendEmail({
      to: reqRow.email,
      subject: 'Your AlphaGeo portal access is approved',
      html: `<p>Good news — your AlphaGeo portal access has been approved.</p>
             <p>Sign in here: <a href="${loginUrl}">${loginUrl}</a></p>
             <p>Temporary password: <b>${pw}</b><br/>You'll be asked to set your own password on first sign-in.</p>`,
      text: `Your AlphaGeo portal access is approved.\nSign in: ${loginUrl}\nTemporary password: ${pw} (you'll reset it on first sign-in).`,
      tags: [{ name: 'kind', value: 'registration_approved' }],
    });
    emailDelivered = Boolean(r?.ok) && !r?.dev && !r?.mock;
  } catch (_e) { emailDelivered = false; }

  recordAudit({ req, action: 'crm.registration.approve', resource: 'iam.registration_request', resourceId: id,
    payload: { email: reqRow.email, role, kc_created: kc.created } });

  ok(res, {
    status: 'approved', email: reqRow.email, role, created: kc.created,
    login_url: loginUrl, email_delivered: emailDelivered,
    // Surfaced so staff can relay manually when email isn't actually delivered.
    temp_password: emailDelivered ? undefined : pw,
  });
}

// -----------------------------------------------------------------------------
// POST /crm/registration-requests/:id/reject { reason }
// -----------------------------------------------------------------------------
export async function rejectRequest(req, res, id) {
  if (!requirePermission(req, res, 'crm.registration.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const body = (await readBody(req).catch(() => null)) || {};
  const reason = String(body.reason ?? '').trim().slice(0, 500) || null;

  const updated = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `UPDATE iam.registration_request
          SET status = 'rejected', reject_reason = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE id = $3 AND status <> 'approved'
        RETURNING id, email`,
      [reason, req.user?.sub ?? null, id]);
    return r.rows[0] ?? null;
  });
  if (!updated) return badReq(res, 'not_pending_or_missing');
  recordAudit({ req, action: 'crm.registration.reject', resource: 'iam.registration_request', resourceId: id,
    payload: { email: updated.email, reason } });
  ok(res, { status: 'rejected', email: updated.email });
}

// -----------------------------------------------------------------------------
// GET /crm/registration-codes
// -----------------------------------------------------------------------------
export async function listCodes(req, res) {
  if (!requirePermission(req, res, 'crm.registration.read')) return;
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT c.id, c.code, c.role, c.project_id, c.label, c.max_uses, c.used_count,
              c.expires_at, c.active, c.created_at, p.title AS project_title
         FROM iam.registration_code c
         LEFT JOIN crm.project p ON p.id = c.project_id AND p.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
        ORDER BY c.active DESC, c.created_at DESC`, [req.tenant.id]);
    return r.rows;
  });
  ok(res, { codes: rows });
}

// -----------------------------------------------------------------------------
// POST /crm/registration-codes
// -----------------------------------------------------------------------------
export async function createCode(req, res) {
  if (!requirePermission(req, res, 'crm.registration.manage')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  let code = String(body.code ?? '').trim();
  if (!code) code = `AG-${randomBytes(4).toString('hex').toUpperCase()}`;
  const role = INVITABLE_ROLES.has(body.role) ? body.role : 'customer:view';
  const project_id = (typeof body.project_id === 'string' && UUID_RE.test(body.project_id)) ? body.project_id : null;
  const label = String(body.label ?? '').trim().slice(0, 200) || null;
  const max_uses = Number.isInteger(body.max_uses) && body.max_uses > 0 ? body.max_uses : null;
  const expires_at = body.expires_at ? new Date(body.expires_at).toISOString() : null;

  let row;
  try {
    row = await withTenantConn(req, async (client) => {
      const r = await client.query(
        `INSERT INTO iam.registration_code
           (tenant_id, code, role, project_id, label, max_uses, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, code, role, project_id, label, max_uses, used_count, expires_at, active, created_at`,
        [req.tenant.id, code, role, project_id, label, max_uses, expires_at, req.user?.sub ?? null]);
      return r.rows[0];
    });
  } catch (e) {
    if (String(e?.message ?? e).includes('registration_code_code_ukey')) return badReq(res, 'code_already_exists');
    return send(res, 500, { success: false, error: 'create_failed', detail: String(e?.message ?? e) });
  }
  recordAudit({ req, action: 'crm.registration.code.create', resource: 'iam.registration_code', resourceId: row.id,
    payload: { code: row.code, role, project_id } });
  created(res, { code: row });
}

// -----------------------------------------------------------------------------
// POST /crm/registration-codes/:id/deactivate
// -----------------------------------------------------------------------------
export async function deactivateCode(req, res, id) {
  if (!requirePermission(req, res, 'crm.registration.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const updated = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `UPDATE iam.registration_code SET active = false
        WHERE id = $1 AND tenant_id = $2 RETURNING id, code`, [id, req.tenant.id]);
    return r.rows[0] ?? null;
  });
  if (!updated) return notFound(res);
  recordAudit({ req, action: 'crm.registration.code.deactivate', resource: 'iam.registration_code', resourceId: id,
    payload: { code: updated.code } });
  ok(res, { status: 'deactivated', code: updated.code });
}
