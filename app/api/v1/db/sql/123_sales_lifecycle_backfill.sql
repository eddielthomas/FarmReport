-- =============================================================================
-- 123_sales_lifecycle_backfill.sql — Sprint 2A backfill.
-- -----------------------------------------------------------------------------
-- Idempotent (WHERE NOT EXISTS / ON CONFLICT DO NOTHING). Re-running is a no-op.
--   - distinct lower(company)        -> sales.organization
--   - per-lead person fields         -> sales.contact (1:1 anchored on email)
--   - (contact, lead)                -> sales.contact_lead
--   - lead.organization_id / primary_contact_id populated
--   - lead.total_revenue (Client + > 0) -> sales.revenue_record (status=booked)
--   - sales.note / sales.status_history / sales.message -> sales.activity mirrors
--
-- This file deliberately does NOT touch the constraint catalog (122 already did
-- that). Subsequent re-runs guard with NOT EXISTS so triggers stay quiet.
-- =============================================================================

BEGIN;

-- ---- 0) Normalize sales.lead.source into the spec vocabulary ---------------
-- Bucket free-text values into the 5-value spec enum so the strict CHECK
-- constraint added at the end of this migration applies cleanly.
UPDATE sales.lead SET source = CASE
  WHEN source IS NULL OR source = ''           THEN NULL
  WHEN source IN ('Agent','RWR Generated','Vendor','Direct','Social Media')
       THEN source
  WHEN source ILIKE '%agent%'                  THEN 'Agent'
  WHEN source ILIKE '%rwr%'                    THEN 'RWR Generated'
  WHEN source ILIKE '%vendor%'                 THEN 'Vendor'
  WHEN source ILIKE '%social%'
    OR source ILIKE '%linkedin%'
    OR source ILIKE '%twitter%'
    OR source ILIKE '%facebook%'
    OR source ILIKE '%instagram%'              THEN 'Social Media'
  WHEN source ILIKE '%direct%'
    OR source ILIKE '%website%'
    OR source ILIKE '%form%'                   THEN 'Direct'
  ELSE                                              'Direct'
END
WHERE source IS NOT NULL
  AND source NOT IN ('Agent','RWR Generated','Vendor','Direct','Social Media');

-- ---- 1) Organizations from distinct lower(company) -------------------------
INSERT INTO sales.organization (tenant_id, name, status)
SELECT DISTINCT l.tenant_id, trim(l.company), 'active'
  FROM sales.lead l
 WHERE l.company IS NOT NULL
   AND trim(l.company) <> ''
ON CONFLICT (tenant_id, lower(name)) DO NOTHING;

-- Attach lead.organization_id (only when currently NULL).
UPDATE sales.lead l
   SET organization_id = o.id
  FROM sales.organization o
 WHERE l.organization_id IS NULL
   AND l.tenant_id = o.tenant_id
   AND l.company IS NOT NULL
   AND lower(trim(l.company)) = lower(o.name);

-- ---- 2) Contacts from per-lead person fields -------------------------------
INSERT INTO sales.contact
  (tenant_id, organization_id, first_name, last_name, email, phone,
   title, position, status)
SELECT
  l.tenant_id,
  l.organization_id,
  split_part(l.name, ' ', 1)                                  AS first_name,
  NULLIF(regexp_replace(coalesce(l.name,''), '^\S+\s*', ''), '') AS last_name,
  l.email,
  l.phone,
  l.position                                                  AS title,
  l.position                                                  AS position,
  'active'
  FROM sales.lead l
 WHERE coalesce(l.email,'') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM sales.contact c
      WHERE c.tenant_id = l.tenant_id
        AND lower(c.email) = lower(l.email)
   );

-- ---- 3) sales.contact_lead m:n link rows -----------------------------------
INSERT INTO sales.contact_lead (tenant_id, contact_id, lead_id, role)
SELECT l.tenant_id, c.id, l.id, 'primary'
  FROM sales.lead l
  JOIN sales.contact c
    ON c.tenant_id = l.tenant_id
   AND lower(c.email) = lower(l.email)
 WHERE coalesce(l.email,'') <> ''
ON CONFLICT (tenant_id, contact_id, lead_id) DO NOTHING;

