// =============================================================================
// /api/v1/iam/tenant_aliases — per-tenant alias (legacy slug / domain / realm) CRUD.
// -----------------------------------------------------------------------------
//   GET    /iam/tenants/:id/aliases
//   POST   /iam/tenants/:id/aliases   { alias, kind }
//   DELETE /iam/tenants/:id/aliases/:alias
//
// AuthZ: platform.admin OR tenant.admin of `:id`.
// Aliases are globally unique across tenants (see migration 115's unique idx).
// Conflict returns 409.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, send, badReq, notFound, forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['slug_legacy','domain','realm','external_id']);
const ALIAS_RE = /^[A-Za-z0-9._\-]{1,200}$/;

function canManage(req, tenantId) {
  const roles = req?.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  if (req?.tenant?.id === tenantId && roles.includes('iam.tenant.aliases.manage')) return true;
  return false;
}

// GET /iam/tenants/:id/aliases
export async function list(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!canManage(req, tenantId)) return forbid(res, 'missing_role');
  const { rows } = await q(
    `SELECT alias, tenant_id, kind, created_at, created_by
       FROM iam.tenant_alias WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  ok(res, rows);
}

// POST /iam/tenants/:id/aliases { alias, kind }
export async function create(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!canManage(req, tenantId)) return forbid(res, 'missing_role');
  const body = (await readBody(req).catch(() => null)) || {};
  const alias = String(body.alias ?? '').trim().toLowerCase();
  const kind  = String(body.kind ?? '').trim();
  if (!ALIAS_RE.test(alias)) return badReq(res, 'invalid_alias');
  if (!KINDS.has(kind)) return badReq(res, 'invalid_kind');

  const tenantRes = await q(`SELECT 1 FROM iam.tenant WHERE id = $1`, [tenantId]);
  if (tenantRes.rows.length === 0) return notFound(res, 'tenant_not_found');

  try {
    const { rows } = await q(
      `INSERT INTO iam.tenant_alias (alias, tenant_id, kind, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING alias, tenant_id, kind, created_at, created_by`,
      [alias, tenantId, kind, req.user?.sub ?? null],
    );
    req.tenant = req.tenant ?? { id: tenantId };
    recordAudit({
      req,
      action: 'iam.tenant.alias.add',
      resource: 'iam.tenant_alias',
      resourceId: alias,
      payload: { after: rows[0] },
    });
    created(res, rows[0]);
  } catch (err) {
    if (err && err.code === '23505') {
      return send(res, 409, { success: false, error: 'alias_in_use' });
    }
    throw err;
  }
}

// DELETE /iam/tenants/:id/aliases/:alias
export async function remove(req, res, tenantId, alias) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!canManage(req, tenantId)) return forbid(res, 'missing_role');
  const aliasLower = String(alias ?? '').trim().toLowerCase();
  if (!ALIAS_RE.test(aliasLower)) return badReq(res, 'invalid_alias');

  const { rows } = await q(
    `DELETE FROM iam.tenant_alias
       WHERE tenant_id = $1 AND alias = $2
       RETURNING alias, tenant_id, kind`,
    [tenantId, aliasLower],
  );
  if (rows.length === 0) return notFound(res, 'alias_not_found');

  req.tenant = req.tenant ?? { id: tenantId };
  recordAudit({
    req,
    action: 'iam.tenant.alias.remove',
    resource: 'iam.tenant_alias',
    resourceId: aliasLower,
    payload: { before: rows[0] },
  });
  ok(res, rows[0]);
}
