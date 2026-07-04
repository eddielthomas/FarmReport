// =============================================================================
// /api/v1/crm/contacts/:id/invite-portal — provision a client's SSO login.
// -----------------------------------------------------------------------------
// Closes the "create client ≠ create login" gap: given a sales.contact, create
// (or refresh) their Keycloak user with the right role + tenant, set a temporary
// password, and return a ready-to-send login link. On first SSO login the OIDC
// callback auto-provisions their RWR user_profile, and because the Keycloak
// email == the contact email, the customer portal scopes them to their project.
//
//   POST /crm/contacts/:id/invite-portal  { role? }   (perm: crm.client.write)
//     role defaults to 'customer:view'; 'vendor:view' also allowed.
//
// Requires Keycloak admin to be configured (KEYCLOAK_ADMIN_CLIENT_ID/SECRET);
// returns 503 with guidance otherwise so the feature is dormant until wired.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { withTenantConn } from '../db/pool.mjs';
import { ok, badReq, notFound, send, readBody } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { kcAdminConfigured, ensureUser } from '../iam/keycloak-admin.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVITABLE_ROLES = new Set(['customer:view', 'vendor:view']);

// A friendly temporary password: letters+digits, no ambiguous chars.
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = randomBytes(12);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[b[i] % alphabet.length];
  return `Rwr-${s}`;
}

function appBaseFrom(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'report.farm').split(',')[0].trim();
  return `${proto}://${host}`;
}

export async function create(req, res, contactId) {
  if (!requirePermission(req, res, 'crm.client.write')) return;
  if (!UUID_RE.test(contactId)) return badReq(res, 'invalid_contact_id');
  if (!kcAdminConfigured()) {
    return send(res, 503, { success: false, error: 'sso_admin_unconfigured',
      detail: 'Set KEYCLOAK_ADMIN_CLIENT_ID/SECRET (rwr-admin service client) to enable portal invites.' });
  }
  const body = (await readBody(req)) || {};
  const role = INVITABLE_ROLES.has(body.role) ? body.role : 'customer:view';

  const contact = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, email, first_name, last_name FROM sales.contact WHERE id = $1`, [contactId]);
    return r.rows[0] ?? null;
  });
  if (!contact) return notFound(res);
  if (!contact.email) {
    return send(res, 422, { success: false, error: 'no_email',
      detail: 'Contact has no email; add one before inviting them to the portal.' });
  }

  const tenantSlug = req.tenant?.slug ?? req.user?.tenant_slug ?? null;
  const pw = tempPassword();
  let result;
  try {
    result = await ensureUser({
      email: contact.email, firstName: contact.first_name, lastName: contact.last_name,
      tenantSlug, roles: [role], tempPassword: pw,
    });
  } catch (e) {
    return send(res, 502, { success: false, error: 'sso_provision_failed', detail: String(e?.message ?? e) });
  }

  recordAudit({ req, action: 'crm.portal.invite', resource: 'sales.contact', resourceId: contactId,
    payload: { email: contact.email, role, created: result.created } });
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'contact', entityId: contactId,
    kind: 'system', source: 'system', actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: `Portal invite issued (${role}) for ${contact.email}`,
    metadata: { action: 'portal.invite', contact_id: contactId, role },
  }).catch(() => {});

  ok(res, {
    email: contact.email,
    role,
    created: result.created,
    temp_password: pw,
    login_url: `${appBaseFrom(req)}/api/v1/auth/oidc/login`,
    note: 'Send the customer the login link + temp password. They will be prompted to set a new password on first sign-in.',
  });
}