-- ---- 4) Lead.primary_contact_id --------------------------------------------
UPDATE sales.lead l
   SET primary_contact_id = c.id
  FROM sales.contact c
 WHERE l.primary_contact_id IS NULL
   AND l.tenant_id = c.tenant_id
   AND coalesce(l.email,'') <> ''
   AND lower(c.email) = lower(l.email);

-- ---- 5) total_revenue scalar -> revenue_record rows ------------------------
INSERT INTO sales.revenue_record
  (tenant_id, client_lead_id, organization_id, amount, currency,
   recognized_at, status, metadata)
SELECT
  l.tenant_id,
  l.id,
  l.organization_id,
  l.total_revenue,
  'USD',
  COALESCE((l.status_timestamps->>'convertedToClientAt')::timestamptz, l.created_at),
  'booked',
  jsonb_build_object('backfill','p003','source_column','sales.lead.total_revenue')
  FROM sales.lead l
 WHERE l.total_revenue > 0
   AND NOT EXISTS (
     SELECT 1 FROM sales.revenue_record rr
      WHERE rr.tenant_id = l.tenant_id
        AND rr.client_lead_id = l.id
        AND (rr.metadata->>'backfill') = 'p003'
   );

-- ---- 6) Mirror sales.status_history -> sales.activity ----------------------
INSERT INTO sales.activity
  (tenant_id, entity_kind, entity_id, kind, source, actor_id, text, occurred_at, metadata)
SELECT
  sh.tenant_id,
  'lead'::sales.activity_entity_kind_t,
  sh.lead_id,
  'status_change'::sales.activity_kind_t,
  'system',
  sh.changed_by,
  format('Status changed: %s -> %s', coalesce(sh.from_status,'(new)'), sh.to_status),
  sh.changed_at,
  jsonb_build_object('backfill','p003','from', sh.from_status, 'to', sh.to_status, 'note', sh.note)
  FROM sales.status_history sh
 WHERE NOT EXISTS (
   SELECT 1 FROM sales.activity a
    WHERE a.tenant_id = sh.tenant_id
      AND a.entity_kind = 'lead'
      AND a.entity_id = sh.lead_id
      AND a.kind = 'status_change'
      AND a.occurred_at = sh.changed_at
      AND (a.metadata->>'backfill') = 'p003'
 );

-- ---- 7) Mirror sales.note -> sales.activity --------------------------------
INSERT INTO sales.activity
  (tenant_id, entity_kind, entity_id, kind, source, actor_id, text, occurred_at, metadata)
SELECT
  n.tenant_id,
  'lead'::sales.activity_entity_kind_t,
  n.lead_id,
  'note'::sales.activity_kind_t,
  'manual',
  n.author_id,
  n.body,
  n.created_at,
  jsonb_build_object('backfill','p003','note_id', n.id)
  FROM sales.note n
 WHERE NOT EXISTS (
   SELECT 1 FROM sales.activity a
    WHERE a.tenant_id = n.tenant_id
      AND a.entity_kind = 'lead'
      AND a.entity_id = n.lead_id
      AND a.kind = 'note'
      AND a.occurred_at = n.created_at
      AND (a.metadata->>'note_id') = n.id::text
 );

-- ---- 7b) Add the lead_source_check after normalization ---------------------
ALTER TABLE sales.lead
  DROP CONSTRAINT IF EXISTS lead_source_check;
ALTER TABLE sales.lead
  ADD CONSTRAINT lead_source_check
  CHECK (source IS NULL
         OR source IN ('Agent','RWR Generated','Vendor','Direct','Social Media'));

-- ---- 8) Mirror sales.message -> sales.activity -----------------------------
INSERT INTO sales.activity
  (tenant_id, entity_kind, entity_id, kind, source, actor_id, text, occurred_at, metadata)
SELECT
  m.tenant_id,
  'lead'::sales.activity_entity_kind_t,
  m.lead_id,
  'message'::sales.activity_kind_t,
  'manual',
  NULL,
  m.body,
  m.created_at,
  jsonb_build_object('backfill','p003','message_id', m.id, 'sender', m.sender, 'attachments', m.attachments)
  FROM sales.message m
 WHERE NOT EXISTS (
   SELECT 1 FROM sales.activity a
    WHERE a.tenant_id = m.tenant_id
      AND a.entity_kind = 'lead'
      AND a.entity_id = m.lead_id
      AND a.kind = 'message'
      AND a.occurred_at = m.created_at
      AND (a.metadata->>'message_id') = m.id::text
 );

COMMIT;
