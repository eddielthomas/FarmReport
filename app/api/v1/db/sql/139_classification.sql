-- =============================================================================
-- 139_classification.sql — EPIC-010 P-010 Phase 3 (Sprint 5B).
-- -----------------------------------------------------------------------------
-- Adds Bell-LaPadula style classification to user clearance + per-row
-- classification on every tenant-scoped business table, plus the lattice
-- helper iam.fn_clearance_meets(subject, resource).
--
-- Backward compatibility:
--   - clearance / classification default to 'internal' so existing rows + users
--     are mutually visible under the lattice (internal >= internal == true).
--   - The lattice helper returns TRUE when subject is NULL (i.e. the
--     connection did not set `app.clearance`). This preserves visibility for
--     pre-S5B callers that use the plain `q()` helper instead of
--     `withTenantConn`. Audit + admin paths that intentionally elevate or
--     downgrade must SET LOCAL app.clearance explicitly.
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

BEGIN;

-- ---- 1) iam.user_profile.clearance -----------------------------------------
ALTER TABLE iam.user_profile
  ADD COLUMN IF NOT EXISTS clearance TEXT NOT NULL DEFAULT 'internal';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_profile_clearance_chk'
       AND conrelid = 'iam.user_profile'::regclass
  ) THEN
    ALTER TABLE iam.user_profile
      ADD CONSTRAINT user_profile_clearance_chk
        CHECK (clearance IN ('public','internal','confidential','secret'));
  END IF;
END $$;

COMMENT ON COLUMN iam.user_profile.clearance IS
  'Bell-LaPadula subject clearance. Combined with row.classification by '
  'iam.fn_clearance_meets() in every RLS policy.';

-- ---- 2) per-row classification on business tables --------------------------
-- 15 tables across sales / ops / gis. Idempotent: ADD COLUMN IF NOT EXISTS.
DO $$
DECLARE
  target  RECORD;
  cls_chk_name TEXT;
BEGIN
  FOR target IN
    SELECT *
      FROM (VALUES
        ('sales','lead'),
        ('sales','opportunity'),
        ('sales','contact'),
        ('sales','organization'),
        ('sales','activity'),
        ('sales','revenue_record'),
        ('sales','vendor'),
        ('sales','meeting'),
        ('sales','note'),
        ('sales','message'),
        ('sales','file'),
        ('ops','case'),
        ('ops','case_activity'),
        ('ops','case_attachment'),
        ('gis','layer')
      ) AS t(schema_name, table_name)
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS classification '
      'TEXT NOT NULL DEFAULT %L',
      target.schema_name, target.table_name, 'internal'
    );
    cls_chk_name := target.table_name || '_classification_chk';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = cls_chk_name
         AND conrelid = format('%I.%I', target.schema_name, target.table_name)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I '
        'CHECK (classification IN (''public'',''internal'',''confidential'',''secret''))',
        target.schema_name, target.table_name, cls_chk_name
      );
    END IF;
    -- Partial index — only non-default rows incur the index write cost.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (tenant_id, classification) '
      'WHERE classification <> ''internal''',
      target.table_name || '_classification_idx',
      target.schema_name, target.table_name
    );
  END LOOP;
END $$;

