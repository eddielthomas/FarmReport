// =============================================================================
// /api/v1/crm/projects — customer projects (Sprint 14A).
// -----------------------------------------------------------------------------
// Routes:
//   GET    /crm/projects             list (tenant-scoped, filtered by caller's
//                                    visibility scope where applicable)
//   POST   /crm/projects             create (crm.project.write — ops/sales)
//   GET    /crm/projects/:id         detail
//   PUT    /crm/projects/:id         update
//   DELETE /crm/projects/:id         soft-archive (status='archived')
//
// All mutations emit recordAudit + sales.activity (entityKind='lead' anchored
// to source_lead_id when available, else fall back to the project id itself).
// RLS + clearance binding via withTenantConn.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission, hasPermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { customerScope, isCustomerOnly } from '../customer/lib/scope.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLS = `id, tenant_id, classification,
              customer_contact_id, customer_organization_id, source_lead_id,
              title, description, status,
              aoi_west, aoi_south, aoi_east, aoi_north,
              center_lat, center_lon, default_zoom, leak_source, sub_project_id,
              created_by, created_at, updated_at`;

const VALID_STATUS = new Set(['active','paused','completed','archived']);
const VALID_CLASS  = new Set(['public','internal','confidential','secret']);
const VALID_LEAK_SOURCE = new Set(['bundled','gateway']);

function uuidOrNull(v) {
  if (typeof v !== 'string') return null;
  return UUID_RE.test(v) ? v : null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map the AOI / map-binding fields off a request body. Returns {field, value}
// pairs only for keys actually present, so PATCH-style updates stay sparse.
// `bbox` may be passed as {west,south,east,north} or aoi_* flat keys.
function aoiFields(body) {
  const out = [];
  const bbox = body.bbox && typeof body.bbox === 'object' ? body.bbox : {};
  const pick = (col, ...keys) => {
    for (const k of keys) {
      if (k in body) { out.push([col, numOrNull(body[k])]); return; }
    }
    if (col.startsWith('aoi_')) {
      const short = col.slice(4);
      if (short in bbox) out.push([col, numOrNull(bbox[short])]);
    }
  };
  pick('aoi_west',  'aoi_west');
  pick('aoi_south', 'aoi_south');
  pick('aoi_east',  'aoi_east');
  pick('aoi_north', 'aoi_north');
  pick('center_lat', 'center_lat');
  pick('center_lon', 'center_lon');
  pick('default_zoom', 'default_zoom');
  if ('leak_source' in body) {
    out.push(['leak_source', VALID_LEAK_SOURCE.has(body.leak_source) ? body.leak_source : null]);
  }
  if ('sub_project_id' in body) {
    out.push(['sub_project_id', body.sub_project_id == null ? null : String(body.sub_project_id).slice(0, 64)]);
  }
  return out;
}

// --- LIST -------------------------------------------------------------------
// Customer-only callers (customer.viewer with no write perm) are scoped via
// customerScope().project_ids. Staff callers see every project in the tenant.
export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  const qs = parseQuery(req.url);

  let scopedIds = null;
  if (isCustomerOnly(req)) {
    const scope = await customerScope(req);
    scopedIds = scope.project_ids;
    if (scopedIds.length === 0) { ok(res, []); return; }
  }

  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.status && VALID_STATUS.has(qs.status)) {
    params.push(qs.status); where += ` AND status = $${params.length}`;
  }
  if (qs.customer_contact_id && UUID_RE.test(qs.customer_contact_id)) {
    params.push(qs.customer_contact_id);
    where += ` AND customer_contact_id = $${params.length}`;
  }
  if (qs.customer_organization_id && UUID_RE.test(qs.customer_organization_id)) {
    params.push(qs.customer_organization_id);
    where += ` AND customer_organization_id = $${params.length}`;
  }
  if (scopedIds) {
    params.push(scopedIds);
    where += ` AND id = ANY($${params.length}::uuid[])`;
  }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM crm.project
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}

// --- GET ONE ----------------------------------------------------------------
export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_project_id');

  if (isCustomerOnly(req)) {
    const scope = await customerScope(req);
    if (!scope.project_ids.includes(id)) return notFound(res);
  }

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM crm.project WHERE id = $1`, [id],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

