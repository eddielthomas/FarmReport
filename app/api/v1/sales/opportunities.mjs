// =============================================================================
// /api/v1/sales/opportunities — pipeline stage tracking.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const COLS = `id, tenant_id, lead_id, name, stage, amount, close_date, owner_id, created_at, updated_at`;
const VALID_STAGE = new Set(['discovery','qualified','proposal','won','lost']);

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.stage && VALID_STAGE.has(qs.stage)) { params.push(qs.stage); where += ` AND stage = $${params.length}`; }
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.opportunity WHERE ${where} ORDER BY created_at DESC`,
    params,
  );
  ok(res, rows);
}

export async function create(req, res) {
  const body = (await readBody(req)) || {};
  const name = String(body.name ?? '').trim();
  if (!name) return badReq(res, 'name_required');
  const stage = VALID_STAGE.has(body.stage) ? body.stage : 'discovery';
  const { rows } = await q(
    `INSERT INTO sales.opportunity (tenant_id, lead_id, name, stage, amount, close_date, owner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
    [
      req.tenant.id,
      body.lead_id ?? null,
      name,
      stage,
      Number(body.amount ?? 0),
      body.close_date ?? null,
      body.owner_id ?? null,
    ],
  );
  recordAudit({ req, action: 'create', resource: 'sales.opportunity', resourceId: rows[0].id, payload: { after: rows[0] } });
  created(res, rows[0]);
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  const changing = [];
  for (const k of ['name','amount','close_date','owner_id','lead_id']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); changing.push(k); }
  }
  if (body.stage !== undefined) {
    if (!VALID_STAGE.has(body.stage)) return badReq(res, 'invalid_stage');
    fields.push(`stage = $${i++}`); params.push(body.stage); changing.push('stage');
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  const beforeRes = await q(`SELECT ${COLS} FROM sales.opportunity WHERE tenant_id = $1 AND id = $2`, [req.tenant.id, id]);
  const before = beforeRes.rows[0] ?? null;
  fields.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE sales.opportunity SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'update', resource: 'sales.opportunity', resourceId: id, payload: { before, after: rows[0], fields: changing } });
  ok(res, rows[0]);
}
