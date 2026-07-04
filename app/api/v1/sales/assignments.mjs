// =============================================================================
// /api/v1/sales/assignments — polymorphic assignment management (Sprint 1B).
// -----------------------------------------------------------------------------
// Endpoints:
//   GET    /sales/assignments?entity_kind=&entity_id=&user_id=&active=
//   POST   /sales/assignments  { entity_kind, entity_id, user_id, role }
//   DELETE /sales/assignments/:id      (alias for release)
//
// Gates:
//   - reads     → crm.lead.read    (any of the kind-specific read perms would
//                                   also do; lead.read is the common floor)
//   - mutations → crm.lead.assign
//
// Every mutation emits recordAudit() with { before, after } shape.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, created, badReq, notFound, readBody, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_KIND = new Set(['lead','contact','client','opportunity','organization']);
const VALID_ROLE = new Set(['owner','collaborator','support']);

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.lead.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.entity_kind && VALID_KIND.has(qs.entity_kind)) {
    params.push(qs.entity_kind); where += ` AND entity_kind = $${params.length}`;
  }
  if (qs.entity_id && UUID_RE.test(qs.entity_id)) {
    params.push(qs.entity_id); where += ` AND entity_id = $${params.length}`;
  }
  if (qs.user_id && UUID_RE.test(qs.user_id)) {
    params.push(qs.user_id); where += ` AND user_id = $${params.length}`;
  }
  if (qs.active === '1' || qs.active === 'true' || qs.active === undefined) {
    where += ` AND released_at IS NULL`;
  }
  const { rows } = await q(
    `SELECT id, tenant_id, entity_kind, entity_id, user_id, role,
            assigned_at, released_at, assigned_by
       FROM sales.assignment
      WHERE ${where}
      ORDER BY assigned_at DESC`,
    params,
  );
  ok(res, rows);
}

export async function createAssignment(req, res) {
  if (!requirePermission(req, res, 'crm.lead.assign')) return;
  const body = (await readBody(req)) || {};
  const kind = String(body.entity_kind ?? '').trim();
  const eid  = String(body.entity_id   ?? '').trim();
  const uid  = String(body.user_id     ?? '').trim();
  const role = String(body.role        ?? 'owner').trim();
  if (!VALID_KIND.has(kind))            return badReq(res, 'invalid_entity_kind');
  if (!UUID_RE.test(eid))               return badReq(res, 'invalid_entity_id');
  if (!UUID_RE.test(uid))               return badReq(res, 'invalid_user_id');
  if (!VALID_ROLE.has(role))            return badReq(res, 'invalid_role');

  // Guard: user must belong to the same tenant.
  const userGuard = await q(
    `SELECT 1 FROM iam.user_profile WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [uid, req.tenant.id],
  );
  if (userGuard.rows.length === 0) return badReq(res, 'user_not_in_tenant');

  const { rows } = await q(
    `INSERT INTO sales.assignment
       (tenant_id, entity_kind, entity_id, user_id, role, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, entity_kind, entity_id, user_id, role,
               assigned_at, released_at, assigned_by`,
    [req.tenant.id, kind, eid, uid, role, req.user?.sub ?? null],
  );
  recordAudit({
    req,
    action: 'sales.assignment.create',
    resource: 'sales.assignment',
    resourceId: rows[0].id,
    payload: { after: rows[0] },
  });
  created(res, rows[0]);
}

export async function release(req, res, id) {
  if (!requirePermission(req, res, 'crm.lead.assign')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_assignment_id');
  const before = await q(
    `SELECT id, tenant_id, entity_kind, entity_id, user_id, role,
            assigned_at, released_at
       FROM sales.assignment
      WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [id, req.tenant.id],
  );
  if (before.rows.length === 0) return notFound(res);
  const { rows } = await q(
    `UPDATE sales.assignment
        SET released_at = COALESCE(released_at, now())
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, tenant_id, entity_kind, entity_id, user_id, role,
                assigned_at, released_at, assigned_by`,
    [id, req.tenant.id],
  );
  recordAudit({
    req,
    action: 'sales.assignment.release',
    resource: 'sales.assignment',
    resourceId: id,
    payload: { before: before.rows[0], after: rows[0] },
  });
  ok(res, rows[0]);
}
