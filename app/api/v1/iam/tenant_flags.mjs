// =============================================================================
// /api/v1/iam/tenant_flags — per-tenant feature flag CRUD.
// -----------------------------------------------------------------------------
//   GET /iam/tenants/:id/flags        → { flags: {...} } merged JSONB + rows
//   PUT /iam/tenants/:id/flags        { set: {...}, unset: ["..."] }
//
// AuthZ: platform.admin OR tenant.admin of `:id`. Tenant.admin is identified
// today by the role 'platform:admin' OR by an explicit 'iam.tenant.flags.manage'
// role (P-002 will introduce this as a dynamic role). For now we accept
// platform:admin only.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, badReq, notFound, forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { invalidateFlags } from '../middleware/flags.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canManage(req, tenantId) {
  const roles = req?.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  // Tenant.admin scope check — must match the resolved req.tenant.
  if (req?.tenant?.id === tenantId && roles.includes('iam.tenant.flags.manage')) return true;
  return false;
}

async function readFlags(tenantId) {
  const baseRes = await q(
    `SELECT feature_flags FROM iam.tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  if (baseRes.rows.length === 0) return null;
  const base = baseRes.rows[0].feature_flags ?? {};
  const rowsRes = await q(
    `SELECT key, value FROM iam.tenant_feature_flag WHERE tenant_id = $1`,
    [tenantId],
  );
  const overrides = {};
  for (const r of rowsRes.rows) overrides[r.key] = r.value;
  return { ...base, ...overrides };
}

// GET /iam/tenants/:id/flags
export async function get(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!canManage(req, tenantId)) return forbid(res, 'missing_role');
  const flags = await readFlags(tenantId);
  if (flags === null) return notFound(res, 'tenant_not_found');
  ok(res, { flags });
}

// PUT /iam/tenants/:id/flags { set: {...}, unset: ["..."] }
export async function put(req, res, tenantId) {
  if (!UUID_RE.test(tenantId)) return badReq(res, 'invalid_tenant_id');
  if (!canManage(req, tenantId)) return forbid(res, 'missing_role');
  const body = (await readBody(req).catch(() => null)) || {};
  const set   = body.set   && typeof body.set   === 'object' && !Array.isArray(body.set) ? body.set : null;
  const unset = Array.isArray(body.unset) ? body.unset.map((k) => String(k)) : [];
  if (!set && unset.length === 0) return badReq(res, 'no_changes');

  const before = await readFlags(tenantId);
  if (before === null) return notFound(res, 'tenant_not_found');

  const fieldsChanged = [];

  await withTx(async (client) => {
    if (set) {
      for (const [k, v] of Object.entries(set)) {
        fieldsChanged.push(k);
        await client.query(
          `INSERT INTO iam.tenant_feature_flag (tenant_id, key, value, updated_by, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
           ON CONFLICT (tenant_id, key) DO UPDATE
             SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenantId, String(k), JSON.stringify(v), req.user?.sub ?? null],
        );
      }
    }
    if (unset.length > 0) {
      for (const k of unset) fieldsChanged.push(k);
      await client.query(
        `DELETE FROM iam.tenant_feature_flag WHERE tenant_id = $1 AND key = ANY($2)`,
        [tenantId, unset],
      );
    }
  });

  invalidateFlags(tenantId);
  const after = await readFlags(tenantId);

  // Stamp req.tenant so the audit row attributes to the target tenant.
  req.tenant = req.tenant ?? { id: tenantId };
  recordAudit({
    req,
    action: 'iam.tenant.flag.update',
    resource: 'iam.tenant_feature_flag',
    resourceId: tenantId,
    payload: { before, after, fields: fieldsChanged },
  });

  ok(res, { flags: after });
}
