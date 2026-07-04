// =============================================================================
// /api/v1/crm/revenue-records — billing stream entity (EPIC-003 P-003).
// -----------------------------------------------------------------------------
// Tenant-scoped; RBAC-gated via crm.revenue.read/write.
// Reads run through applyFieldMask so masked roles (e.g. vendor.viewer) never
// see the raw amount. DELETE is blocked at the DB layer; corrections happen
// via offsetting rows (status='refunded' / 'credited').
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { applyFieldMask } from '../middleware/fieldMask.mjs';
import { emitActivity, publishStateChanged } from '../lib/activity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = new Set(['booked','recognized','invoiced','paid','refunded','credited']);

const COLS = `id, tenant_id, client_lead_id, organization_id, opportunity_id,
              product_id, amount, currency, billing_period_start, billing_period_end,
              recognized_at, status::text AS status, invoice_ref, external_ref,
              metadata, created_by, created_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.revenue.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.client_lead_id && UUID_RE.test(qs.client_lead_id)) {
    params.push(qs.client_lead_id); where += ` AND client_lead_id = $${params.length}`;
  }
  if (qs.status && VALID_STATUS.has(qs.status)) {
    params.push(qs.status); where += ` AND status = $${params.length}::sales.revenue_status_t`;
  }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.revenue_record
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  const masked = await applyFieldMask(req, 'revenue_record', rows);
  ok(res, masked);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.revenue.read')) return;
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.revenue_record WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  const masked = await applyFieldMask(req, 'revenue_record', rows);
  ok(res, masked[0]);
}

export async function listByClient(req, res, leadId) {
  if (!requirePermission(req, res, 'crm.revenue.read')) return;
  if (!UUID_RE.test(leadId)) return badReq(res, 'invalid_lead_id');
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.revenue_record
      WHERE tenant_id = $1 AND client_lead_id = $2
      ORDER BY created_at DESC`,
    [req.tenant.id, leadId],
  );
  const masked = await applyFieldMask(req, 'revenue_record', rows);
  ok(res, masked);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.revenue.write')) return;
  const body = (await readBody(req)) || {};
  const clientId = body.client_id ?? body.client_lead_id ?? null;
  const amount   = Number(body.amount ?? NaN);
  if (!clientId || !UUID_RE.test(String(clientId))) return badReq(res, 'client_id_required');
  if (!Number.isFinite(amount)) return badReq(res, 'amount_required');
  const status = VALID_STATUS.has(body.status) ? body.status : 'booked';

  // Guard: lead exists in tenant
  const guard = await q(
    `SELECT 1 FROM sales.lead WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, clientId],
  );
  if (guard.rows.length === 0) return notFound(res, 'lead_not_found');

  const { rows } = await q(
    `INSERT INTO sales.revenue_record
       (tenant_id, client_lead_id, organization_id, opportunity_id, product_id,
        amount, currency, billing_period_start, billing_period_end,
        recognized_at, status, invoice_ref, external_ref, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11::sales.revenue_status_t,$12,$13,$14::jsonb,$15)
     RETURNING ${COLS}`,
    [
      req.tenant.id, clientId,
      body.organization_id ?? null,
      body.opportunity_id ?? null,
      body.product_id ?? null,
      amount,
      body.currency ?? 'USD',
      body.billing_period_start ?? null,
      body.billing_period_end ?? null,
      body.recognized_at ?? null,
      status,
      body.invoice_ref ?? null,
      body.external_ref ?? null,
      JSON.stringify(body.metadata ?? {}),
      req.user?.sub ?? null,
    ],
  );
  const row = rows[0];
  recordAudit({
    req, action: 'crm.revenue.create',
    resource: 'sales.revenue_record', resourceId: row.id,
    payload: { after: row },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'revenue_record', entityId: row.id,
    kind: 'revenue', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Revenue ${status}: ${row.amount} ${row.currency}`,
    metadata: { action: 'create', client_lead_id: row.client_lead_id, status },
  }).catch(() => {});
  // Mirror on the client lead's timeline as well.
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'lead', entityId: row.client_lead_id,
    kind: 'revenue', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Revenue ${status}: ${row.amount} ${row.currency}`,
    metadata: { action: 'create', revenue_id: row.id, status },
  }).catch(() => {});
  publishStateChanged({
    tenantId: req.tenant.id,
    entityKind: 'revenue_record', entityId: row.id,
    fromState: null, toState: status,
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    kind: 'revenue',
    metadata: { event: 'revenue.create' },
  }).catch(() => {});
  created(res, row);
}
