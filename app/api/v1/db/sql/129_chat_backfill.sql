-- =============================================================================
-- 129_chat_backfill.sql — Lift sales.message into chat.conversation / chat.message.
-- -----------------------------------------------------------------------------
-- For every distinct (tenant_id, lead_id) in sales.message, fabricate a
-- chat.conversation row with scope_kind='lead' and scope_id=lead_id, then
-- copy each sales.message into chat.message under that conversation.
--
-- Seeds chat.conversation_member from sales.assignment (active owner/colab/
-- support rows) when present. The sales.message table stays in place and
-- the legacy REST endpoints keep working.
--
-- ALL writes are guarded so re-runs are no-ops:
--   - chat.conversation       INSERT ... WHERE NOT EXISTS (one row per (tenant,lead))
--   - chat.message            INSERT ... WHERE NOT EXISTS (uses sales.message.id)
--   - chat.conversation_member ON CONFLICT DO NOTHING
--
-- Idempotent. Safe to re-run.
-- =============================================================================

BEGIN;

-- ---- 1) Fabricate one chat.conversation per (tenant_id, lead_id) -----------
-- created_by: pick any platform/tenant admin in the tenant; fall back to the
-- zero UUID so the NOT NULL constraint is satisfied even on tenants without
-- a seeded admin (legacy seed data).
INSERT INTO chat.conversation
       (id, tenant_id, scope_kind, scope_id, subject, status, channel,
        created_by, created_at, updated_at)
SELECT gen_random_uuid(),
       m.tenant_id,
       'lead',
       m.lead_id,
       COALESCE(l.name, 'Lead conversation'),
       'open',
       'in_app',
       COALESCE(
         (SELECT up.id FROM iam.user_profile up
           WHERE up.tenant_id = m.tenant_id
             AND ('platform:admin' = ANY(up.roles) OR 'sales:manage' = ANY(up.roles))
           ORDER BY up.created_at ASC LIMIT 1),
         '00000000-0000-0000-0000-000000000000'::uuid
       ),
       MIN(m.created_at),
       MAX(m.created_at)
  FROM sales.message m
  LEFT JOIN sales.lead l ON l.id = m.lead_id AND l.tenant_id = m.tenant_id
 WHERE NOT EXISTS (
   SELECT 1 FROM chat.conversation c
    WHERE c.tenant_id = m.tenant_id
      AND c.scope_kind = 'lead'
      AND c.scope_id = m.lead_id
 )
 GROUP BY m.tenant_id, m.lead_id, l.name;

-- ---- 2) Copy sales.message rows into chat.message --------------------------
-- We reuse sales.message.id as the chat.message.id so the no-op guard below
-- works on subsequent re-runs.
INSERT INTO chat.message
       (id, tenant_id, conversation_id, sender_user_id, sender_kind,
        body, body_html, attachments, reply_to_id, created_at)
SELECT m.id,
       m.tenant_id,
       c.id,
       NULL,
       CASE m.sender
         WHEN 'agent'   THEN 'agent'
         WHEN 'contact' THEN 'contact'
         WHEN 'vendor'  THEN 'vendor'
         ELSE 'system'
       END,
       m.body,
       NULL,
       COALESCE(m.attachments, '[]'::jsonb),
       NULL,
       m.created_at
  FROM sales.message m
  JOIN chat.conversation c
    ON c.tenant_id  = m.tenant_id
   AND c.scope_kind = 'lead'
   AND c.scope_id   = m.lead_id
 WHERE NOT EXISTS (
   SELECT 1 FROM chat.message x WHERE x.id = m.id
 );

-- ---- 3) Seed chat.conversation_member from active sales.assignment ---------
-- For each backfilled lead-conversation, add every still-active assignee
-- (released_at IS NULL) as a member. owners become role_in_convo='owner';
-- collaborators/support become 'participant'.
INSERT INTO chat.conversation_member
       (conversation_id, tenant_id, user_id, role_in_convo, joined_at)
SELECT c.id,
       c.tenant_id,
       a.user_id,
       CASE WHEN a.role = 'owner' THEN 'owner' ELSE 'participant' END,
       COALESCE(a.assigned_at, c.created_at)
  FROM chat.conversation c
  JOIN sales.assignment a
    ON a.tenant_id   = c.tenant_id
   AND a.entity_kind = 'lead'
   AND a.entity_id   = c.scope_id
   AND a.released_at IS NULL
 WHERE c.scope_kind = 'lead'
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- ---- 4) Ensure the conversation creator is a member (owner) ----------------
-- Belt-and-braces: if step 3 produced no members for a conversation, at
-- least the created_by user joins as owner. Skips the zero-UUID fallback.
INSERT INTO chat.conversation_member
       (conversation_id, tenant_id, user_id, role_in_convo, joined_at)
SELECT c.id, c.tenant_id, c.created_by, 'owner', c.created_at
  FROM chat.conversation c
 WHERE c.created_by <> '00000000-0000-0000-0000-000000000000'::uuid
ON CONFLICT (conversation_id, user_id) DO NOTHING;

COMMIT;
