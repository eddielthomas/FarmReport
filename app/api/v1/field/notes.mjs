// =============================================================================
// /api/v1/field/jobs/:id/notes — free-text job notes (S17).
// -----------------------------------------------------------------------------
//   GET  /field/jobs/:id/notes    list newest-first (field.job.read)
//   POST /field/jobs/:id/notes    add a note (field.job.read; body required)
//
// Tenant scoping via withTenantConn (RLS deny-by-default + FORCE on
// field.job_note). Every POST emits recordAudit (mandatory pattern).
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listNotes(req, res, jobId) {
  if (!requirePermission(req, res, 'field.job.read')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const rows = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM field.job WHERE id = $1`, [jobId]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `SELECT n.id, n.job_id, n.body, n.author_id, n.created_at,
              p.display_name AS author_name, p.email AS author_email
         FROM field.job_note n
         LEFT JOIN iam.user_profile p ON p.id = n.author_id
        WHERE n.job_id = $1
        ORDER BY n.created_at DESC
        LIMIT 500`,
      [jobId],
    );
    return r.rows;
  });
  if (rows === null) return notFound(res);
  ok(res, rows);
}

export async function createNote(req, res, jobId) {
  if (!requirePermission(req, res, 'field.job.read')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const body = (await readBody(req)) || {};
  const text = String(body.body ?? '').trim();
  if (!text) return badReq(res, 'body_required');
  if (text.length > 20000) return badReq(res, 'body_too_long');
  const authorId = req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null;

  const row = await withTenantConn(req, async (client) => {
    const guard = await client.query(`SELECT 1 FROM field.job WHERE id = $1`, [jobId]);
    if (guard.rows.length === 0) return null;
    const r = await client.query(
      `INSERT INTO field.job_note (tenant_id, job_id, body, author_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, job_id, body, author_id, created_at`,
      [req.tenant.id, jobId, text, authorId],
    );
    return r.rows[0];
  });
  if (!row) return notFound(res);

  recordAudit({
    req, action: 'field.job.note.create', resource: 'field.job_note', resourceId: row.id,
    payload: { after: row, job_id: jobId },
  });
  created(res, { ...row, author_email: req.user?.email ?? null });
}
