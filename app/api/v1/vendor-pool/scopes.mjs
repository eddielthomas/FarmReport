// =============================================================================
// /api/v1/vendor-pool/scopes — Sprint 4B P-009 Phase 2.
// -----------------------------------------------------------------------------
// Scope CRUD on vendor_pool.scope. Routes:
//   POST   /vendor-pool/contracts/:id/scopes
//   DELETE /vendor-pool/contracts/:id/scopes/:scopeId
//
// AuthZ: `iam.users.manage` (tenant.admin or platform.admin). Every mutation
// emits recordAudit() and a contract_event row (insert -> 'scope_added';
// delete -> 'scope_revoked', the latter written by the BEFORE-DELETE trigger
// on vendor_pool.scope itself, so we only emit recordAudit here).
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLS = `id, tenant_id, contract_id, resource_type, resource_id,
              permission_key, starts_at, ends_at, created_at`;

export async function addScope(req, res, contractId) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(contractId)) return badReq(res, 'invalid_contract_id');
  const body = (await readBody(req)) || {};
  const resourceType = String(body.resource_type ?? '').trim();
  const permissionKey = String(body.permission_key ?? '').trim();
  if (!resourceType) return badReq(res, 'resource_type_required');
  if (!permissionKey) return badReq(res, 'permission_key_required');
  const resourceId = body.resource_id ? String(body.resource_id) : null;
  if (resourceId && !UUID_RE.test(resourceId)) return badReq(res, 'invalid_resource_id');

  // Confirm contract belongs to this tenant.
  const con = await q(
    `SELECT id, status FROM vendor_pool.contract
      WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [req.tenant.id, contractId],
  );
  if (con.rows.length === 0) return notFound(res);

  let row;
  try {
    row = await withTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO vendor_pool.scope
           (tenant_id, contract_id, resource_type, resource_id,
            permission_key, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
         RETURNING ${COLS}`,
        [req.tenant.id, contractId, resourceType, resourceId,
         permissionKey, body.starts_at ?? null, body.ends_at ?? null],
      );
      await client.query(
        `INSERT INTO vendor_pool.contract_event
           (tenant_id, contract_id, event_kind, payload, actor_id)
         VALUES ($1, $2, 'scope_added', $3::jsonb, $4)`,
        [req.tenant.id, contractId,
         JSON.stringify({ scope_id: ins.rows[0].id, resource_type: resourceType,
                          resource_id: resourceId, permission_key: permissionKey }),
         req.user?.sub ?? null],
      );
      return ins.rows[0];
    });
  } catch (err) {
    if (err?.code === '23503') return badReq(res, 'permission_key_unknown');
    throw err;
  }

  recordAudit({
    req,
    action: 'vendor_pool.scope.add',
    resource: 'vendor_pool.scope',
    resourceId: row.id,
    payload: { after: row },
  });
  created(res, row);
}

export async function removeScope(req, res, contractId, scopeId) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(contractId) || !UUID_RE.test(scopeId)) return badReq(res, 'invalid_id');

  const before = await q(
    `SELECT ${COLS} FROM vendor_pool.scope
      WHERE tenant_id = $1 AND contract_id = $2 AND id = $3 LIMIT 1`,
    [req.tenant.id, contractId, scopeId],
  );
  if (before.rows.length === 0) return notFound(res);

  // The BEFORE-DELETE trigger fn_scope_delete_audit writes the
  // contract_event(kind='scope_revoked') row. We still emit recordAudit so the
  // mutation coverage gate is satisfied on this exported handler.
  await q(
    `DELETE FROM vendor_pool.scope
      WHERE tenant_id = $1 AND contract_id = $2 AND id = $3`,
    [req.tenant.id, contractId, scopeId],
  );

  recordAudit({
    req,
    action: 'vendor_pool.scope.revoke',
    resource: 'vendor_pool.scope',
    resourceId: scopeId,
    payload: { before: before.rows[0] },
  });
  ok(res, { id: scopeId, removed: true });
}
