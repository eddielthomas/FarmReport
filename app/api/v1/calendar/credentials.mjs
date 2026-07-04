// =============================================================================
// /api/v1/calendar/credentials — connected calendar providers for a user.
// -----------------------------------------------------------------------------
// Phase 1 surface: list + revoke ONLY. The connect flow ships in Phase 2 with
// the Google + Outlook OAuth modules. Until then this endpoint returns an
// empty list for fresh tenants so the UI can render the empty state cleanly.
//
// AuthZ:
//   - GET    list:   self-only (req.user.sub === row.user_id) OR platform.admin
//   - DELETE :id:    self-only (req.user.sub === row.user_id) OR platform.admin
//
// Token plaintext is NEVER returned. The response is metadata-only:
//   { id, provider, external_account_id, scope, expires_at, revoked_at,
//     created_at, updated_at }
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, notFound, forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const SAFE_COLS = `
  id, provider, external_account_id, scope, expires_at,
  revoked_at, created_at, updated_at
`;

function isPlatformAdmin(req) {
  const roles = req?.user?.roles ?? [];
  const perms = req?.user?.permissions;
  if (Array.isArray(roles) && roles.includes('platform:admin')) return true;
  if (perms && perms.has && perms.has('platform.admin.all')) return true;
  return false;
}

export async function list(req, res) {
  const isAdmin = isPlatformAdmin(req);
  const userId  = req.user?.sub;
  let rows;
  if (isAdmin) {
    // Admins see every credential within the tenant.
    const r = await q(
      `SELECT ${SAFE_COLS}, user_id
         FROM iam.oauth_credential
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [req.tenant.id],
    );
    rows = r.rows;
  } else {
    const r = await q(
      `SELECT ${SAFE_COLS}, user_id
         FROM iam.oauth_credential
        WHERE tenant_id = $1 AND user_id = $2
        ORDER BY created_at DESC`,
      [req.tenant.id, userId],
    );
    rows = r.rows;
  }
  ok(res, rows);
}

export async function revoke(req, res, id) {
  const { rows } = await q(
    `SELECT id, user_id, provider, revoked_at
       FROM iam.oauth_credential
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  const cred = rows[0];
  if (!isPlatformAdmin(req) && String(cred.user_id) !== String(req.user?.sub)) {
    return forbid(res, 'not_credential_owner');
  }
  if (cred.revoked_at) {
    // Idempotent — return the existing snapshot, no DB write.
    return ok(res, { id, revoked: true, already: true });
  }
  await q(
    `UPDATE iam.oauth_credential
        SET revoked_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  recordAudit({
    req,
    action: 'calendar.credential.revoked',
    resource: 'iam.oauth_credential',
    resourceId: id,
    payload: { provider: cred.provider, user_id: cred.user_id },
  });
  ok(res, { id, revoked: true });
}
