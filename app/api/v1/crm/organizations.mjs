// =============================================================================
// /api/v1/crm/organizations — first-class firmographic entity (EPIC-003 P-003).
// -----------------------------------------------------------------------------
// Tenant-scoped via req.tenant.id; RBAC-gated via crm.organization.read/write.
// All mutations emit recordAudit + a sales.activity row.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';

const COLS = `id, tenant_id, name, domain, industry, size_band, address, website,
              parent_org_id, status, source, notes, created_at, updated_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.organization.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.q) {
    params.push(`%${String(qs.q).toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(domain,'')) LIKE $${params.length})`;
  }
  if (qs.status) { params.push(qs.status); where += ` AND status = $${params.length}`; }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.organization
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.organization.read')) return;
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.organization WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.organization.write')) return;
  const body = (await readBody(req)) || {};
  const name = String(body.name ?? '').trim();
  if (!name) return badReq(res, 'name_required');
  try {
    const { rows } = await q(
      `INSERT INTO sales.organization
         (tenant_id, name, domain, industry, size_band, address, website,
          parent_org_id, status, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        name,
        body.domain ?? null,
        body.industry ?? null,
        body.size_band ?? null,
        JSON.stringify(body.address ?? {}),
        body.website ?? null,
        body.parent_org_id ?? null,
        body.status ?? 'active',
        body.source ?? null,
        body.notes ?? null,
      ],
    );
    const row = rows[0];
    recordAudit({
      req, action: 'crm.organization.create',
      resource: 'sales.organization', resourceId: row.id,
      payload: { after: row },
    });
    emitActivity({
      tenantId: req.tenant.id,
      entityKind: 'organization', entityId: row.id,
      kind: 'system', source: 'system',
      actorId: req.user?.sub ?? null,
      actorLabel: req.user?.email ?? null,
      text: `Organization created: ${row.name}`,
      metadata: { action: 'create' },
    }).catch(() => {});
    created(res, row);
  } catch (err) {
    if (err?.code === '23505') return badReq(res, 'duplicate_organization');
    throw err;
  }
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.organization.write')) return;
  const body = (await readBody(req)) || {};
  const beforeRes = await q(
    `SELECT ${COLS} FROM sales.organization WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (beforeRes.rows.length === 0) return notFound(res);
  const before = beforeRes.rows[0];

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  for (const k of ['name','domain','industry','size_band','website','parent_org_id','status','source','notes']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
  }
  if (body.address !== undefined) {
    fields.push(`address = $${i++}::jsonb`); params.push(JSON.stringify(body.address));
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const { rows } = await q(
    `UPDATE sales.organization SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  recordAudit({
    req, action: 'crm.organization.update',
    resource: 'sales.organization', resourceId: id,
    payload: { before, after: rows[0] },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'organization', entityId: id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Organization updated`,
    metadata: { action: 'update' },
  }).catch(() => {});
  ok(res, rows[0]);
}
