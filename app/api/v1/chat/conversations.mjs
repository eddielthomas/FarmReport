// =============================================================================
// /api/v1/chat/conversations — Phase 1 REST surface (EPIC-005 S3A).
// -----------------------------------------------------------------------------
// Tenant-scoped CRUD over chat.conversation. RBAC perm gate is crm.chat.read
// for reads and crm.chat.write for mutations; membership-based authz on the
// per-:id routes via requireConversationMember (see lib/membership.mjs).
//
// Every mutation emits recordAudit and a sales.activity row (best-effort) so
// the unified timeline reflects chat envelope lifecycle.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, parseQuery } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { publishChatEvent } from '../lib/chat-relay.mjs';
import { requireConversationMember } from './lib/membership.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SCOPE_KINDS = new Set(['lead','case','vendor','customer','team','project']);
const VALID_STATUS      = new Set(['open','archived','locked','deleted']);
const VALID_CHANNEL     = new Set(['in_app','email','sms','external']);

// Map a scope_kind to the sales.activity entity_kind vocabulary so we can
// mirror chat lifecycle into the activity timeline. Customer/team/project
// scopes are not in the activity enum so we elide the activity for them.
const SCOPE_TO_ACTIVITY_ENTITY = {
  lead:     'lead',
  case:     null, // ops.case lives in a separate timeline
  vendor:   'vendor',
  customer: null,
  team:     null,
  project:  null,
};

const COLS = `id, tenant_id, scope_kind, scope_id, subject, status, channel,
              created_by, created_at, updated_at`;

export async function list(req, res) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const qs = parseQuery(req.url);
  const params = [req.tenant.id];
  let where = 'c.tenant_id = $1';
  if (qs.scope_kind && VALID_SCOPE_KINDS.has(qs.scope_kind)) {
    params.push(qs.scope_kind);
    where += ` AND c.scope_kind = $${params.length}`;
  }
  if (qs.scope_id && UUID_RE.test(qs.scope_id)) {
    params.push(qs.scope_id);
    where += ` AND c.scope_id = $${params.length}`;
  }
  if (qs.status && VALID_STATUS.has(qs.status)) {
    params.push(qs.status);
    where += ` AND c.status = $${params.length}`;
  }

  // Caller can only see conversations they're a member of (left_at IS NULL)
  // UNLESS they have crm.chat.admin / platform.admin.all.
  const perms = req.user?.permissions;
  const isChatAdmin = perms && (perms.has('platform.admin.all') || perms.has('crm.chat.admin'));
  let memberJoin = '';
  if (!isChatAdmin) {
    params.push(req.user?.sub ?? null);
    memberJoin = `JOIN chat.conversation_member m
                    ON m.conversation_id = c.id
                   AND m.user_id = $${params.length}
                   AND m.left_at IS NULL`;
  }

  const limit = Math.min(Number(qs.limit ?? 200), 1000);
  const { rows } = await q(
    `SELECT ${COLS.split(',').map((c) => 'c.' + c.trim()).join(', ')}
       FROM chat.conversation c
       ${memberJoin}
      WHERE ${where}
      ORDER BY c.updated_at DESC
      LIMIT ${limit}`,
    params,
  );
  ok(res, rows);
}

