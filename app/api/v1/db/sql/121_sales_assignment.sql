-- =============================================================================
-- 121_sales_assignment.sql — Polymorphic row-visibility gate (Sprint 1B / EPIC-002).
-- -----------------------------------------------------------------------------
-- Bridges sales.* entities (lead, contact, client, opportunity, organization)
-- to user_profile rows so a sales.agent's row-level visibility can be gated on
-- "is the caller in the assigned set?" without joining N polymorphic FKs.
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sales.assignment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN
                 ('lead','contact','client','opportunity','organization')),
  entity_id    UUID NOT NULL,
  user_id      UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','collaborator','support')),
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ NULL,
  assigned_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL
);

-- Leading tenant_id index — required by audit:tenant gate.
CREATE INDEX IF NOT EXISTS assignment_tenant_entity_idx
  ON sales.assignment (tenant_id, entity_kind, entity_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS assignment_user_active_idx
  ON sales.assignment (user_id, entity_kind)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assignment_owner_unique
  ON sales.assignment (tenant_id, entity_kind, entity_id)
  WHERE released_at IS NULL AND role = 'owner';

COMMENT ON TABLE sales.assignment IS
  'Polymorphic assignment of user_profile to a sales.* entity. Drives row visibility for non-global readers.';

-- ---- RLS -------------------------------------------------------------------
ALTER TABLE sales.assignment ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'sales' AND tablename = 'assignment'
       AND policyname  = 'assignment_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY assignment_tenant_iso ON sales.assignment
        USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

COMMENT ON POLICY assignment_tenant_iso ON sales.assignment IS
  'tenant isolation via current_setting; bypass via rwr_platform role (provisioned by ops).';
