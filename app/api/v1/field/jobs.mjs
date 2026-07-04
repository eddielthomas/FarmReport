// =============================================================================
// /api/v1/field/jobs — Field Service job aggregate (S9A).
// -----------------------------------------------------------------------------
// Routes:
//   GET    /field/jobs                       list (techs see assigned_to=self,
//                                            managers see all tenant rows)
//   POST   /field/jobs                       create (manager only, field.job.write)
//   GET    /field/jobs/:id                   detail (read + classification gate)
//   PUT    /field/jobs/:id                   update — accepts status transition
//                                            and field mutations; emits
//                                            field.job.status_changed +
//                                            field.job.assigned envelopes
//
// State machine: commissioned -> assigned -> en_route -> on_site ->
//                in_progress -> completed -> verified  (+ cancelled at any
// point). Transitions validated by VALID_TRANSITIONS; misses return 422.
//
// Every mutation emits recordAudit + workflow envelope via publishStateChanged.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, send, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission, hasPermission } from '../middleware/policy.mjs';
import { publishStateChanged } from '../lib/activity.mjs';
import { publishFieldEvent } from '../lib/field-relay.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUS = new Set([
  'commissioned','assigned','en_route','on_site','in_progress',
  'paused','completed','verified','cancelled',
]);
const VALID_PRIORITY = new Set(['low','medium','high','critical']);

// Allowed forward transitions. cancelled is reachable from anywhere except
// `verified` (which is a terminal acceptance state).
const VALID_TRANSITIONS = {
  commissioned: new Set(['assigned','cancelled']),
  assigned:     new Set(['en_route','commissioned','cancelled']),
  en_route:     new Set(['on_site','assigned','cancelled']),
  on_site:      new Set(['in_progress','en_route','cancelled']),
  in_progress:  new Set(['completed','on_site','paused','cancelled']),
  paused:       new Set(['in_progress','on_site','cancelled']),
  completed:    new Set(['verified','in_progress','cancelled']),
  verified:     new Set([]),
  cancelled:    new Set(['commissioned']), // re-open
};

const COLS = `id, tenant_id, classification,
              source_lead_id, source_opportunity_id, source_case_id,
              title, description, status, priority,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon,
              geofence_radius_m, commissioned_at, assigned_to, assigned_at,
              scheduled_for, created_by, created_at, updated_at`;

function isManager(req) {
  return hasPermission(req, 'field.job.write')
      || hasPermission(req, 'field.location.read.tenant')
      || (req.user?.roles ?? []).includes('platform:admin');
}

