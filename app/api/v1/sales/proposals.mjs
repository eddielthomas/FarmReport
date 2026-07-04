// =============================================================================
// /api/v1/sales/proposals — CRM proposal/quote lifecycle.
// -----------------------------------------------------------------------------
// First-class proposal entity sitting between an opportunity reaching the
// `proposal` stage and a signed contract.
//
// Lifecycle: draft -> sent -> accepted | rejected | expired
//   sent_at    stamped on draft->sent
//   decided_at stamped on the terminal transition
//
// Every read + write runs inside withTenantConn() so the FORCE'd RLS policy on
// sales.proposal binds app.tenant_id. Every mutator emits recordAudit().
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const COLS = `id, tenant_id, opportunity_id, lead_id, title, status, amount,
              currency, valid_until, line_items, notes, created_by,
              created_at, updated_at, sent_at, decided_at`;

const VALID_STATUS = new Set(['draft','sent','accepted','rejected','expired']);

// Allowed status transitions. draft -> sent -> {accepted,rejected,expired}.
const TRANSITIONS = {
  draft:    new Set(['sent','expired']),
  sent:     new Set(['accepted','rejected','expired']),
  accepted: new Set([]),
  rejected: new Set([]),
  expired:  new Set([]),
};

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const rows = await withTenantConn(req, async (client) => {
    const params = [];
    let where = '1=1';
    if (qs.status && VALID_STATUS.has(qs.status)) { params.push(qs.status); where += ` AND status = $${params.length}`; }
    if (qs.opportunity_id) { params.push(qs.opportunity_id); where += ` AND opportunity_id = $${params.length}`; }
    const r = await client.query(
      `SELECT ${COLS} FROM sales.proposal WHERE ${where} ORDER BY created_at DESC`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}

// Optional list scoped to a single opportunity (GET /sales/opportunities/:id/proposals).
export async function listForOpportunity(req, res, opportunityId) {
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM sales.proposal
        WHERE opportunity_id = $1 ORDER BY created_at DESC`,
      [opportunityId],
    );
    return r.rows;
  });
  ok(res, rows);
}

export async function get(req, res, id) {
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(`SELECT ${COLS} FROM sales.proposal WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

export async function create(req, res) {
  const body = (await readBody(req)) || {};
  const title = String(body.title ?? '').trim();
  if (!title) return badReq(res, 'title_required');
  const status = VALID_STATUS.has(body.status) ? body.status : 'draft';
  const lineItems = Array.isArray(body.line_items) ? body.line_items : [];

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO sales.proposal
         (tenant_id, opportunity_id, lead_id, title, status, amount, currency,
          valid_until, line_items, notes, created_by,
          sent_at, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,
               $12,$13)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        body.opportunity_id ?? null,
        body.lead_id ?? null,
        title,
        status,
        body.amount ?? null,
        body.currency ?? 'USD',
        body.valid_until ?? null,
        JSON.stringify(lineItems),
        body.notes ?? null,
        req.user?.sub ?? null,
        status === 'sent' ? new Date().toISOString() : null,
        (status === 'accepted' || status === 'rejected' || status === 'expired') ? new Date().toISOString() : null,
      ],
    );
    recordAudit({ req, action: 'create', resource: 'sales.proposal', resourceId: r.rows[0].id, payload: { after: r.rows[0] } });
    return r.rows[0];
  });
  created(res, row);
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  const result = await withTenantConn(req, async (client) => {
    const fields = []; const params = [id]; let i = 2;
    const changing = [];
    for (const k of ['title','amount','currency','valid_until','notes','opportunity_id','lead_id']) {
      if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); changing.push(k); }
    }
    if (body.line_items !== undefined) {
      fields.push(`line_items = $${i++}::jsonb`);
      params.push(JSON.stringify(Array.isArray(body.line_items) ? body.line_items : []));
      changing.push('line_items');
    }
    if (fields.length === 0) return { kind: 'no_fields' };
    const beforeRes = await client.query(`SELECT ${COLS} FROM sales.proposal WHERE id = $1`, [id]);
    const before = beforeRes.rows[0] ?? null;
    if (!before) return { kind: 'not_found' };
    fields.push('updated_at = now()');
    const r = await client.query(
      `UPDATE sales.proposal SET ${fields.join(', ')} WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    recordAudit({ req, action: 'update', resource: 'sales.proposal', resourceId: id, payload: { before, after: r.rows[0], fields: changing } });
    return { kind: 'ok', row: r.rows[0] };
  });
  if (result.kind === 'no_fields') return badReq(res, 'no_fields_to_update');
  if (result.kind === 'not_found') return notFound(res);
  ok(res, result.row);
}

// POST /sales/proposals/:id/status — body { to_status | status }.
export async function changeStatus(req, res, id) {
  const body = (await readBody(req)) || {};
  const to = String(body.to_status ?? body.status ?? '').trim();
  if (!VALID_STATUS.has(to)) return badReq(res, 'invalid_to_status');

  const result = await withTenantConn(req, async (client) => {
    const cur = await client.query(
      `SELECT ${COLS} FROM sales.proposal WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rows.length === 0) return { kind: 'not_found' };
    const from = cur.rows[0].status;
    if (from === to) return { kind: 'ok', row: cur.rows[0], from, noop: true };
    if (!TRANSITIONS[from]?.has(to)) return { kind: 'bad_transition', from };

    const sentAt = to === 'sent' ? new Date().toISOString() : null;
    const decidedAt = (to === 'accepted' || to === 'rejected' || to === 'expired') ? new Date().toISOString() : null;
    const r = await client.query(
      `UPDATE sales.proposal
          SET status = $2,
              sent_at    = COALESCE($3::timestamptz, sent_at),
              decided_at = COALESCE($4::timestamptz, decided_at),
              updated_at = now()
        WHERE id = $1
       RETURNING ${COLS}`,
      [id, to, sentAt, decidedAt],
    );
    recordAudit({
      req, action: 'status_change', resource: 'sales.proposal', resourceId: id,
      payload: { from_status: from, to_status: to, after: r.rows[0] },
    });
    return { kind: 'ok', row: r.rows[0], from };
  });

  if (result.kind === 'not_found') return notFound(res);
  if (result.kind === 'bad_transition') return badReq(res, `invalid_transition_${result.from}_to_${to}`);
  ok(res, result.row);
}
