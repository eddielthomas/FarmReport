// =============================================================================
// /api/v1/chat/conversations/:id/members — Phase 1 REST surface.
// -----------------------------------------------------------------------------
// AuthZ: owner-of-convo OR crm.chat.admin / platform.admin.all override.
// Delete is a soft-remove (sets left_at = now()) so historical attribution
// survives.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, noContent } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { requireConversationMember } from './lib/membership.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLE = new Set(['owner','participant','observer','external']);

export async function list(req, res, conversationId) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'read' });
  if (!conv) return;
  const { rows } = await q(
    `SELECT conversation_id, user_id, role_in_convo, joined_at, left_at, notify_on_message
       FROM chat.conversation_member
      WHERE conversation_id = $1 AND tenant_id = $2
      ORDER BY joined_at ASC`,
    [conversationId, req.tenant.id],
  );
  ok(res, rows);
}

export async function add(req, res, conversationId) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'admin' });
  if (!conv) return;
  const body = (await readBody(req)) || {};
  const userId = String(body.user_id ?? '').trim();
  if (!UUID_RE.test(userId)) return badReq(res, 'user_id_invalid');

  const role = body.role_in_convo && VALID_ROLE.has(String(body.role_in_convo))
    ? String(body.role_in_convo) : 'participant';

  // Verify user belongs to the same tenant before adding.
  const guard = await q(
    `SELECT 1 FROM iam.user_profile
      WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
    [userId, req.tenant.id],
  );
  if (guard.rows.length === 0) return badReq(res, 'user_not_in_tenant');

  // If the user is already a member, reactivate by clearing left_at.
  const upsert = await q(
    `INSERT INTO chat.conversation_member
       (conversation_id, tenant_id, user_id, role_in_convo, joined_at, left_at)
     VALUES ($1,$2,$3,$4, now(), NULL)
     ON CONFLICT (conversation_id, user_id) DO UPDATE
       SET role_in_convo = EXCLUDED.role_in_convo,
           left_at       = NULL
     RETURNING conversation_id, user_id, role_in_convo, joined_at, left_at`,
    [conversationId, req.tenant.id, userId, role],
  );
  const row = upsert.rows[0];

  recordAudit({
    req, action: 'chat.member.added',
    resource: 'chat.conversation_member', resourceId: userId,
    payload: { conversation_id: conversationId, role_in_convo: role, after: row },
  });
  created(res, row);
}

export async function remove(req, res, conversationId, userId) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  const conv = await requireConversationMember(req, res, conversationId, { scope: 'admin' });
  if (!conv) return;
  if (!UUID_RE.test(String(userId))) return notFound(res);

  const before = await q(
    `SELECT conversation_id, user_id, role_in_convo, joined_at, left_at
       FROM chat.conversation_member
      WHERE conversation_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, req.tenant.id, userId],
  );
  if (before.rows.length === 0) return notFound(res);
  if (before.rows[0].left_at != null) return noContent(res); // already removed

  await q(
    `UPDATE chat.conversation_member
        SET left_at = now()
      WHERE conversation_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, req.tenant.id, userId],
  );
  recordAudit({
    req, action: 'chat.member.removed',
    resource: 'chat.conversation_member', resourceId: userId,
    payload: { conversation_id: conversationId, before: before.rows[0] },
  });
  noContent(res);
}
