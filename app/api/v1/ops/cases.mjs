// =============================================================================
// /api/v1/ops/cases — Project Manager case lifecycle.
// -----------------------------------------------------------------------------
// State machine: open → assigned → in_progress → blocked → closed
// Each transition writes an ops.case_activity row.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { notifyCaseAssigned } from '../email/notify.mjs';

const COLS = `id, tenant_id, title, description, status, priority, detection_id, opened_at, closed_at`;
const VALID_STATUS = new Set(['open','assigned','in_progress','blocked','closed']);
const VALID_PRIORITY = new Set(['low','medium','high','critical']);

export async function list(req, res) {
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (qs.status && VALID_STATUS.has(qs.status))     { params.push(qs.status);   where += ` AND status = $${params.length}`; }
  if (qs.priority && VALID_PRIORITY.has(qs.priority)) { params.push(qs.priority); where += ` AND priority = $${params.length}`; }
  const { rows } = await q(
    `SELECT ${COLS} FROM ops.case WHERE ${where} ORDER BY opened_at DESC`,
    params,
  );
  ok(res, rows);
}

export async function get(req, res, id) {
  const { rows } = await q(
    `SELECT ${COLS} FROM ops.case WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  const { rows: assignments } = await q(
    `SELECT id, assignee_id, assigned_at, released_at
       FROM ops.case_assignment WHERE tenant_id = $1 AND case_id = $2
      ORDER BY assigned_at DESC`,
    [req.tenant.id, id],
  );
  const { rows: activity } = await q(
    `SELECT id, kind, body, payload, actor_id, created_at
       FROM ops.case_activity WHERE tenant_id = $1 AND case_id = $2
      ORDER BY created_at DESC LIMIT 200`,
    [req.tenant.id, id],
  );
  const { rows: attachments } = await q(
    `SELECT id, file_name, file_size, storage_path, uploaded_at
       FROM ops.case_attachment WHERE tenant_id = $1 AND case_id = $2
      ORDER BY uploaded_at DESC`,
    [req.tenant.id, id],
  );
  ok(res, { ...rows[0], assignments, activity, attachments });
}

export async function create(req, res) {
  const body = (await readBody(req)) || {};
  const title = String(body.title ?? '').trim();
  if (!title) return badReq(res, 'title_required');
  const priority = VALID_PRIORITY.has(body.priority) ? body.priority : 'medium';
  const { rows } = await q(
    `INSERT INTO ops.case (tenant_id, title, description, priority, detection_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [req.tenant.id, title, body.description ?? null, priority, body.detection_id ?? null],
  );
  recordAudit({ req, action: 'create', resource: 'ops.case', resourceId: rows[0].id, payload: { priority, detection_id: body.detection_id ?? null } });
  created(res, rows[0]);
}

// Idempotent escalation: high-severity map detection → ops.case.
// If a case for (tenant, detection_id) already exists, return it (200);
// otherwise insert a fresh open case (201) and seed an 'auto_escalation'
// activity row. Body: { detection_id, severity?, title?, description?,
// payload? }.
export async function fromDetection(req, res) {
  const body = (await readBody(req)) || {};
  const detectionId = String(body.detection_id ?? '').trim();
  if (!detectionId) return badReq(res, 'detection_id_required');
  const severity = String(body.severity ?? 'high').toLowerCase();
  const priority = severity === 'high' ? 'high'
                 : severity === 'medium' ? 'medium'
                 : 'low';
  return withTx(async (client) => {
    const existing = await client.query(
      `SELECT ${COLS} FROM ops.case
        WHERE tenant_id = $1 AND detection_id = $2 LIMIT 1`,
      [req.tenant.id, detectionId],
    );
    if (existing.rows.length > 0) return ok(res, existing.rows[0]);
    const title = String(body.title ?? `Detection ${detectionId}`).trim();
    const desc  = body.description ?? null;
    const inserted = await client.query(
      `INSERT INTO ops.case (tenant_id, title, description, priority, detection_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [req.tenant.id, title, desc, priority, detectionId],
    );
    const c = inserted.rows[0];
    await client.query(
      `INSERT INTO ops.case_activity (tenant_id, case_id, kind, body, payload, actor_id)
       VALUES ($1, $2, 'auto_escalation', $3, $4::jsonb, $5)`,
      [req.tenant.id, c.id,
       `Auto-escalated from detection ${detectionId} (severity=${severity})`,
       JSON.stringify({ detection_id: detectionId, severity, ...(body.payload || {}) }),
       req.user?.sub ?? null],
    );
    return created(res, c);
  });
}

export async function update(req, res, id) {
  const body = (await readBody(req)) || {};
  return withTx(async (client) => {
    const cur = await client.query(
      `SELECT status FROM ops.case WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [req.tenant.id, id],
    );
    if (cur.rows.length === 0) return notFound(res);
    const fields = []; const params = [req.tenant.id, id]; let i = 3;
    for (const k of ['title','description','priority','detection_id']) {
      if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
    }
    let statusChanged = false;
    if (body.status !== undefined) {
      if (!VALID_STATUS.has(body.status)) return badReq(res, 'invalid_status');
      fields.push(`status = $${i++}`); params.push(body.status);
      if (body.status === 'closed') fields.push(`closed_at = now()`);
      statusChanged = body.status !== cur.rows[0].status;
    }
    if (fields.length === 0) return badReq(res, 'no_fields_to_update');
    const { rows } = await client.query(
      `UPDATE ops.case SET ${fields.join(', ')}
        WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
      params,
    );
    if (statusChanged) {
      await client.query(
        `INSERT INTO ops.case_activity (tenant_id, case_id, kind, body, payload, actor_id)
         VALUES ($1, $2, 'status_change', $3, $4::jsonb, $5)`,
        [req.tenant.id, id, `status → ${body.status}`,
         JSON.stringify({ from: cur.rows[0].status, to: body.status }),
         req.user?.sub ?? null],
      );
      recordAudit({ req, action: 'status_change', resource: 'ops.case', resourceId: id, payload: { from: cur.rows[0].status, to: body.status } });
    } else {
      recordAudit({ req, action: 'update', resource: 'ops.case', resourceId: id });
    }
    return ok(res, rows[0]);
  });
}

export async function assign(req, res, id) {
  const body = (await readBody(req)) || {};
  const assigneeId = body.assignee_id;
  if (!assigneeId) return badReq(res, 'assignee_id_required');
  return withTx(async (client) => {
    const cur = await client.query(
      `SELECT id, status FROM ops.case WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [req.tenant.id, id],
    );
    if (cur.rows.length === 0) return notFound(res);
    // close current assignment(s)
    await client.query(
      `UPDATE ops.case_assignment SET released_at = now()
        WHERE tenant_id = $1 AND case_id = $2 AND released_at IS NULL`,
      [req.tenant.id, id],
    );
    await client.query(
      `INSERT INTO ops.case_assignment (tenant_id, case_id, assignee_id)
       VALUES ($1, $2, $3)`,
      [req.tenant.id, id, assigneeId],
    );
    if (cur.rows[0].status === 'open') {
      await client.query(
        `UPDATE ops.case SET status = 'assigned' WHERE tenant_id = $1 AND id = $2`,
        [req.tenant.id, id],
      );
    }
    await client.query(
      `INSERT INTO ops.case_activity (tenant_id, case_id, kind, body, payload, actor_id)
       VALUES ($1, $2, 'assignment', $3, $4::jsonb, $5)`,
      [req.tenant.id, id, `assigned to ${assigneeId}`,
       JSON.stringify({ assignee_id: assigneeId }), req.user?.sub ?? null],
    );
    const final = await client.query(
      `SELECT ${COLS} FROM ops.case WHERE tenant_id = $1 AND id = $2`,
      [req.tenant.id, id],
    );
    recordAudit({ req, action: 'assign', resource: 'ops.case', resourceId: id, payload: { assignee_id: assigneeId } });
    // S3B — email notification (fire-and-forget, enqueues into email.outbox).
    notifyCaseAssigned(req, id, assigneeId, { case_row: final.rows[0] })
      .catch((e) => console.error('[notify] case_assigned failed', e?.message ?? e));
    return ok(res, final.rows[0]);
  });
}

export async function activity(req, res, id) {
  const body = (await readBody(req)) || {};
  const kind = String(body.kind ?? 'comment').trim();
  const text = String(body.body ?? '').trim();
  if (!text) return badReq(res, 'body_required');
  const { rows } = await q(
    `INSERT INTO ops.case_activity (tenant_id, case_id, kind, body, payload, actor_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, kind, body, payload, actor_id, created_at`,
    [req.tenant.id, id, kind, text, JSON.stringify(body.payload ?? {}), req.user?.sub ?? null],
  );
  recordAudit({ req, action: 'create', resource: 'ops.case_activity', resourceId: rows[0].id, payload: { after: rows[0], case_id: id } });
  created(res, rows[0]);
}

export async function attachments(req, res, id) {
  // Lightweight stub — accepts JSON metadata and records a row. Binary upload
  // is handled by /sales/files/upload which already wires the multipart parse.
  const body = (await readBody(req)) || {};
  const file_name    = String(body.file_name ?? '').trim();
  const file_size    = Number(body.file_size ?? 0);
  const storage_path = String(body.storage_path ?? '').trim();
  if (!file_name || !storage_path) return badReq(res, 'file_name_and_storage_path_required');
  const { rows } = await q(
    `INSERT INTO ops.case_attachment (tenant_id, case_id, file_name, file_size, storage_path)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, file_name, file_size, storage_path, uploaded_at`,
    [req.tenant.id, id, file_name, file_size, storage_path],
  );
  recordAudit({ req, action: 'create', resource: 'ops.case_attachment', resourceId: rows[0].id, payload: { after: rows[0], case_id: id } });
  created(res, rows[0]);
}
