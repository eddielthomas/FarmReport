// =============================================================================
// /api/v1/sales/contracts — CRM contract lifecycle + proposal conversion.
// -----------------------------------------------------------------------------
// The closing artifact of the CRM pipeline. Minted from an accepted
// sales.proposal (POST /sales/proposals/:id/convert) or created standalone.
// Carries a per-tenant human reference CTR-<year>-<seq>.
//
// Lifecycle: draft -> active -> signed -> expired | terminated
//   signed_at stamped on the ->signed transition.
//
// Every read + write runs inside withTenantConn() so the FORCE'd RLS policy on
// sales.contract binds app.tenant_id. Every mutator emits recordAudit().
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const COLS = `id, tenant_id, proposal_id, opportunity_id, customer_id,
              contract_number, title, status, value, currency,
              start_date, end_date, signed_at, document_ref, created_by,
              created_at, updated_at`;

const VALID_STATUS = new Set(['draft','active','signed','expired','terminated']);

const TRANSITIONS = {
  draft:      new Set(['active','terminated']),
  active:     new Set(['signed','expired','terminated']),
  signed:     new Set(['expired','terminated']),
  expired:    new Set([]),
  terminated: new Set([]),
};

// Mint CTR-<year>-<seq> via the per-tenant sequence helper. Returns the string.
async function mintContractNumber(client, tenantId) {
  const year = new Date().getUTCFullYear();
  const r = await client.query('SELECT sales.next_contract_number($1, $2) AS seq', [tenantId, year]);
  const seq = Number(r.rows[0].seq);
  return `CTR-${year}-${String(seq).padStart(6, '0')}`;
}

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const rows = await withTenantConn(req, async (client) => {
    const params = [];
    let where = '1=1';
    if (qs.status && VALID_STATUS.has(qs.status)) { params.push(qs.status); where += ` AND status = $${params.length}`; }
    if (qs.proposal_id) { params.push(qs.proposal_id); where += ` AND proposal_id = $${params.length}`; }
    if (qs.opportunity_id) { params.push(qs.opportunity_id); where += ` AND opportunity_id = $${params.length}`; }
    const r = await client.query(
      `SELECT ${COLS} FROM sales.contract WHERE ${where} ORDER BY created_at DESC`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}

export async function get(req, res, id) {
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(`SELECT ${COLS} FROM sales.contract WHERE id = $1`, [id]);
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

  const row = await withTenantConn(req, async (client) => {
    const number = await mintContractNumber(client, req.tenant.id);
    const r = await client.query(
      `INSERT INTO sales.contract
         (tenant_id, proposal_id, opportunity_id, customer_id, contract_number,
          title, status, value, currency, start_date, end_date, signed_at,
          document_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        body.proposal_id ?? null,
        body.opportunity_id ?? null,
        body.customer_id ?? null,
        number,
        title,
        status,
        body.value ?? null,
        body.currency ?? 'USD',
        body.start_date ?? null,
        body.end_date ?? null,
        status === 'signed' ? new Date().toISOString() : null,
        body.document_ref ?? null,
        req.user?.sub ?? null,
      ],
    );
    recordAudit({ req, action: 'create', resource: 'sales.contract', resourceId: r.rows[0].id, payload: { after: r.rows[0] } });
    return r.rows[0];
  });
  created(res, row);
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  const result = await withTenantConn(req, async (client) => {
    const fields = []; const params = [id]; let i = 2;
    const changing = [];
    for (const k of ['title','value','currency','start_date','end_date','document_ref','customer_id','proposal_id','opportunity_id']) {
      if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); changing.push(k); }
    }
    if (fields.length === 0) return { kind: 'no_fields' };
    const beforeRes = await client.query(`SELECT ${COLS} FROM sales.contract WHERE id = $1`, [id]);
    const before = beforeRes.rows[0] ?? null;
    if (!before) return { kind: 'not_found' };
    fields.push('updated_at = now()');
    const r = await client.query(
      `UPDATE sales.contract SET ${fields.join(', ')} WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    recordAudit({ req, action: 'update', resource: 'sales.contract', resourceId: id, payload: { before, after: r.rows[0], fields: changing } });
    return { kind: 'ok', row: r.rows[0] };
  });
  if (result.kind === 'no_fields') return badReq(res, 'no_fields_to_update');
  if (result.kind === 'not_found') return notFound(res);
  ok(res, result.row);
}

// POST /sales/contracts/:id/status — body { to_status | status }.
export async function changeStatus(req, res, id) {
  const body = (await readBody(req)) || {};
  const to = String(body.to_status ?? body.status ?? '').trim();
  if (!VALID_STATUS.has(to)) return badReq(res, 'invalid_to_status');

  const result = await withTenantConn(req, async (client) => {
    const cur = await client.query(
      `SELECT ${COLS} FROM sales.contract WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rows.length === 0) return { kind: 'not_found' };
    const from = cur.rows[0].status;
    if (from === to) return { kind: 'ok', row: cur.rows[0], from, noop: true };
    if (!TRANSITIONS[from]?.has(to)) return { kind: 'bad_transition', from };

    const signedAt = to === 'signed' ? new Date().toISOString() : null;
    const r = await client.query(
      `UPDATE sales.contract
          SET status = $2,
              signed_at  = COALESCE($3::timestamptz, signed_at),
              updated_at = now()
        WHERE id = $1
       RETURNING ${COLS}`,
      [id, to, signedAt],
    );
    recordAudit({
      req, action: 'status_change', resource: 'sales.contract', resourceId: id,
      payload: { from_status: from, to_status: to, after: r.rows[0] },
    });
    return { kind: 'ok', row: r.rows[0], from };
  });

  if (result.kind === 'not_found') return notFound(res);
  if (result.kind === 'bad_transition') return badReq(res, `invalid_transition_${result.from}_to_${to}`);
  ok(res, result.row);
}

// POST /sales/proposals/:id/convert — mint a draft contract from an accepted
// proposal. Inherits opportunity_id, amount->value, currency, title. The
// proposal MUST be in `accepted` state. Idempotent-ish: if a contract already
// links this proposal we return it (200) instead of minting a duplicate.
export async function convertFromProposal(req, res, proposalId) {
  const body = (await readBody(req)) || {};
  const result = await withTenantConn(req, async (client) => {
    const pr = await client.query(
      `SELECT id, tenant_id, opportunity_id, lead_id, title, status, amount, currency
         FROM sales.proposal WHERE id = $1`,
      [proposalId],
    );
    if (pr.rows.length === 0) return { kind: 'not_found' };
    const proposal = pr.rows[0];
    if (proposal.status !== 'accepted') return { kind: 'not_accepted', status: proposal.status };

    const existing = await client.query(
      `SELECT ${COLS} FROM sales.contract WHERE proposal_id = $1 LIMIT 1`,
      [proposalId],
    );
    if (existing.rows.length > 0) return { kind: 'exists', row: existing.rows[0] };

    const number = await mintContractNumber(client, req.tenant.id);
    const r = await client.query(
      `INSERT INTO sales.contract
         (tenant_id, proposal_id, opportunity_id, customer_id, contract_number,
          title, status, value, currency, document_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        proposal.id,
        proposal.opportunity_id ?? null,
        body.customer_id ?? null,
        number,
        body.title ?? proposal.title,
        proposal.amount ?? null,
        proposal.currency ?? 'USD',
        body.document_ref ?? null,
        req.user?.sub ?? null,
      ],
    );
    recordAudit({
      req, action: 'convert', resource: 'sales.contract', resourceId: r.rows[0].id,
      payload: { from_proposal: proposalId, after: r.rows[0] },
    });
    return { kind: 'ok', row: r.rows[0] };
  });

  if (result.kind === 'not_found') return notFound(res);
  if (result.kind === 'not_accepted') return badReq(res, `proposal_not_accepted_${result.status}`);
  if (result.kind === 'exists') return ok(res, result.row);
  created(res, result.row);
}
