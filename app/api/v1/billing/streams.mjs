// =============================================================================
// /api/v1/billing/streams — named revenue streams (EPIC-005 S2B).
// -----------------------------------------------------------------------------
// Tenant-scoped CRUD over billing.stream. AuthZ gated by `crm.revenue.write`
// (mutations) + `crm.revenue.read` (reads). Every mutation emits recordAudit.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_KIND  = new Set(['subscription','one_time','usage','milestone']);
const VALID_RECUR = new Set(['monthly','quarterly','annual','custom']);

const COLS = `id, tenant_id, key, name, kind, recurrence, currency, active,
              metadata, created_at, updated_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.revenue.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.active === 'true' || qs.active === 'false') {
    params.push(qs.active === 'true');
    where += ` AND active = $${params.length}`;
  }
  if (qs.kind && VALID_KIND.has(qs.kind)) {
    params.push(qs.kind);
    where += ` AND kind = $${params.length}`;
  }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS} FROM billing.stream
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function getOne(req, res, id) {
  if (!requirePermission(req, res, 'crm.revenue.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const { rows } = await q(
    `SELECT ${COLS} FROM billing.stream WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.revenue.write')) return;
  const body = (await readBody(req)) || {};
  const key  = String(body.key  ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const kind = String(body.kind ?? '').trim().toLowerCase();
  if (!key)  return badReq(res, 'key_required');
  if (!name) return badReq(res, 'name_required');
  if (!VALID_KIND.has(kind)) return badReq(res, 'kind_invalid');

  const recur = body.recurrence ? String(body.recurrence).toLowerCase() : null;
  if (recur && !VALID_RECUR.has(recur)) return badReq(res, 'recurrence_invalid');
  const currency = String(body.currency ?? 'USD').toUpperCase();

  try {
    const { rows } = await q(
      `INSERT INTO billing.stream
         (tenant_id, key, name, kind, recurrence, currency, active, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        key,
        name,
        kind,
        recur,
        currency,
        body.active === false ? false : true,
        JSON.stringify(body.metadata ?? {}),
      ],
    );
    const row = rows[0];
    recordAudit({
      req,
      action: 'billing.stream.create',
      resource: 'billing.stream',
      resourceId: row.id,
      payload: { after: row },
    });
    created(res, row);
  } catch (err) {
    if (err?.code === '23505') return badReq(res, 'duplicate_stream_key');
    throw err;
  }
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.revenue.write')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const body = (await readBody(req)) || {};

  const beforeRes = await q(
    `SELECT ${COLS} FROM billing.stream WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (beforeRes.rows.length === 0) return notFound(res);
  const before = beforeRes.rows[0];

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  if (body.name !== undefined)       { fields.push(`name = $${i++}`); params.push(String(body.name)); }
  if (body.kind !== undefined) {
    const k = String(body.kind).toLowerCase();
    if (!VALID_KIND.has(k)) return badReq(res, 'kind_invalid');
    fields.push(`kind = $${i++}`); params.push(k);
  }
  if (body.recurrence !== undefined) {
    const r = body.recurrence == null ? null : String(body.recurrence).toLowerCase();
    if (r != null && !VALID_RECUR.has(r)) return badReq(res, 'recurrence_invalid');
    fields.push(`recurrence = $${i++}`); params.push(r);
  }
  if (body.currency !== undefined)   { fields.push(`currency = $${i++}`); params.push(String(body.currency).toUpperCase()); }
  if (body.active !== undefined)     { fields.push(`active = $${i++}`); params.push(body.active === true); }
  if (body.metadata !== undefined)   { fields.push(`metadata = $${i++}::jsonb`); params.push(JSON.stringify(body.metadata ?? {})); }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const { rows } = await q(
    `UPDATE billing.stream SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  recordAudit({
    req,
    action: 'billing.stream.update',
    resource: 'billing.stream',
    resourceId: id,
    payload: { before, after: rows[0] },
  });
  ok(res, rows[0]);
}
