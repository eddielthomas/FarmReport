// =============================================================================
// /api/v1/chat/conversations/:id/messages — Phase 1 REST surface.
// -----------------------------------------------------------------------------
// Membership-gated; every mutation emits recordAudit + sales.activity.
// Append-only by DB trigger (chat.fn_message_immutable_guard); UPDATE/DELETE
// are not exposed at the REST layer for Phase 1.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, noContent, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { publishChatEvent } from '../lib/chat-relay.mjs';
import { requireConversationMember } from './lib/membership.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCOPE_TO_ACTIVITY_ENTITY = {
  lead: 'lead', case: null, vendor: 'vendor',
  customer: null, team: null, project: null,
};

const COLS = `id, tenant_id, conversation_id, sender_user_id, sender_kind,
              body, body_html, attachments, reply_to_id, created_at`;

export async function listForConversation(req, res, conversationId) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'read' });
  if (!conv) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id, conversationId];
  let where = 'm.tenant_id = $1 AND m.conversation_id = $2';
  if (qs.before && !Number.isNaN(Date.parse(qs.before))) {
    params.push(qs.before);
    where += ` AND m.created_at < $${params.length}::timestamptz`;
  }
  if (qs.after && !Number.isNaN(Date.parse(qs.after))) {
    params.push(qs.after);
    where += ` AND m.created_at > $${params.length}::timestamptz`;
  }
  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS.split(',').map((c) => 'm.' + c.trim()).join(', ')},
            COALESCE(
              (SELECT array_agg(r.user_id) FROM chat.message_read r WHERE r.message_id = m.id),
              ARRAY[]::uuid[]
            ) AS read_by
       FROM chat.message m
      WHERE ${where}
      ORDER BY m.created_at ASC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function createForConversation(req, res, conversationId) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'write' });
  if (!conv) return;
  const body = (await readBody(req)) || {};
  const text = String(body.body ?? '').trim();
  if (!text) return badReq(res, 'body_required');
  if (text.length > 65535) return badReq(res, 'body_too_long');

  const senderUserId = req.user?.sub ?? null;
  if (!senderUserId || !UUID_RE.test(senderUserId)) {
    return badReq(res, 'caller_not_resolved');
  }
  const roles = req.user?.roles ?? [];
  const senderKind = roles.includes('customer:view') && !roles.includes('sales:manage')
    ? 'contact'
    : (roles.includes('vendor:view') ? 'vendor' : 'agent');

  const replyTo = body.reply_to_id && UUID_RE.test(String(body.reply_to_id))
    ? String(body.reply_to_id) : null;
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  const { rows } = await q(
    `INSERT INTO chat.message
       (tenant_id, conversation_id, sender_user_id, sender_kind, body, body_html,
        attachments, reply_to_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     RETURNING ${COLS}`,
    [
      req.tenant.id, conversationId, senderUserId, senderKind,
      text, body.body_html ?? null,
      JSON.stringify(attachments), replyTo,
    ],
  );
  const row = rows[0];

  // Touch the conversation so list ordering reflects activity.
  await q(
    `UPDATE chat.conversation SET updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, conversationId],
  );

  recordAudit({
    req, action: 'chat.message.sent',
    resource: 'chat.message', resourceId: row.id,
    payload: { after: row, conversation_id: conversationId },
  });

  // S6A — fan out chat.message.sent to the conversation room so connected
  // socket.io clients render the new bubble without polling. The relay is a
  // no-op when req.io is not bound (unit tests, REST-only test rigs).
  publishChatEvent(req.io, 'chat.message.sent', {
    tenant_id:       req.tenant.id,
    conversation_id: conversationId,
    message: {
      id:              row.id,
      sender_user_id:  row.sender_user_id,
      sender_kind:     row.sender_kind,
      body:            row.body,
      body_html:       row.body_html,
      attachments:     row.attachments,
      reply_to_id:     row.reply_to_id,
      created_at:      row.created_at,
    },
  });

  const activityEntity = SCOPE_TO_ACTIVITY_ENTITY[conv.scope_kind];
  if (activityEntity) {
    emitActivity({
      tenantId: req.tenant.id,
      entityKind: activityEntity, entityId: conv.scope_id,
      kind: 'message', source: 'manual',
      actorId: senderUserId, actorLabel: req.user?.email ?? null,
      text, occurredAt: row.created_at,
      metadata: {
        conversation_id: conversationId, message_id: row.id,
        sender_kind: senderKind, attachments_count: attachments.length,
      },
    }).catch(() => {});
  }

  created(res, row);
}

export async function markRead(req, res, conversationId, messageId) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'read' });
  if (!conv) return;
  if (!UUID_RE.test(String(messageId))) return notFound(res);

  // Confirm the message belongs to this conversation in tenant scope before
  // inserting (FK alone would let through cross-tenant ids when the caller
  // forges a path).
  const guard = await q(
    `SELECT 1 FROM chat.message
      WHERE id = $1 AND conversation_id = $2 AND tenant_id = $3`,
    [messageId, conversationId, req.tenant.id],
  );
  if (guard.rows.length === 0) return notFound(res);

  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  await q(
    `INSERT INTO chat.message_read (message_id, tenant_id, user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (message_id, user_id) DO NOTHING`,
    [messageId, req.tenant.id, userId],
  );
  // No audit emission — read receipts are intentionally not audit-worthy
  // (per plan section 9 "audit emission" table; read events are tracked via
  // chat.message_read itself).
  recordAudit({
    req, action: 'chat.message.read',
    resource: 'chat.message', resourceId: messageId,
    payload: { conversation_id: conversationId, reader: userId },
  });

  // S6A — broadcast read receipt to the conversation room.
  publishChatEvent(req.io, 'chat.message.read', {
    tenant_id:       req.tenant.id,
    conversation_id: conversationId,
    message_id:      messageId,
    user_id:         userId,
    read_at:         new Date().toISOString(),
  });

  noContent(res);
}
