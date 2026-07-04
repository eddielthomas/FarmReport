// =============================================================================
// /api/v1/sales/leads/:id/notes — per-lead notes.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';

export async function listForLead(req, res, leadId) {
  const { rows } = await q(
    `SELECT id, lead_id, body, author_id, created_at
       FROM sales.note
      WHERE tenant_id = $1 AND lead_id = $2
      ORDER BY created_at DESC`,
    [req.tenant.id, leadId],
  );
  ok(res, rows);
}

export async function createForLead(req, res, leadId) {
  const body = (await readBody(req)) || {};
  const text = String(body.body ?? '').trim();
  if (!text) return badReq(res, 'body_required');
  const { rows } = await q(
    `INSERT INTO sales.note (tenant_id, lead_id, body, author_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, lead_id, body, author_id, created_at`,
    [req.tenant.id, leadId, text, req.user?.sub ?? null],
  );
  recordAudit({ req, action: 'create', resource: 'sales.note', resourceId: rows[0].id, payload: { after: rows[0] } });
  // Sprint 2A — dual-write into the unified activity timeline.
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: leadId,
    kind: 'note', source: 'manual',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text, occurredAt: rows[0].created_at,
    metadata: { note_id: rows[0].id },
  }).catch(() => {});
  created(res, rows[0]);
}

export async function remove(req, res, id) {
  const beforeRes = await q(
    `SELECT id, lead_id, body, author_id, created_at FROM sales.note
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  const before = beforeRes.rows[0] ?? null;
  const { rowCount } = await q(
    `DELETE FROM sales.note WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rowCount === 0) return notFound(res);
  recordAudit({ req, action: 'delete', resource: 'sales.note', resourceId: id, payload: { before } });
  ok(res, { id });
}
