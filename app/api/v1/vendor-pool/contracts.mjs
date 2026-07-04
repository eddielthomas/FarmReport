// =============================================================================
// /api/v1/vendor-pool/contracts — Sprint 4B P-009 Phase 2.
// -----------------------------------------------------------------------------
// Per-vendor contract envelope CRUD. AuthZ:
//   - reads     : any tenant member (`iam.users.read` OR sales.manager / etc.)
//                 the policy gate is `iam.users.read` to keep the surface tidy.
//   - mutations : `iam.users.manage` (tenant.admin / platform.admin).
//
// Every mutation emits recordAudit + a vendor_pool.contract_event row so the
// append-only event log is the single source of truth for "what happened to
// this contract and when". Activate and revoke also emit `state_changed`
// semantics through the event log (event_kind = activated / revoked).
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_KIND = new Set([
  'sales_partner','data_provider','channel_partner',
  'implementation_partner','repair_partner',
]);
const VALID_STATUS = new Set(['draft','active','expired','revoked']);

const COLS = `id, tenant_id, vendor_user_id, contract_kind, status,
              starts_at, ends_at, signed_at, terms_doc_url, created_at, updated_at`;

// ---- list -------------------------------------------------------------------
export async function list(req, res) {
  if (!requirePermission(req, res, 'iam.users.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.vendor_user_id && UUID_RE.test(qs.vendor_user_id)) {
    params.push(qs.vendor_user_id);
    where += ` AND vendor_user_id = $${params.length}`;
  }
  if (qs.status && VALID_STATUS.has(qs.status)) {
    params.push(qs.status);
    where += ` AND status = $${params.length}`;
  }
  if (qs.contract_kind && VALID_KIND.has(qs.contract_kind)) {
    params.push(qs.contract_kind);
    where += ` AND contract_kind = $${params.length}`;
  }
  const { rows } = await q(
    `SELECT ${COLS} FROM vendor_pool.contract
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 500`,
    params,
  );
  ok(res, rows);
}

// ---- get one ---------------------------------------------------------------
export async function getOne(req, res, id) {
  if (!requirePermission(req, res, 'iam.users.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const { rows } = await q(
    `SELECT ${COLS} FROM vendor_pool.contract
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

// ---- create ----------------------------------------------------------------
export async function create(req, res) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  const body = (await readBody(req)) || {};
  const vendorUserId = String(body.vendor_user_id ?? '').trim();
  const contractKind = String(body.contract_kind ?? '').trim();
  if (!UUID_RE.test(vendorUserId)) return badReq(res, 'invalid_vendor_user_id');
  if (!VALID_KIND.has(contractKind)) return badReq(res, 'invalid_contract_kind');

  // Confirm the vendor_user_id is actually a vendor in this tenant.
  const vp = await q(
    `SELECT 1 FROM iam.vendor_profile
      WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
    [req.tenant.id, vendorUserId],
  );
  if (vp.rows.length === 0) return badReq(res, 'vendor_profile_missing');

  const startsAt = body.starts_at ? new Date(body.starts_at) : new Date();
  const endsAt   = body.ends_at   ? new Date(body.ends_at)   : null;
  const status   = body.status && VALID_STATUS.has(body.status) ? body.status : 'draft';

  const contractRow = await withTx(async (client) => {
    const ins = await client.query(
      `INSERT INTO vendor_pool.contract
         (tenant_id, vendor_user_id, contract_kind, status,
          starts_at, ends_at, signed_at, terms_doc_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLS}`,
      [req.tenant.id, vendorUserId, contractKind, status,
       startsAt, endsAt, body.signed_at ?? null, body.terms_doc_url ?? null],
    );
    const row = ins.rows[0];
    await client.query(
      `INSERT INTO vendor_pool.contract_event
         (tenant_id, contract_id, event_kind, payload, actor_id)
       VALUES ($1, $2, 'created', $3::jsonb, $4)`,
      [req.tenant.id, row.id,
       JSON.stringify({ contract_kind: contractKind, status, starts_at: startsAt, ends_at: endsAt }),
       req.user?.sub ?? null],
    );
    return row;
  });

  recordAudit({
    req,
    action: 'vendor_pool.contract.create',
    resource: 'vendor_pool.contract',
    resourceId: contractRow.id,
    payload: { after: contractRow },
  });
  created(res, contractRow);
}

// ---- update ----------------------------------------------------------------
export async function update(req, res, id) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const body = (await readBody(req)) || {};

  const before = await q(
    `SELECT ${COLS} FROM vendor_pool.contract
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (before.rows.length === 0) return notFound(res);

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  if (body.contract_kind !== undefined) {
    if (!VALID_KIND.has(String(body.contract_kind))) return badReq(res, 'invalid_contract_kind');
    fields.push(`contract_kind = $${i++}`); params.push(body.contract_kind);
  }
  if (body.ends_at !== undefined)       { fields.push(`ends_at = $${i++}`);       params.push(body.ends_at); }
  if (body.signed_at !== undefined)     { fields.push(`signed_at = $${i++}`);     params.push(body.signed_at); }
  if (body.terms_doc_url !== undefined) { fields.push(`terms_doc_url = $${i++}`); params.push(body.terms_doc_url); }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const after = await withTx(async (client) => {
    const upd = await client.query(
      `UPDATE vendor_pool.contract SET ${fields.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COLS}`,
      params,
    );
    await client.query(
      `INSERT INTO vendor_pool.contract_event
         (tenant_id, contract_id, event_kind, payload, actor_id)
       VALUES ($1, $2, 'updated', $3::jsonb, $4)`,
      [req.tenant.id, id,
       JSON.stringify({ before: before.rows[0], after: upd.rows[0] }),
       req.user?.sub ?? null],
    );
    return upd.rows[0];
  });

  recordAudit({
    req,
    action: 'vendor_pool.contract.update',
    resource: 'vendor_pool.contract',
    resourceId: id,
    payload: { before: before.rows[0], after },
  });
  ok(res, after);
}

// ---- activate --------------------------------------------------------------
export async function activate(req, res, id) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const before = await q(
    `SELECT ${COLS} FROM vendor_pool.contract WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (before.rows.length === 0) return notFound(res);
  const cur = before.rows[0];
  if (cur.status === 'active')  return badReq(res, 'already_active');
  if (cur.status === 'revoked') return badReq(res, 'contract_revoked');
  if (!cur.ends_at)             return badReq(res, 'ends_at_required_for_activation');

  const after = await withTx(async (client) => {
    const upd = await client.query(
      `UPDATE vendor_pool.contract
          SET status = 'active', updated_at = now(),
              signed_at = COALESCE(signed_at, now())
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COLS}`,
      [req.tenant.id, id],
    );
    await client.query(
      `INSERT INTO vendor_pool.contract_event
         (tenant_id, contract_id, event_kind, payload, actor_id)
       VALUES ($1, $2, 'activated', $3::jsonb, $4)`,
      [req.tenant.id, id,
       JSON.stringify({ from_status: cur.status, to_status: 'active' }),
       req.user?.sub ?? null],
    );
    return upd.rows[0];
  });

  recordAudit({
    req,
    action: 'vendor_pool.contract.activate',
    resource: 'vendor_pool.contract',
    resourceId: id,
    payload: { before: cur, after },
  });
  ok(res, after);
}

// ---- revoke ----------------------------------------------------------------
export async function revoke(req, res, id) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const before = await q(
    `SELECT ${COLS} FROM vendor_pool.contract WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (before.rows.length === 0) return notFound(res);
  const cur = before.rows[0];
  if (cur.status === 'revoked') return badReq(res, 'already_revoked');

  const after = await withTx(async (client) => {
    const upd = await client.query(
      `UPDATE vendor_pool.contract
          SET status = 'revoked', updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${COLS}`,
      [req.tenant.id, id],
    );
    await client.query(
      `INSERT INTO vendor_pool.contract_event
         (tenant_id, contract_id, event_kind, payload, actor_id)
       VALUES ($1, $2, 'revoked', $3::jsonb, $4)`,
      [req.tenant.id, id,
       JSON.stringify({ from_status: cur.status, to_status: 'revoked' }),
       req.user?.sub ?? null],
    );
    return upd.rows[0];
  });

  recordAudit({
    req,
    action: 'vendor_pool.contract.revoke',
    resource: 'vendor_pool.contract',
    resourceId: id,
    payload: { before: cur, after },
  });
  ok(res, after);
}