// --- CREATE -----------------------------------------------------------------
export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.project.write')) return;
  const body = (await readBody(req)) || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) {
    return send(res, 400, { success: false, error: 'validation_failed',
      detail: { field: 'title', reason: 'required_1_200_chars' } });
  }
  const description = body.description == null ? null : String(body.description);
  if (description != null && description.length > 4000) {
    return send(res, 400, { success: false, error: 'validation_failed',
      detail: { field: 'description', reason: 'max_4000_chars' } });
  }
  const status = VALID_STATUS.has(body.status) ? body.status : 'active';
  const classification = VALID_CLASS.has(body.classification)
    ? body.classification : 'internal';

  // AOI / map-binding columns are appended dynamically so a project can be
  // created already pointed at a scan area (staff "new project" flow).
  const aoi = aoiFields(body);
  const baseCols = ['tenant_id', 'classification',
    'customer_contact_id', 'customer_organization_id', 'source_lead_id',
    'title', 'description', 'status', 'created_by'];
  const baseVals = [
    req.tenant.id, classification,
    uuidOrNull(body.customer_contact_id),
    uuidOrNull(body.customer_organization_id),
    uuidOrNull(body.source_lead_id),
    title, description, status,
    uuidOrNull(req.user?.sub),
  ];
  const cols = [...baseCols, ...aoi.map(([c]) => c)];
  const vals = [...baseVals, ...aoi.map(([, v]) => v)];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO crm.project (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING ${COLS}`,
      vals,
    );
    return r.rows[0];
  });

  recordAudit({
    req, action: 'crm.project.create',
    resource: 'crm.project', resourceId: row.id,
    payload: { after: row, classification: row.classification },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'lead',
    entityId: row.source_lead_id ?? row.id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Project created: ${row.title}`,
    metadata: { action: 'project.create', project_id: row.id },
  }).catch(() => {});
  created(res, row);
}

// --- UPDATE -----------------------------------------------------------------
export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.project.write')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_project_id');
  const body = (await readBody(req)) || {};

  const outcome = await withTenantConn(req, async (client) => {
    const beforeRes = await client.query(
      `SELECT ${COLS} FROM crm.project WHERE id = $1`, [id],
    );
    if (beforeRes.rows.length === 0) return { kind: 'not_found' };
    const before = beforeRes.rows[0];

    const fields = []; const params = [id]; let i = 2;
    if (typeof body.title === 'string') {
      const t = body.title.trim();
      if (!t || t.length > 200) return { kind: 'invalid', field: 'title' };
      fields.push(`title = $${i++}`); params.push(t);
    }
    if ('description' in body) {
      const d = body.description == null ? null : String(body.description);
      if (d != null && d.length > 4000) return { kind: 'invalid', field: 'description' };
      fields.push(`description = $${i++}`); params.push(d);
    }
    if (body.status !== undefined) {
      if (!VALID_STATUS.has(body.status)) return { kind: 'invalid', field: 'status' };
      fields.push(`status = $${i++}`); params.push(body.status);
    }
    if (body.classification !== undefined) {
      if (!VALID_CLASS.has(body.classification)) return { kind: 'invalid', field: 'classification' };
      fields.push(`classification = $${i++}`); params.push(body.classification);
    }
    if (body.customer_contact_id !== undefined) {
      fields.push(`customer_contact_id = $${i++}`);
      params.push(body.customer_contact_id == null ? null : uuidOrNull(body.customer_contact_id));
    }
    if (body.customer_organization_id !== undefined) {
      fields.push(`customer_organization_id = $${i++}`);
      params.push(body.customer_organization_id == null ? null : uuidOrNull(body.customer_organization_id));
    }
    if (body.source_lead_id !== undefined) {
      fields.push(`source_lead_id = $${i++}`);
      params.push(body.source_lead_id == null ? null : uuidOrNull(body.source_lead_id));
    }
    // AOI / map-binding columns (staff can refine the scan area after creation).
    for (const [col, val] of aoiFields(body)) {
      fields.push(`${col} = $${i++}`); params.push(val);
    }
    if (fields.length === 0) return { kind: 'no_fields' };
    fields.push('updated_at = now()');

    const upd = await client.query(
      `UPDATE crm.project SET ${fields.join(', ')}
        WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    return { kind: 'ok', before, after: upd.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res);
  if (outcome.kind === 'invalid') {
    return send(res, 400, { success: false, error: 'validation_failed',
      detail: { field: outcome.field, reason: 'invalid' } });
  }
  if (outcome.kind === 'no_fields') return badReq(res, 'no_fields_to_update');

  recordAudit({
    req, action: 'crm.project.update',
    resource: 'crm.project', resourceId: outcome.after.id,
    payload: { before: outcome.before, after: outcome.after,
               classification: outcome.after.classification },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'lead',
    entityId: outcome.after.source_lead_id ?? outcome.after.id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Project updated`,
    metadata: { action: 'project.update', project_id: outcome.after.id },
  }).catch(() => {});
  ok(res, outcome.after);
}

// --- DELETE (soft-archive) --------------------------------------------------
export async function remove(req, res, id) {
  if (!requirePermission(req, res, 'crm.project.write')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_project_id');

  const row = await withTenantConn(req, async (client) => {
    const before = await client.query(
      `SELECT ${COLS} FROM crm.project WHERE id = $1`, [id],
    );
    if (before.rows.length === 0) return null;
    const r = await client.query(
      `UPDATE crm.project SET status = 'archived', updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [id],
    );
    return { before: before.rows[0], after: r.rows[0] };
  });
  if (!row) return notFound(res);

  recordAudit({
    req, action: 'crm.project.archive',
    resource: 'crm.project', resourceId: row.after.id,
    payload: { before: row.before, after: row.after,
               classification: row.after.classification },
  });
  emitActivity({
    tenantId: req.tenant.id,
    entityKind: 'lead',
    entityId: row.after.source_lead_id ?? row.after.id,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    text: `Project archived`,
    metadata: { action: 'project.archive', project_id: row.after.id },
  }).catch(() => {});
  ok(res, row.after);
}