export async function list(req, res) {
  if (!requirePermission(req, res, 'field.job.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.status && VALID_STATUS.has(qs.status)) {
    params.push(qs.status); where += ` AND status = $${params.length}`;
  }
  // Tech path — only own jobs unless the caller has manager-tier perms.
  if (!isManager(req) && req.user?.sub && UUID_RE.test(req.user.sub)) {
    params.push(req.user.sub);
    where += ` AND assigned_to = $${params.length}`;
  } else if (qs.assigned_to && UUID_RE.test(qs.assigned_to)) {
    params.push(qs.assigned_to);
    where += ` AND assigned_to = $${params.length}`;
  }
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM field.job WHERE ${where}
        ORDER BY scheduled_for NULLS LAST, commissioned_at DESC LIMIT 500`,
      params,
    );
    return r.rows;
  });
  ok(res, rows);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'field.job.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_job_id');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${COLS} FROM field.job WHERE id = $1`, [id],
    );
    if (r.rows.length === 0) return null;
    const job = r.rows[0];
    // Tech path: must be the assignee
    if (!isManager(req) && job.assigned_to !== (req.user?.sub ?? null)) {
      return 'forbidden';
    }
    const tasks = await client.query(
      `SELECT id, title, description, ordinal, completed, completed_at, completed_by, created_at
         FROM field.task WHERE job_id = $1 ORDER BY ordinal, created_at`, [id],
    );
    return { ...job, tasks: tasks.rows };
  });
  if (row === null) return notFound(res);
  if (row === 'forbidden') return send(res, 403, { success: false, error: 'forbidden' });
  ok(res, row);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'field.job.write')) return;
  const body = (await readBody(req)) || {};
  const title = String(body.title ?? '').trim();
  if (!title) return badReq(res, 'title_required');
  const priority = VALID_PRIORITY.has(body.priority) ? body.priority : 'medium';
  const radius = Number.isFinite(Number(body.geofence_radius_m))
    ? Math.max(5, Math.min(5000, Math.round(Number(body.geofence_radius_m))))
    : 100;
  const lat = body.lat != null ? Number(body.lat) : null;
  const lon = body.lon != null ? Number(body.lon) : null;
  const hasLocation = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon);
  const assignedTo = body.assigned_to && UUID_RE.test(String(body.assigned_to))
    ? String(body.assigned_to) : null;
  const classification = ['public','internal','confidential','secret']
    .includes(body.classification) ? body.classification : 'internal';

  const result = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO field.job
         (tenant_id, classification,
          source_lead_id, source_opportunity_id, source_case_id,
          title, description, status, priority,
          location, geofence_radius_m, assigned_to, assigned_at,
          scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8::uuid IS NULL THEN 'commissioned' ELSE 'assigned' END,
               $9,
               CASE WHEN $10::double precision IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($11::double precision, $10::double precision), 4326)::geography END,
               $12, $8::uuid,
               CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END,
               $13::timestamptz, $14::uuid)
       RETURNING ${COLS}`,
      [
        req.tenant.id, classification,
        body.source_lead_id && UUID_RE.test(body.source_lead_id) ? body.source_lead_id : null,
        body.source_opportunity_id && UUID_RE.test(body.source_opportunity_id) ? body.source_opportunity_id : null,
        body.source_case_id && UUID_RE.test(body.source_case_id) ? body.source_case_id : null,
        title, body.description ?? null,
        assignedTo,
        priority,
        hasLocation ? lat : null,
        hasLocation ? lon : null,
        radius,
        body.scheduled_for ?? null,
        req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null,
      ],
    );
    return r.rows[0];
  });

  recordAudit({
    req, action: 'field.job.create', resource: 'field.job', resourceId: result.id,
    payload: { after: result, classification: result.classification },
  });
  publishStateChanged({
    tenantId: req.tenant.id,
    entityKind: 'lead', // closest entity in current activity enum
    entityId:  result.source_lead_id ?? result.id,
    fromState: null,
    toState:   result.status,
    actorId:   req.user?.sub ?? null,
    actorLabel: req.user?.email ?? null,
    metadata: { surface: 'field.job', job_id: result.id },
  }).catch(() => {});
  publishFieldEvent(req.io, 'field.job.status_changed', {
    tenant_id: req.tenant.id, job_id: result.id, from: null, to: result.status,
  });
  if (result.assigned_to) {
    publishFieldEvent(req.io, 'field.job.assigned', {
      tenant_id: req.tenant.id, job_id: result.id,
      assigned_to: result.assigned_to, by: req.user?.sub ?? null,
    });
  }
  created(res, result);
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'field.job.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};

  const outcome = await withTenantConn(req, async (client) => {
    const beforeRes = await client.query(
      `SELECT ${COLS} FROM field.job WHERE id = $1`, [id],
    );
    if (beforeRes.rows.length === 0) return { kind: 'not_found' };
    const before = beforeRes.rows[0];

    // Status transition gating
    const wantStatus = body.status && VALID_STATUS.has(body.status) ? body.status : null;
    if (wantStatus && wantStatus !== before.status) {
      const allowed = VALID_TRANSITIONS[before.status] ?? new Set();
      if (!allowed.has(wantStatus)) {
        return { kind: 'invalid_transition', from: before.status, to: wantStatus };
      }
    }

    // Assignment change — manager-only
    const wantAssignee = 'assigned_to' in body
      ? (body.assigned_to && UUID_RE.test(String(body.assigned_to)) ? String(body.assigned_to) : null)
      : before.assigned_to;
    const assigneeChanged = ('assigned_to' in body) && wantAssignee !== before.assigned_to;
    if (assigneeChanged && !hasPermission(req, 'field.job.assign')) {
      return { kind: 'forbidden_assign' };
    }

    // Tech may only mutate own job, and only status transitions.
    const isMgr = isManager(req);
    if (!isMgr) {
      if (before.assigned_to !== (req.user?.sub ?? null)) return { kind: 'forbidden' };
      if (Object.keys(body).some((k) => !['status'].includes(k))) {
        return { kind: 'forbidden_fields' };
      }
    }

    const newStatus   = wantStatus ?? before.status;
    const newPriority = VALID_PRIORITY.has(body.priority) ? body.priority : before.priority;
    const newRadius   = Number.isFinite(Number(body.geofence_radius_m))
      ? Math.max(5, Math.min(5000, Math.round(Number(body.geofence_radius_m))))
      : before.geofence_radius_m;
    const newTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : before.title;
    const newDesc  = 'description' in body ? body.description : before.description;
    const newSched = 'scheduled_for' in body ? body.scheduled_for : before.scheduled_for;
    const newClass = ['public','internal','confidential','secret'].includes(body.classification)
      ? body.classification : before.classification;

    const r = await client.query(
      `UPDATE field.job SET
         title = $2, description = $3, status = $4, priority = $5,
         geofence_radius_m = $6, assigned_to = $7,
         assigned_at = CASE WHEN $7::uuid IS DISTINCT FROM $8::uuid THEN now() ELSE assigned_at END,
         scheduled_for = $9::timestamptz, classification = $10, updated_at = now()
       WHERE id = $1
       RETURNING ${COLS}`,
      [
        id, newTitle, newDesc, newStatus, newPriority, newRadius,
        wantAssignee, before.assigned_to, newSched, newClass,
      ],
    );
    return { kind: 'ok', before, after: r.rows[0], assigneeChanged };
  });

  if (outcome.kind === 'not_found')          return notFound(res);
  if (outcome.kind === 'forbidden')          return send(res, 403, { success: false, error: 'forbidden' });
  if (outcome.kind === 'forbidden_assign')   return send(res, 403, { success: false, error: 'missing_permission:field.job.assign' });
  if (outcome.kind === 'forbidden_fields')   return send(res, 403, { success: false, error: 'technician_can_only_change_status' });
  if (outcome.kind === 'invalid_transition') {
    return send(res, 422, { success: false, error: 'invalid_state_transition',
      detail: { from: outcome.from, to: outcome.to } });
  }

  const { before, after, assigneeChanged } = outcome;
  recordAudit({
    req, action: 'field.job.update', resource: 'field.job', resourceId: after.id,
    payload: { before, after, classification: after.classification },
  });
  if (before.status !== after.status) {
    publishStateChanged({
      tenantId: req.tenant.id,
      entityKind: 'lead', entityId: after.source_lead_id ?? after.id,
      fromState: before.status, toState: after.status,
      actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
      metadata: { surface: 'field.job', job_id: after.id },
    }).catch(() => {});
    publishFieldEvent(req.io, 'field.job.status_changed', {
      tenant_id: req.tenant.id, job_id: after.id,
      from: before.status, to: after.status,
    });
  }
  if (assigneeChanged) {
    publishFieldEvent(req.io, 'field.job.assigned', {
      tenant_id: req.tenant.id, job_id: after.id,
      assigned_to: after.assigned_to, by: req.user?.sub ?? null,
    });
  }
  ok(res, after);
}
