// =============================================================================
// /api/v1/sales/leads — full CRUD + status lifecycle.
// -----------------------------------------------------------------------------
// All queries are tenant-scoped via req.tenant.id. Status transitions also
// write a sales.status_history row and merge a `convertedToLeadAt` /
// `convertedToClientAt` timestamp into lead.status_timestamps so the UI can
// render the same conversion timeline as the Figma Make project.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { listLeads as repoListLeads, getLeadById as repoGetLeadById } from './crmRepo.mjs';
import { emitActivity, publishStateChanged } from '../lib/activity.mjs';
import { notifyLeadCreated, notifyLeadStatusChanged } from '../email/notify.mjs';

const COLS = `id, tenant_id, name, email, phone, company, position, status, source,
              source_details, interest, total_revenue, status_timestamps,
              selected_products, organization_id, primary_contact_id, vendor_id,
              archived_at, archived_reason, created_at, updated_at`;

// Sprint 2A — 5-value lifecycle vocabulary.
const VALID_STATUS = new Set(['Info Request', 'Lead', 'Client', 'Archived', 'Contact Only']);

function statusTimestampKey(toStatus) {
  if (toStatus === 'Lead')         return 'convertedToLeadAt';
  if (toStatus === 'Client')       return 'convertedToClientAt';
  if (toStatus === 'Archived')     return 'archivedAt';
  if (toStatus === 'Contact Only') return 'markedContactOnlyAt';
  return 'infoRequestedAt';
}

