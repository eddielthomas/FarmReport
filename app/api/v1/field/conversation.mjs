// =============================================================================
// /api/v1/field/jobs/:id/conversation + /field/ops-channel — S17 messaging.
// -----------------------------------------------------------------------------
// Thin field bootstrap over the existing chat envelope (chat.conversation +
// chat.conversation_member + /chat/conversations/:id/messages). We DO NOT add a
// new message store — once bootstrapped, the field PWA uses the canonical chat
// REST + socket surface.
//
//   POST /field/jobs/:id/conversation  -> get-or-create kind 'field_job' for
//        the job. Participants: assigned tech + job creator + ops/manager-role
//        members of the tenant. Returns { conversation_id }.
//   GET  /field/ops-channel            -> get-or-create the tenant-wide kind
//        'field_ops' channel. Participants: ops/manager-role members + caller.
//        Returns { conversation_id }.
//
// Both reuse the chat tables via q() (same pattern as chat/conversations.mjs —
// chat RLS is tenant-keyed and the app role passes it). recordAudit fires on
// every conversation CREATE (get path is read-only, no audit).
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { publishChatEvent } from '../lib/chat-relay.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Manager/ops role keys whose tenant members are auto-pulled into field threads.
const OPS_ROLE_KEYS = ['ops.manager', 'sales.manager', 'tenant.admin'];

// Resolve the distinct user ids in this tenant holding any ops/manager role.
async function opsMemberIds(tenantId) {
  const { rows } = await q(
    `SELECT DISTINCT up.id
       FROM iam.user_profile up
       JOIN iam.user_role ur ON ur.user_id = up.id
       JOIN iam.role r       ON r.id = ur.role_id
      WHERE up.tenant_id = $1
        AND r.key = ANY($2::text[])
        AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [tenantId, OPS_ROLE_KEYS],
  );
  return rows.map((r) => r.id);
}

async function addMember(conversationId, tenantId, userId, role) {
  if (!UUID_RE.test(String(userId ?? ''))) return;
  await q(
    `INSERT INTO chat.conversation_member
       (conversation_id, tenant_id, user_id, role_in_convo)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, tenantId, userId, role],
  );
}

// ---- POST /field/jobs/:id/conversation -------------------------------------
export async function jobConversation(req, res, jobId) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const tenantId = req.tenant.id;
  const callerId = req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null;
  if (!callerId) return badReq(res, 'caller_not_resolved');

  // Job lookup (also yields assignee + creator for participant seeding).
  const jres = await q(
    `SELECT id, title, assigned_to, created_by FROM field.job
      WHERE id = $1 AND tenant_id = $2`,
    [jobId, tenantId],
  );
  if (jres.rows.length === 0) return notFound(res);
  const job = jres.rows[0];

  // Get-or-create: one field_job conversation per (tenant, job).
  const existing = await q(
    `SELECT id FROM chat.conversation
      WHERE tenant_id = $1 AND scope_kind = 'field_job' AND scope_id = $2
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, jobId],
  );

  let conversationId;
  let createdNew = false;
  if (existing.rows.length > 0) {
    conversationId = existing.rows[0].id;
  } else {
    const ins = await q(
      `INSERT INTO chat.conversation
         (tenant_id, scope_kind, scope_id, subject, status, channel, created_by)
       VALUES ($1,'field_job',$2,$3,'open','in_app',$4)
       RETURNING id, created_at`,
      [tenantId, jobId, `Job: ${String(job.title ?? '').slice(0, 480)}`, callerId],
    );
    conversationId = ins.rows[0].id;
    createdNew = true;
  }

  // Seed participants: caller (owner), assignee, creator, ops/manager members.
  await addMember(conversationId, tenantId, callerId, 'owner');
  if (job.assigned_to) await addMember(conversationId, tenantId, job.assigned_to, 'participant');
  if (job.created_by)  await addMember(conversationId, tenantId, job.created_by, 'participant');
  for (const uid of await opsMemberIds(tenantId)) {
    await addMember(conversationId, tenantId, uid, 'participant');
  }

  if (createdNew) {
    recordAudit({
      req, action: 'field.job.conversation.created',
      resource: 'chat.conversation', resourceId: conversationId,
      payload: { job_id: jobId, scope_kind: 'field_job' },
    });
    publishChatEvent(req.io, 'chat.conversation.created', {
      tenant_id: tenantId, conversation_id: conversationId,
      scope_kind: 'field_job', scope_id: jobId,
      subject: `Job: ${job.title}`, channel: 'in_app',
      created_by: callerId, created_at: new Date().toISOString(),
    });
  }
  ok(res, { conversation_id: conversationId });
}

// ---- GET /field/ops-channel -------------------------------------------------
export async function opsChannel(req, res) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const tenantId = req.tenant.id;
  const callerId = req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null;
  if (!callerId) return badReq(res, 'caller_not_resolved');

  // Get-or-create: a single tenant-wide field_ops channel. scope_id == tenant_id.
  const existing = await q(
    `SELECT id FROM chat.conversation
      WHERE tenant_id = $1 AND scope_kind = 'field_ops'
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  );

  let conversationId;
  let createdNew = false;
  if (existing.rows.length > 0) {
    conversationId = existing.rows[0].id;
  } else {
    const ins = await q(
      `INSERT INTO chat.conversation
         (tenant_id, scope_kind, scope_id, subject, status, channel, created_by)
       VALUES ($1,'field_ops',$1,'Field Ops Channel','open','in_app',$2)
       RETURNING id`,
      [tenantId, callerId],
    );
    conversationId = ins.rows[0].id;
    createdNew = true;
  }

  // Always ensure the caller + ops members are present (channel membership grows
  // as new techs/managers open it).
  await addMember(conversationId, tenantId, callerId, 'participant');
  for (const uid of await opsMemberIds(tenantId)) {
    await addMember(conversationId, tenantId, uid, 'participant');
  }

  if (createdNew) {
    recordAudit({
      req, action: 'field.ops_channel.created',
      resource: 'chat.conversation', resourceId: conversationId,
      payload: { scope_kind: 'field_ops' },
    });
    publishChatEvent(req.io, 'chat.conversation.created', {
      tenant_id: tenantId, conversation_id: conversationId,
      scope_kind: 'field_ops', scope_id: tenantId,
      subject: 'Field Ops Channel', channel: 'in_app',
      created_by: callerId, created_at: new Date().toISOString(),
    });
  } else {
    // ensureMember on the get path is a DML write; the gate scans the function
    // body for recordAudit. Membership joins are audit-worthy as access grants.
    recordAudit({
      req, action: 'field.ops_channel.joined',
      resource: 'chat.conversation', resourceId: conversationId,
      payload: { scope_kind: 'field_ops', user_id: callerId },
    });
  }
  ok(res, { conversation_id: conversationId });
}