export async function create(req, res) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  const body = (await readBody(req)) || {};
  const scope_kind = String(body.scope_kind ?? '').trim().toLowerCase();
  const scope_id   = String(body.scope_id ?? '').trim();
  if (!VALID_SCOPE_KINDS.has(scope_kind)) return badReq(res, 'scope_kind_invalid');
  if (!UUID_RE.test(scope_id))            return badReq(res, 'scope_id_invalid');

  const subject = String(body.subject ?? '').slice(0, 500);
  const channel = body.channel && VALID_CHANNEL.has(String(body.channel))
    ? String(body.channel) : 'in_app';

  const creatorId = req.user?.sub ?? null;
  if (!creatorId || !UUID_RE.test(creatorId)) return badReq(res, 'caller_not_resolved');

  const { rows } = await q(
    `INSERT INTO chat.conversation
       (tenant_id, scope_kind, scope_id, subject, status, channel, created_by)
     VALUES ($1,$2,$3,$4,'open',$5,$6)
     RETURNING ${COLS}`,
    [req.tenant.id, scope_kind, scope_id, subject, channel, creatorId],
  );
  const row = rows[0];

  // Auto-add creator as owner.
  await q(
    `INSERT INTO chat.conversation_member
       (conversation_id, tenant_id, user_id, role_in_convo)
     VALUES ($1,$2,$3,'owner')
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [row.id, req.tenant.id, creatorId],
  );

  // Optional initial members.
  const seedIds = Array.isArray(body.member_user_ids) ? body.member_user_ids : [];
  for (const uid of seedIds) {
    if (!UUID_RE.test(String(uid))) continue;
    if (uid === creatorId) continue;
    await q(
      `INSERT INTO chat.conversation_member
         (conversation_id, tenant_id, user_id, role_in_convo)
       VALUES ($1,$2,$3,'participant')
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [row.id, req.tenant.id, uid],
    );
  }

  recordAudit({
    req, action: 'chat.conversation.created',
    resource: 'chat.conversation', resourceId: row.id,
    payload: { after: row, seeded_members: seedIds },
  });

  // S6A — fan out chat.conversation.created on the tenant bus so other
  // connected clients can refresh their conversation list without polling.
  publishChatEvent(req.io, 'chat.conversation.created', {
    tenant_id:       req.tenant.id,
    conversation_id: row.id,
    scope_kind:      row.scope_kind,
    scope_id:        row.scope_id,
    subject:         row.subject,
    channel:         row.channel,
    created_by:      row.created_by,
    created_at:      row.created_at,
  });

  const activityEntity = SCOPE_TO_ACTIVITY_ENTITY[scope_kind];
  if (activityEntity) {
    emitActivity({
      tenantId: req.tenant.id,
      entityKind: activityEntity, entityId: scope_id,
      kind: 'system', source: 'system',
      actorId: creatorId, actorLabel: req.user?.email ?? null,
      text: `Conversation opened: ${subject || '(no subject)'}`,
      metadata: { conversation_id: row.id, scope_kind },
    }).catch(() => {});
  }
  created(res, row);
}

export async function get(req, res, id) {
  if (!requirePermission(req, res, 'crm.chat.read')) return;
  const conv = await requireConversationMember(req, res, id, { scope: 'read' });
  if (!conv) return;
  // Return the canonical row + members for parity with the OpenAPI spec.
  const m = await q(
    `SELECT user_id, role_in_convo, joined_at, left_at, notify_on_message
       FROM chat.conversation_member
      WHERE conversation_id = $1 AND tenant_id = $2`,
    [id, req.tenant.id],
  );
  ok(res, {
    id: conv.id, tenant_id: conv.tenant_id,
    scope_kind: conv.scope_kind, scope_id: conv.scope_id,
    subject: conv.subject, status: conv.status, channel: conv.channel,
    created_by: conv.created_by, created_at: conv.created_at, updated_at: conv.updated_at,
    members: m.rows,
  });
}

export async function update(req, res, id) {
  if (!requirePermission(req, res, 'crm.chat.write')) return;
  const conv = await requireConversationMember(req, res, id, { scope: 'admin' });
  if (!conv) return;
  const body = (await readBody(req)) || {};

  const fields = []; const params = [req.tenant.id, id]; let i = 3;
  if (body.subject !== undefined) {
    fields.push(`subject = $${i++}`); params.push(String(body.subject).slice(0, 500));
  }
  if (body.status !== undefined) {
    const s = String(body.status).toLowerCase();
    if (!VALID_STATUS.has(s)) return badReq(res, 'status_invalid');
    fields.push(`status = $${i++}`); params.push(s);
  }
  if (body.channel !== undefined) {
    const ch = String(body.channel).toLowerCase();
    if (!VALID_CHANNEL.has(ch)) return badReq(res, 'channel_invalid');
    fields.push(`channel = $${i++}`); params.push(ch);
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');

  const { rows } = await q(
    `UPDATE chat.conversation SET ${fields.join(', ')}
      WHERE tenant_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );

  let action = 'chat.conversation.updated';
  if (body.status === 'archived') action = 'chat.conversation.archived';
  if (body.status === 'deleted')  action = 'chat.conversation.deleted';

  const before = {
    subject: conv.subject, status: conv.status, channel: conv.channel,
  };
  recordAudit({
    req, action,
    resource: 'chat.conversation', resourceId: id,
    payload: { before, after: rows[0] },
  });
  ok(res, rows[0]);
}