// Lookup-or-create sales.organization from a free-text company string.
// Returns the org id (or null when company is empty). Errors are swallowed
// and we return null so the lead create still succeeds.
async function lookupOrCreateOrg(tenantId, company) {
  if (!company) return null;
  const name = String(company).trim();
  if (!name) return null;
  try {
    const hit = await q(
      `SELECT id FROM sales.organization
        WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [tenantId, name],
    );
    if (hit.rows.length) return hit.rows[0].id;
    const ins = await q(
      `INSERT INTO sales.organization (tenant_id, name, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (tenant_id, lower(name)) DO NOTHING
       RETURNING id`,
      [tenantId, name],
    );
    if (ins.rows.length) return ins.rows[0].id;
    // Conflict swallowed by ON CONFLICT — fetch the existing row.
    const re = await q(
      `SELECT id FROM sales.organization
        WHERE tenant_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [tenantId, name],
    );
    return re.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[leads] lookupOrCreateOrg_failed:', err?.message ?? err);
    return null;
  }
}

// Lookup-or-create sales.contact keyed on (tenant, lower(email)). Returns the
// contact id; null on failure / empty email. Best-effort.
async function lookupOrCreateContact(tenantId, body, orgId) {
  const email = body.email ? String(body.email).trim() : null;
  if (!email) return null;
  try {
    const hit = await q(
      `SELECT id FROM sales.contact
        WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
      [tenantId, email],
    );
    if (hit.rows.length) return hit.rows[0].id;
    const first = body.name ? String(body.name).split(/\s+/)[0] : null;
    const last  = body.name ? String(body.name).split(/\s+/).slice(1).join(' ') || null : null;
    const ins = await q(
      `INSERT INTO sales.contact
         (tenant_id, organization_id, first_name, last_name, email, phone, title, position, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
       ON CONFLICT (tenant_id, lower(email)) DO NOTHING
       RETURNING id`,
      [tenantId, orgId, first, last, email, body.phone ?? null, body.position ?? null, body.position ?? null],
    );
    if (ins.rows.length) return ins.rows[0].id;
    const re = await q(
      `SELECT id FROM sales.contact
        WHERE tenant_id = $1 AND lower(email) = lower($2) LIMIT 1`,
      [tenantId, email],
    );
    return re.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[leads] lookupOrCreateContact_failed:', err?.message ?? err);
    return null;
  }
}

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const status = qs.status;
  const limit = Math.min(Number(qs.limit ?? 500), 1000);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const contactId = qs.contact_id && UUID_RE.test(qs.contact_id) ? qs.contact_id : undefined;
  // Route through crmRepo so visibility branches on data.read.global vs the
  // sales.assignment EXISTS subquery. Field-mask is applied inside the repo.
  // S7C — supports ?contact_id=<uuid> so the customer portal can join its
  // own contact row to the originating lead when no assignment exists yet.
  const rows = await repoListLeads(req, {
    limit,
    status: status && VALID_STATUS.has(status) ? status : undefined,
    contactId,
  });
  ok(res, rows);
}

export async function get(req, res, id) {
  const row = await repoGetLeadById(req, id);
  if (!row) return notFound(res);
  ok(res, row);
}

export async function create(req, res) {
  const body = (await readBody(req)) || {};
  const name = String(body.name ?? '').trim();
  if (!name) return badReq(res, 'name_required');

  const status = VALID_STATUS.has(body.status) ? body.status : 'Info Request';
  const stamps = { [statusTimestampKey(status)]: new Date().toISOString() };

  // Sprint 2A — lookup-or-create Organization + Contact from the lead body.
  const orgId     = await lookupOrCreateOrg(req.tenant.id, body.company);
  const contactId = await lookupOrCreateContact(req.tenant.id, body, orgId);

  const { rows } = await q(
    `INSERT INTO sales.lead
       (tenant_id, name, email, phone, company, position, status, source,
        source_details, interest, status_timestamps,
        organization_id, primary_contact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     RETURNING ${COLS}`,
    [
      req.tenant.id,
      name,
      body.email ?? null,
      body.phone ?? null,
      body.company ?? null,
      body.position ?? null,
      status,
      body.source ?? null,
      body.source_details ?? null,
      body.interest ?? null,
      JSON.stringify(stamps),
      orgId,
      contactId,
    ],
  );
  const row = rows[0];

  // Link contact <-> lead in the m:n table.
  if (contactId) {
    await q(
      `INSERT INTO sales.contact_lead (tenant_id, contact_id, lead_id, role, linked_by)
       VALUES ($1, $2, $3, 'primary', $4)
       ON CONFLICT (tenant_id, contact_id, lead_id) DO NOTHING`,
      [req.tenant.id, contactId, row.id, req.user?.sub ?? null],
    ).catch(() => {});
  }

  recordAudit({
    req, action: 'create', resource: 'sales.lead', resourceId: row.id,
    payload: { status, organization_id: orgId, primary_contact_id: contactId },
  });

  // Timeline: lead created + initial state.
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: row.id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: `Lead created (${status})`,
    metadata: { action: 'create', status, organization_id: orgId },
  }).catch(() => {});
  publishStateChanged({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: row.id,
    fromState: null, toState: status,
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    kind: 'status_change',
    metadata: { event: 'lead.create' },
  }).catch(() => {});

  // S3B — fire-and-forget email notification (enqueues into email.outbox).
  notifyLeadCreated(req, row.id, { lead: row })
    .catch((e) => console.error('[notify] lead_created failed', e?.message ?? e));

  created(res, row);
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  const fields = [];
  const params = [req.tenant.id, id];
  let i = 3;
  for (const k of ['name','email','phone','company','position','source','source_details','interest','total_revenue']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
  }
  if (body.selected_products !== undefined) {
    fields.push(`selected_products = $${i++}::jsonb`); params.push(JSON.stringify(body.selected_products));
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE sales.lead SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'update', resource: 'sales.lead', resourceId: id, payload: { fields: fields.filter(f => f !== 'updated_at = now()') } });
  ok(res, rows[0]);
}

export async function remove(req, res, id) {
  const { rowCount } = await q(
    `DELETE FROM sales.lead WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rowCount === 0) return notFound(res);
  recordAudit({ req, action: 'delete', resource: 'sales.lead', resourceId: id });
  ok(res, { id });
}

export async function changeStatus(req, res, id) {
  const body = (await readBody(req)) || {};
  const to = String(body.to_status ?? body.status ?? '').trim();
  if (!VALID_STATUS.has(to)) return badReq(res, 'invalid_to_status');
  const note = body.note ?? null;
  const archivedReason = body.archived_reason ?? null;

  const result = await withTx(async (client) => {
    const cur = await client.query(
      `SELECT status, status_timestamps FROM sales.lead WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [req.tenant.id, id],
    );
    if (cur.rows.length === 0) return { kind: 'not_found' };
    const from = cur.rows[0].status;
    const stamps = cur.rows[0].status_timestamps ?? {};
    stamps[statusTimestampKey(to)] = new Date().toISOString();

    const archivedAt     = to === 'Archived' ? new Date().toISOString() : null;
    const archivedReasonCol = to === 'Archived' ? archivedReason : null;

    const upd = await client.query(
      `UPDATE sales.lead
          SET status = $3, status_timestamps = $4::jsonb,
              archived_at     = COALESCE($5::timestamptz, archived_at),
              archived_reason = COALESCE($6, archived_reason),
              updated_at      = now()
        WHERE tenant_id = $1 AND id = $2
       RETURNING ${COLS}`,
      [req.tenant.id, id, to, JSON.stringify(stamps), archivedAt, archivedReasonCol],
    );
    await client.query(
      `INSERT INTO sales.status_history
         (tenant_id, lead_id, from_status, to_status, changed_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.tenant.id, id, from, to, req.user?.sub ?? null, note],
    );
    return { kind: 'ok', lead: upd.rows[0], from };
  });

  if (result.kind === 'not_found') return notFound(res);
  recordAudit({
    req, action: 'status_change', resource: 'sales.lead', resourceId: id,
    payload: { from_status: result.from, to_status: to, note },
  });
  // Sprint 2A — dual-write into the unified activity timeline and publish the
  // rwr.workflow.state_changed.v1 envelope so downstream consumers can pivot
  // on entity_id without joining N polymorphic FKs.
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: id,
    kind: 'status_change', source: 'system',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: `Status changed: ${result.from} -> ${to}`,
    metadata: { from: result.from, to, note },
  }).catch(() => {});
  publishStateChanged({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: id,
    fromState: result.from, toState: to,
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    kind: 'status_change',
    metadata: { event: 'lead.status_change', note },
  }).catch(() => {});

  // S3B — email only on the two material lifecycle crossings the spec calls out.
  const NOTIFIABLE = new Set(['Info Request->Lead', 'Lead->Client']);
  if (NOTIFIABLE.has(`${result.from}->${to}`)) {
    notifyLeadStatusChanged(req, id, result.from, to, { note, lead: result.lead })
      .catch((e) => console.error('[notify] lead_status_changed failed', e?.message ?? e));
  }

  ok(res, result.lead);
}

export async function attachProducts(req, res, id) {
  const body = (await readBody(req)) || {};
  const products = Array.isArray(body.products) ? body.products : null;
  if (!products) return badReq(res, 'products_array_required');

  const totalRevenue = products.reduce((s, p) => s + Number(p?.price ?? 0), 0);

  const beforeRes = await q(
    `SELECT selected_products, total_revenue FROM sales.lead
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  const before = beforeRes.rows[0] ?? null;

  const { rows } = await q(
    `UPDATE sales.lead
        SET selected_products = $3::jsonb,
            total_revenue     = $4,
            updated_at        = now()
      WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLS}`,
    [req.tenant.id, id, JSON.stringify(products), totalRevenue],
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({
    req,
    action: 'attach_products',
    resource: 'sales.lead',
    resourceId: id,
    payload: {
      before: before ? { selected_products: before.selected_products, total_revenue: before.total_revenue } : null,
      after:  { selected_products: products, total_revenue: totalRevenue },
      fields: ['selected_products','total_revenue'],
    },
  });
  ok(res, rows[0]);
}

export async function statusHistory(req, res, id) {
  const { rows } = await q(
    `SELECT id, from_status, to_status, changed_at, changed_by, note
       FROM sales.status_history
      WHERE tenant_id = $1 AND lead_id = $2
      ORDER BY changed_at DESC`,
    [req.tenant.id, id],
  );
  ok(res, rows);
}
