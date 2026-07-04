// =============================================================================
// /api/v1/crm/vendors — vendor / source attribution (EPIC-003 P-003).
// -----------------------------------------------------------------------------
// Tenant-scoped; RBAC-gated via crm.vendor.read/write. All mutations emit
// recordAudit + sales.activity.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';

const COLS = `id, tenant_id, name, contact_email, contact_phone,
              payout_terms, payout_pct, status, notes, created_at, updated_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.vendor.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.status) { params.push(qs.status); where += ` AND status = $${params.length}`; }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.vendor
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.vendor.read')) return;
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.vendor WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.vendor.write')) return;
  const body = (await readBody(req)) || {};
  const name = String(body.name ?? '').trim();
  if (!name) return badReq(res, 'name_required');
  try {
    const { rows } = await q(
      `INSERT INTO sales.vendor
         (tenant_id, name, contact_email, contact_phone, payout_terms,
          payout_pct, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        name,
        body.contact_email ?? null,
        body.contact_phone ?? null,
        body.payout_terms ?? null,
        body.payout_pct ?? null,
        body.status ?? 'active',
        body.notes ?? null,
      ],
    );
    const row = rows[0];
    recordAudit({
      req, action: 'crm.vendor.create',
      resource: 'sales.vendor', resourceId: row.id,
      payload: { after: row },
    });
    emitActivity({
      tenantId: req.tenant.id,
      entityKind: 'vendor', entityId: row.id,
      kind: 'system', source: 'system',
      actorId: req.user?.sub ?? null,
      actorLabel: req.user?.email ?? null,
      text: `Vendor created: ${row.name}`,
      metadata: { action: 'create' },
    }).catch(() => {});
    created(res, row);
  } catch (err) {
    if (err?.code === '23505') return badReq(res, 'duplicate_vendor_name');
    throw err;
  }
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.vendor.write')) return;
  const body = (await readBody(req)) || {};
  const beforeRes = await q(
    `SELECT ${COLS} FROM sales.vendor WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (beforeRes.rows.length === 0) return notFound(res);
  const before = beforeRes.rows[0];

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  for (const k of ['name','contact_email','contact_phone','payout_terms','payout_pct','status','notes']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const { rows } = await q(
    `UPDATE sales.vendor SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  recordAudit({
    req, action: 'crm.vendor.update',
    resource: 'sales.vendor', resourceId: id,
    payload: { before, after: rows[0] },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'vendor', entityId: id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Vendor updated`,
    metadata: { action: 'update' },
  }).catch(() => {});
  ok(res, rows[0]);
}
