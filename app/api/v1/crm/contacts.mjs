// =============================================================================
// /api/v1/crm/contacts — person decoupled from Lead lifecycle (EPIC-003 P-003).
// -----------------------------------------------------------------------------
// Tenant-scoped; RBAC-gated via crm.contact.read/write. m:n with sales.lead via
// sales.contact_lead. All mutations emit recordAudit + sales.activity.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';

const COLS = `id, tenant_id, organization_id, first_name, last_name, full_name,
              email, email_secondary, phone, phone_secondary, title, position,
              avatar_url, linkedin_url, preferred_channel, marketing_opt_in,
              status, notes, source, created_at, updated_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.contact.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.organization_id && UUID_RE.test(qs.organization_id)) {
    params.push(qs.organization_id); where += ` AND organization_id = $${params.length}`;
  }
  if (qs.q) {
    params.push(`%${String(qs.q).toLowerCase()}%`);
    where += ` AND (lower(full_name) LIKE $${params.length} OR lower(coalesce(email,'')) LIKE $${params.length})`;
  }
  // S7C — exact-email filter so the customer portal can look up its own
  // contact row when listLeads returns [] under data.read.assigned.
  if (qs.email) {
    params.push(String(qs.email).trim().toLowerCase());
    where += ` AND lower(email) = $${params.length}`;
  }
  if (qs.status) { params.push(qs.status); where += ` AND status = $${params.length}`; }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.contact
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.contact.read')) return;
  const { rows } = await q(
    `SELECT ${COLS} FROM sales.contact WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.contact.write')) return;
  const body = (await readBody(req)) || {};
  const email = body.email ? String(body.email).trim() : null;
  const first = body.first_name ? String(body.first_name).trim() : null;
  const last  = body.last_name  ? String(body.last_name).trim()  : null;
  if (!email && !first && !last) return badReq(res, 'name_or_email_required');
  try {
    const { rows } = await q(
      `INSERT INTO sales.contact
         (tenant_id, organization_id, first_name, last_name, email, email_secondary,
          phone, phone_secondary, title, position, avatar_url, linkedin_url,
          preferred_channel, marketing_opt_in, status, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${COLS}`,
      [
        req.tenant.id,
        body.organization_id ?? null,
        first, last, email,
        body.email_secondary ?? null,
        body.phone ?? null,
        body.phone_secondary ?? null,
        body.title ?? null,
        body.position ?? null,
        body.avatar_url ?? null,
        body.linkedin_url ?? null,
        body.preferred_channel ?? null,
        body.marketing_opt_in === true,
        body.status ?? 'active',
        body.notes ?? null,
        body.source ?? null,
      ],
    );
    const row = rows[0];
    recordAudit({
      req, action: 'crm.contact.create',
      resource: 'sales.contact', resourceId: row.id,
      payload: { after: row },
    });
    emitActivity({
      tenantId: req.tenant.id,
      entityKind: 'contact', entityId: row.id,
      kind: 'system', source: 'system',
      actorId: req.user?.sub ?? null,
      actorLabel: req.user?.email ?? null,
      text: `Contact created: ${row.full_name || row.email || row.id}`,
      metadata: { action: 'create' },
    }).catch(() => {});
    created(res, row);
  } catch (err) {
    if (err?.code === '23505') return badReq(res, 'duplicate_contact_email');
    throw err;
  }
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.contact.write')) return;
  const body = (await readBody(req)) || {};
  const beforeRes = await q(
    `SELECT ${COLS} FROM sales.contact WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (beforeRes.rows.length === 0) return notFound(res);
  const before = beforeRes.rows[0];

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  for (const k of [
    'organization_id','first_name','last_name','email','email_secondary','phone',
    'phone_secondary','title','position','avatar_url','linkedin_url',
    'preferred_channel','status','notes','source',
  ]) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
  }
  if (body.marketing_opt_in !== undefined) {
    fields.push(`marketing_opt_in = $${i++}`); params.push(body.marketing_opt_in === true);
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const { rows } = await q(
    `UPDATE sales.contact SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  recordAudit({
    req, action: 'crm.contact.update',
    resource: 'sales.contact', resourceId: id,
    payload: { before, after: rows[0] },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'contact', entityId: id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Contact updated`,
    metadata: { action: 'update' },
  }).catch(() => {});
  ok(res, rows[0]);
}

// POST /crm/contacts/:id/link-lead  { lead_id, role? }
export async function linkLead(req, res, id) {
  if (!requirePermission(req, res, 'crm.contact.write')) return;
  const body = (await readBody(req)) || {};
  const leadId = body.lead_id ? String(body.lead_id).trim() : null;
  if (!leadId || !UUID_RE.test(leadId)) return badReq(res, 'lead_id_required');
  const role = body.role ?? 'primary';

  // Guard contact + lead exist in tenant
  const guard = await q(
    `SELECT (SELECT 1 FROM sales.contact WHERE tenant_id = $1 AND id = $2) AS c,
            (SELECT 1 FROM sales.lead    WHERE tenant_id = $1 AND id = $3) AS l`,
    [req.tenant.id, id, leadId],
  );
  if (!guard.rows[0]?.c) return notFound(res, 'contact_not_found');
  if (!guard.rows[0]?.l) return notFound(res, 'lead_not_found');

  const { rows } = await q(
    `INSERT INTO sales.contact_lead (tenant_id, contact_id, lead_id, role, linked_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, contact_id, lead_id) DO UPDATE
        SET role = EXCLUDED.role, unlinked_at = NULL
     RETURNING tenant_id, contact_id, lead_id, role, linked_at, linked_by, unlinked_at`,
    [req.tenant.id, id, leadId, role, req.user?.sub ?? null],
  );
  recordAudit({
    req, action: 'crm.contact.link_lead',
    resource: 'sales.contact_lead', resourceId: id,
    payload: { after: rows[0] },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'contact', entityId: id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Linked to lead ${leadId} as ${role}`,
    metadata: { action: 'link_lead', lead_id: leadId, role },
  }).catch(() => {});
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'lead', entityId: leadId,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Contact ${id} linked as ${role}`,
    metadata: { action: 'contact_linked', contact_id: id, role },
  }).catch(() => {});
  created(res, rows[0]);
}
