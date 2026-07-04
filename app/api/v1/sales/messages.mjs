// =============================================================================
// /api/v1/sales/leads/:id/messages — chat thread per lead.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';

export async function listForLead(req, res, leadId) {
  const { rows } = await q(
    `SELECT id, lead_id, sender, body, attachments, created_at
       FROM sales.message
      WHERE tenant_id = $1 AND lead_id = $2
      ORDER BY created_at ASC`,
    [req.tenant.id, leadId],
  );
  ok(res, rows);
}

export async function createForLead(req, res, leadId) {
  const body = (await readBody(req).catch(() => null)) || {};
  const roles = req.user?.roles ?? [];
  const isCustomer = roles.includes('customer:view') && !roles.includes('sales:manage');
  // Default sender by role: customers post as 'contact'; staff post as 'agent'.
  const senderRaw = body.sender ?? (isCustomer ? 'contact' : 'agent');
  const sender = String(senderRaw).trim();
  const text   = String(body.body ?? '').trim();
  if (!text) return badReq(res, 'body_required');
  if (sender !== 'agent' && sender !== 'contact') return badReq(res, 'sender_must_be_agent_or_contact');

  // Guard: lead must exist in this tenant. Prevents FK violations from
  // bubbling as 500s when callers reuse a stale or cross-tenant id.
  const guard = await q(
    `SELECT 1 FROM sales.lead WHERE id = $1 AND tenant_id = $2`,
    [leadId, req.tenant.id],
  );
  if (guard.rows.length === 0) return notFound(res);

  try {
    const { rows } = await q(
      `INSERT INTO sales.message (tenant_id, lead_id, sender, body, attachments)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, lead_id, sender, body, attachments, created_at`,
      [req.tenant.id, leadId, sender, text, JSON.stringify(body.attachments ?? [])],
    );
    recordAudit({ req, action: 'create', resource: 'sales.message', resourceId: rows[0].id, payload: { after: rows[0] } });
    // Sprint 2A — dual-write into the unified activity timeline.
    emitActivity({
      tenantId: req.tenant.id, entityKind: 'lead', entityId: leadId,
      kind: 'message', source: 'manual',
      actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
      text, occurredAt: rows[0].created_at,
      metadata: { message_id: rows[0].id, sender, attachments: rows[0].attachments },
    }).catch(() => {});
    created(res, rows[0]);
  } catch (err) {
    // Race: lead was deleted between guard and insert. Surface as 404, not 500.
    if (err?.code === '23503') return notFound(res);
    throw err;
  }
}
