// =============================================================================
// chat/lib/membership.mjs — membership-based authz helper for /chat/* routes.
// -----------------------------------------------------------------------------
// requireConversationMember(req, res, conversationId, opts)
//   - Returns the conversation row (with caller's role_in_convo) on success.
//   - Writes 404 when the conversation does not exist in the caller's tenant.
//   - Writes 403 when the caller is not a current member AND lacks the
//     `crm.chat.admin` permission (audited as authz.denied by requirePermission's
//     companion path; here we emit an authz.denied audit directly).
//   - Writes 410 when the conversation is soft-deleted.
//   - Writes 409 when the conversation is locked and opts.scope === 'write'.
//
// platform admin / crm.chat.admin override is explicit + audited.
// =============================================================================

import { q } from '../../db/pool.mjs';
import { forbid, notFound, send } from '../../http.mjs';
import { recordAudit } from '../../audit.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasChatAdmin(req) {
  const perms = req.user?.permissions;
  if (!perms) return false;
  return perms.has('platform.admin.all') || perms.has('crm.chat.admin');
}

// Loads the conversation + caller membership in one round-trip.
async function loadConversation(req, conversationId) {
  const userId = req.user?.sub ?? null;
  const { rows } = await q(
    `SELECT c.id, c.tenant_id, c.scope_kind, c.scope_id, c.subject,
            c.status, c.channel, c.created_by, c.created_at, c.updated_at,
            m.role_in_convo,
            m.left_at
       FROM chat.conversation c
       LEFT JOIN chat.conversation_member m
         ON m.conversation_id = c.id AND m.user_id = $3
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, req.tenant.id, userId],
  );
  return rows[0] ?? null;
}

/**
 * Gate /chat/conversations/:id/* routes.
 *
 * @param {object} req
 * @param {object} res
 * @param {string} conversationId
 * @param {{ scope?: 'read'|'write'|'admin' }} opts
 * @returns {Promise<null | object>} conversation row (with role_in_convo) when
 *   the caller is allowed; null when a response was already written.
 */
export async function requireConversationMember(req, res, conversationId, opts = {}) {
  if (!UUID_RE.test(String(conversationId ?? ''))) {
    notFound(res); return null;
  }
  const conv = await loadConversation(req, conversationId);
  if (!conv) { notFound(res); return null; }

  const scope = opts.scope ?? 'read';

  // Hard-stop on deleted conversations regardless of role.
  if (conv.status === 'deleted') {
    send(res, 410, { success: false, error: 'conversation_deleted' });
    return null;
  }
  // Locked conversations are readable but not writable.
  if (conv.status === 'locked' && scope === 'write') {
    send(res, 409, { success: false, error: 'conversation_locked' });
    return null;
  }

  const isMember = conv.role_in_convo != null && conv.left_at == null;
  if (isMember) {
    // admin scope still requires owner role within the conversation OR
    // crm.chat.admin override.
    if (scope === 'admin' && conv.role_in_convo !== 'owner' && !hasChatAdmin(req)) {
      try {
        recordAudit({
          req, action: 'authz.denied',
          resource: 'chat.conversation', resourceId: conversationId,
          payload: { required: 'owner_or_chat_admin', role_in_convo: conv.role_in_convo },
        });
      } catch (_e) { /* best-effort */ }
      forbid(res, 'owner_or_chat_admin_required');
      return null;
    }
    return conv;
  }

  // Non-member: only `crm.chat.admin` (or platform.admin.all) can pass.
  if (hasChatAdmin(req)) {
    try {
      recordAudit({
        req, action: 'chat.admin_override_access',
        resource: 'chat.conversation', resourceId: conversationId,
        payload: { scope, reason: 'crm.chat.admin override' },
      });
    } catch (_e) { /* best-effort */ }
    return conv;
  }

  try {
    recordAudit({
      req, action: 'authz.denied',
      resource: 'chat.conversation', resourceId: conversationId,
      payload: { required: 'conversation_member', scope },
    });
  } catch (_e) { /* best-effort */ }
  forbid(res, 'not_a_conversation_member');
  return null;
}
