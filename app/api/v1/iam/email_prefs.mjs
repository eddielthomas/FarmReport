// =============================================================================
// /api/v1/iam/email_prefs — tenant + user email preference REST handlers.
// -----------------------------------------------------------------------------
//   GET   /iam/tenants/:id/email-prefs
//   PATCH /iam/tenants/:id/email-prefs   body: { prefs: [{kind, enabled}, ...] }
//                                        body: { lead_created: false, ... }  (shorthand)
//   GET   /iam/users/:id/email-prefs
//   PATCH /iam/users/:id/email-prefs     body: { prefs: [{kind, enabled}, ...] }
//                                        body: { lead_created: false, ... }  (shorthand)
//
// AuthZ:
//   - tenant routes  -> platform:admin OR caller is admin of req.tenant
//   - user routes    -> self OR platform:admin OR tenant:admin of the user's tenant
// =============================================================================

import { readBody, ok, badReq, notFound, forbid } from '../http.mjs';
import { q } from '../db/pool.mjs';
import { recordAudit } from '../audit.mjs';
import {
  KINDS, getTenantPrefs, getUserPrefs, setTenantPref, setUserPref,
} from '../email/prefs.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlatformAdmin(req) {
  const roles = req?.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  return req?.user?.permissions?.has?.('platform.admin.all') === true;
}

function isTenantAdmin(req, tenantId) {
  if (isPlatformAdmin(req)) return true;
  if (req?.tenant?.id !== tenantId) return false;
  const roles = req?.user?.roles ?? [];
  return roles.includes('tenant:admin')
      || roles.includes('platform:admin')
      || roles.includes('sales:manage'); // sales managers can also flip tenant prefs
}

// Normalise incoming body into [{kind, enabled}, ...]. Accepts either
// { prefs: [...] } OR a shorthand object { lead_created: false, ... }.
function parsePrefsBody(body) {
  if (Array.isArray(body?.prefs)) {
    return body.prefs
      .filter((p) => p && KINDS.includes(p.kind) && typeof p.enabled === 'boolean')
      .map((p) => ({ kind: p.kind, enabled: !!p.enabled }));
  }
  if (body && typeof body === 'object') {
    const out = [];
    for (const k of KINDS) {
      if (typeof body[k] === 'boolean') out.push({ kind: k, enabled: body[k] });
    }
    return out;
  }
  return [];
}

// --- tenant prefs ------------------------------------------------------------
export async function getTenant(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!isTenantAdmin(req, tenantId)) return forbid(res, 'missing_role');
  const exists = await q(`SELECT id FROM iam.tenant WHERE id = $1`, [tenantId]);
  if (exists.rows.length === 0) return notFound(res, 'tenant_not_found');
  // Ensure req.tenant is set so withTenantConn() can stamp the RLS context.
  req.tenant = req.tenant ?? { id: tenantId };
  const prefs = await getTenantPrefs(tenantId);
  ok(res, { tenant_id: tenantId, prefs });
}

export async function patchTenant(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!isTenantAdmin(req, tenantId)) return forbid(res, 'missing_role');
  const exists = await q(`SELECT id FROM iam.tenant WHERE id = $1`, [tenantId]);
  if (exists.rows.length === 0) return notFound(res, 'tenant_not_found');
  const body = (await readBody(req).catch(() => null)) || {};
  const changes = parsePrefsBody(body);
  if (changes.length === 0) return badReq(res, 'no_prefs_to_update');

  req.tenant = req.tenant ?? { id: tenantId };
  for (const c of changes) {
    await setTenantPref(tenantId, c.kind, c.enabled, req.user?.sub ?? null);
  }

  recordAudit({
    req, action: 'email_pref.tenant_update',
    resource: 'iam.tenant_email_pref', resourceId: tenantId,
    payload: { changes },
  });
  const prefs = await getTenantPrefs(tenantId);
  ok(res, { tenant_id: tenantId, prefs });
}

// --- user prefs --------------------------------------------------------------
async function loadUserScope(userId) {
  const { rows } = await q(
    `SELECT id, tenant_id, email FROM iam.user_profile WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

function canManageUser(req, userRow) {
  if (!userRow) return false;
  if (req?.user?.sub === userRow.id) return true; // self
  if (isPlatformAdmin(req)) return true;
  if (req?.tenant?.id === userRow.tenant_id) {
    const roles = req?.user?.roles ?? [];
    if (roles.includes('platform:admin')) return true;
    if (roles.includes('tenant:admin'))   return true;
    if (roles.includes('sales:manage'))   return true;
  }
  return false;
}

export async function getUser(req, res, userId) {
  if (!UUID_RE.test(userId)) return badReq(res, 'invalid_user_id');
  const userRow = await loadUserScope(userId);
  if (!userRow) return notFound(res, 'user_not_found');
  if (!canManageUser(req, userRow)) return forbid(res, 'missing_role');
  req.tenant = req.tenant ?? { id: userRow.tenant_id };
  const prefs = await getUserPrefs(userRow.tenant_id, userId);
  ok(res, { user_id: userId, tenant_id: userRow.tenant_id, prefs });
}

export async function patchUser(req, res, userId) {
  if (!UUID_RE.test(userId)) return badReq(res, 'invalid_user_id');
  const userRow = await loadUserScope(userId);
  if (!userRow) return notFound(res, 'user_not_found');
  if (!canManageUser(req, userRow)) return forbid(res, 'missing_role');
  const body = (await readBody(req).catch(() => null)) || {};
  const changes = parsePrefsBody(body);
  if (changes.length === 0) return badReq(res, 'no_prefs_to_update');

  req.tenant = req.tenant ?? { id: userRow.tenant_id };
  for (const c of changes) {
    await setUserPref(userRow.tenant_id, userId, c.kind, c.enabled);
  }
  recordAudit({
    req, action: 'email_pref.user_update',
    resource: 'iam.user_email_pref', resourceId: userId,
    payload: { changes },
  });
  const prefs = await getUserPrefs(userRow.tenant_id, userId);
  ok(res, { user_id: userId, tenant_id: userRow.tenant_id, prefs });
}