-- ---- 3) iam.fn_clearance_rank + iam.fn_clearance_meets ---------------------
-- The lattice: public < internal < confidential < secret.
-- IMMUTABLE so the planner can inline it inside RLS policies (essential for
-- predicate pushdown / index usage).
CREATE OR REPLACE FUNCTION iam.fn_clearance_rank(p TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p
           WHEN 'public'       THEN 0
           WHEN 'internal'     THEN 1
           WHEN 'confidential' THEN 2
           WHEN 'secret'       THEN 3
           ELSE -1
         END
$$;

-- fn_clearance_meets returns TRUE iff subject_clearance >= resource_classification.
-- Special case: subject IS NULL ⇒ TRUE so unbound connections (no
-- `app.clearance` set) keep their pre-S5B visibility. This is documented in
-- the file header and is intentional for backward compatibility.
CREATE OR REPLACE FUNCTION iam.fn_clearance_meets(subject TEXT, resource TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    CASE
      WHEN subject IS NULL THEN TRUE
      WHEN resource IS NULL THEN TRUE
      ELSE iam.fn_clearance_rank(subject) >= iam.fn_clearance_rank(resource)
    END
$$;

COMMENT ON FUNCTION iam.fn_clearance_meets(TEXT, TEXT) IS
  'Bell-LaPadula lattice: returns true iff subject >= resource. NULL subject '
  'returns true (back-compat with unbound connections).';

-- ---- 4) extend existing RLS policies with clearance check ------------------
-- Drops + recreates every tenant_iso policy currently in place on the 15
-- business tables. Same name; broader USING / WITH CHECK.
DO $$
DECLARE
  pol   RECORD;
  newq  TEXT;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE (schemaname = 'sales' AND tablename IN
              ('organization','contact','contact_lead','activity',
               'revenue_record','vendor','assignment'))
        OR (schemaname = 'ops'   AND tablename IN
              ('case','case_activity','case_attachment'))
        OR (schemaname = 'gis'   AND tablename = 'layer')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    -- Some tables don't carry classification (e.g. sales.contact_lead, sales.assignment).
    -- Detect column presence dynamically and emit the appropriate predicate.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = pol.schemaname
         AND table_name   = pol.tablename
         AND column_name  = 'classification'
    ) THEN
      newq := format(
        'CREATE POLICY %I ON %I.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
        '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
        '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
        pol.policyname, pol.schemaname, pol.tablename);
    ELSE
      newq := format(
        'CREATE POLICY %I ON %I.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol.policyname, pol.schemaname, pol.tablename);
    END IF;
    EXECUTE newq;
  END LOOP;
END $$;

-- ---- 5) RLS for legacy business tables (sales.lead, opportunity, note, ...) ---
-- The legacy sales.* tables created in 002_sales.sql + ops.* in 003_ops.sql +
-- gis.layer in 102_gis.sql never had RLS enabled. Phase 3 finally enables it
-- with the combined tenant + clearance predicate. Because `current_setting(
-- 'app.tenant_id', true)::uuid` returns NULL when unbound, AND the policy
-- USING expression evaluates `tenant_id = NULL` to NULL (i.e. exclude row),
-- pre-S5B handlers that use `q()` instead of `withTenantConn(req, …)` would
-- start returning zero rows. To preserve back-compat we ALSO test for the
-- unbound case and pass through when no tenant binding is present.
-- Conceptually: the policy enforces "tenant matches XOR tenant unbound" so
-- the legacy code path still works. RLS still blocks cross-tenant when
-- tenant IS bound (which is the common case under `withTenantConn`).
DO $$
DECLARE
  t RECORD;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT *
      FROM (VALUES
        ('sales','lead'),
        ('sales','opportunity'),
        ('sales','note'),
        ('sales','meeting'),
        ('sales','message'),
        ('sales','file'),
        ('ops','case'),
        ('ops','case_activity'),
        ('ops','case_attachment'),
        ('gis','layer')
      ) AS x(schema_name, table_name)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
                   t.schema_name, t.table_name);
    pol := t.table_name || '_tenant_iso';
    -- Drop any pre-existing policy with our canonical name so the re-create
    -- below is the source of truth.
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = t.schema_name
         AND tablename = t.table_name
         AND policyname = pol
    ) THEN
      EXECUTE format('DROP POLICY %I ON %I.%I', pol, t.schema_name, t.table_name);
    END IF;
    -- Permissive policy: tenant matches OR tenant unbound (back-compat) AND
    -- clearance lattice (subject NULL => pass).
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I '
      'USING ('
      '  (current_setting(''app.tenant_id'', true) IS NULL '
      '    OR current_setting(''app.tenant_id'', true) = '''' '
      '    OR tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      '  AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification) '
      ') '
      'WITH CHECK ('
      '  (current_setting(''app.tenant_id'', true) IS NULL '
      '    OR current_setting(''app.tenant_id'', true) = '''' '
      '    OR tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      '  AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification) '
      ')',
      pol, t.schema_name, t.table_name);
  END LOOP;
END $$;

COMMIT;
