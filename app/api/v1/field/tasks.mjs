// =============================================================================
// /api/v1/field/jobs/:id/tasks — sub-checklist mutation (S9A).
// -----------------------------------------------------------------------------
// POST   /field/jobs/:id/tasks                          create (manager)
// POST   /field/jobs/:id/tasks/:task_id/complete        mark done (tech or manager)
// DELETE /field/jobs/:id/tasks/:task_id                 remove (manager)
//
// AuthZ:
//   create / delete → field.task.manage
//   complete        → field.task.complete
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { publishFieldEvent } from '../lib/field-relay.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createTask(req, res, jobId) {
  if (!requirePermission(req, res, 'field.task.manage')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const title = String(body.title ?? '').trim();
  if (!title) return badReq(res, 'title_required');
  const ordinal = Number.isFinite(Number(body.ordinal)) ? Math.round(Number(body.ordinal)) : 0;
  const row = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM field.job WHERE id = $1`, [jobId]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `INSERT INTO field.task (tenant_id, job_id, title, description, ordinal)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, job_id, title, description, ordinal, completed, created_at`,
      [req.tenant.id, jobId, title, body.description ?? null, ordinal],
    );
    return r.rows[0];
  });
  if (!row) return notFound(res);
  recordAudit({
    req, action: 'field.task.create', resource: 'field.task', resourceId: row.id,
    payload: { after: row },
  });
  created(res, row);
}

export async function completeTask(req, res, jobId, taskId) {
  if (!requirePermission(req, res, 'field.task.complete')) return;
  if (!UUID_RE.test(jobId) || !UUID_RE.test(taskId)) return badReq(res, 'invalid_id');
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  const outcome = await withTenantConn(req, async (client) => {
    const job = await client.query(
      `SELECT id, assigned_to FROM field.job WHERE id = $1`, [jobId]);
    if (job.rows.length === 0) return { kind: 'not_found' };
    // Tech can only complete tasks on jobs assigned to them; manager via
    // field.task.manage bypasses this — re-check perm.
    const isManager = req.user?.permissions?.has('field.task.manage') ||
                      req.user?.permissions?.has('platform.admin.all');
    if (!isManager && job.rows[0].assigned_to !== userId) return { kind: 'forbidden' };

    const r = await client.query(
      `UPDATE field.task
          SET completed = TRUE, completed_at = now(), completed_by = $3
        WHERE id = $1 AND job_id = $2 AND completed = FALSE
        RETURNING id, job_id, title, ordinal, completed, completed_at, completed_by`,
      [taskId, jobId, userId],
    );
    if (r.rows.length === 0) return { kind: 'already_done_or_missing' };
    return { kind: 'ok', row: r.rows[0] };
  });
  if (outcome.kind === 'not_found')              return notFound(res);
  if (outcome.kind === 'forbidden')              return send(res, 403, { success: false, error: 'not_assignee' });
  if (outcome.kind === 'already_done_or_missing') return send(res, 409, { success: false, error: 'task_already_complete_or_missing' });

  recordAudit({
    req, action: 'field.task.complete', resource: 'field.task',
    resourceId: outcome.row.id,
    payload: { after: outcome.row },
  });
  ok(res, outcome.row);
}

export async function removeTask(req, res, jobId, taskId) {
  if (!requirePermission(req, res, 'field.task.manage')) return;
  if (!UUID_RE.test(jobId) || !UUID_RE.test(taskId)) return badReq(res, 'invalid_id');
  const outcome = await withTenantConn(req, async (client) => {
    const beforeRes = await client.query(
      `SELECT id, job_id, title, ordinal, completed FROM field.task
        WHERE id = $1 AND job_id = $2`, [taskId, jobId]);
    if (beforeRes.rows.length === 0) return null;
    await client.query(
      `DELETE FROM field.task WHERE id = $1 AND job_id = $2`,
      [taskId, jobId]);
    return beforeRes.rows[0];
  });
  if (!outcome) return notFound(res);
  recordAudit({
    req, action: 'field.task.delete', resource: 'field.task', resourceId: outcome.id,
    payload: { before: outcome },
  });
  ok(res, { id: outcome.id });
}
