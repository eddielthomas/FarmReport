-- =============================================================================
-- 136_vendor_pool.sql — S4B / EPIC-009 P-009 Phase 2: vendor_pool schema.
-- -----------------------------------------------------------------------------
-- Tables:
--   vendor_pool.contract            — per-vendor contract envelope
--   vendor_pool.scope               — per-contract per-resource permission grant
--   vendor_pool.geographic_scope    — optional contract-wide region tag
--   vendor_pool.contract_event      — append-only event log (UPDATE/DELETE blocked)
--
-- Design choices encoded here:
--   * Scope DELETE is allowed BUT a BEFORE-DELETE trigger writes a
--     `scope_revoked` event row first so revocation is always recorded.
--     This makes the deletion idempotent and self-auditing without forcing
--     callers through a separate revoke endpoint when they want a hard delete.
--   * `geographic_scope` is contract-scoped (no tenant_id column) — tenancy
--     is enforced transitively via contract_id FK. Listed as an exception in
--     audit-tenant-id.mjs.
--   * `contract_event` rejects UPDATE/DELETE for every role (no service_role
--     escape hatch) — keeping the log truly append-only.
--
-- RLS on contract / scope / contract_event. geographic_scope inherits tenancy
-- through contract.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS vendor_pool;

-- ---- vendor_pool.contract ---------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_pool.contract (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  vendor_user_id  UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE RESTRICT,
  contract_kind   TEXT NOT NULL
                    CHECK (contract_kind IN (
                      'sales_partner','data_provider','channel_partner',
                      'implementation_partner','repair_partner'
                    )),
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','expired','revoked')),
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ,
  signed_at       TIMESTAMPTZ,
  terms_doc_url   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_tenant_status_idx
  ON vendor_pool.contract (tenant_id, status);
CREATE INDEX IF NOT EXISTS contract_tenant_vendor_idx
  ON vendor_pool.contract (tenant_id, vendor_user_id);
COMMENT ON TABLE vendor_pool.contract IS
  'Per-vendor contract envelope. Owns scope + geographic_scope + contract_event.';

-- ---- vendor_pool.scope ------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_pool.scope (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  contract_id     UUID NOT NULL REFERENCES vendor_pool.contract(id) ON DELETE CASCADE,
  resource_type   TEXT NOT NULL,
  resource_id     UUID NULL,   -- NULL = tenant-wide for that resource_type
  permission_key  TEXT NOT NULL REFERENCES iam.permission(key) ON DELETE RESTRICT,
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scope_tenant_contract_idx
  ON vendor_pool.scope (tenant_id, contract_id);
CREATE INDEX IF NOT EXISTS scope_lookup_idx
  ON vendor_pool.scope (contract_id, resource_type, resource_id);
COMMENT ON TABLE vendor_pool.scope IS
  'Per-contract per-resource permission grants. DELETE allowed; a BEFORE trigger writes a scope_revoked event row first.';

-- ---- vendor_pool.geographic_scope ------------------------------------------
-- Multiple rows per contract permitted (one per region). contract_id is the
-- PK partner for region uniqueness; tenancy is inherited via contract_id FK.
CREATE TABLE IF NOT EXISTS vendor_pool.geographic_scope (
  contract_id  UUID NOT NULL REFERENCES vendor_pool.contract(id) ON DELETE CASCADE,
  region       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, region)
);
CREATE INDEX IF NOT EXISTS geographic_scope_contract_idx
  ON vendor_pool.geographic_scope (contract_id);
COMMENT ON TABLE vendor_pool.geographic_scope IS
  'Optional region label(s) on a contract. Tenancy via contract_id (no tenant_id column).';

-- ---- vendor_pool.contract_event (append-only) ------------------------------
CREATE TABLE IF NOT EXISTS vendor_pool.contract_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  contract_id  UUID NOT NULL REFERENCES vendor_pool.contract(id) ON DELETE CASCADE,
  event_kind   TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id     UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_event_tenant_contract_idx
  ON vendor_pool.contract_event (tenant_id, contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contract_event_kind_idx
  ON vendor_pool.contract_event (event_kind);

-- Append-only enforcement: UPDATE/DELETE always raise.
CREATE OR REPLACE FUNCTION vendor_pool.fn_contract_event_immutable()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'contract_event is append-only (op=%)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contract_event_immutable ON vendor_pool.contract_event;
CREATE TRIGGER trg_contract_event_immutable
  BEFORE UPDATE OR DELETE ON vendor_pool.contract_event
  FOR EACH ROW EXECUTE FUNCTION vendor_pool.fn_contract_event_immutable();

COMMENT ON TABLE vendor_pool.contract_event IS
  'Append-only event log. UPDATE / DELETE rejected by trigger.';

-- ---- scope DELETE → audit shim --------------------------------------------
-- Before a scope row is deleted, write a contract_event(kind=scope_revoked)
-- snapshot so revocation is preserved in the append-only log. This lets the
-- routine `DELETE FROM vendor_pool.scope WHERE …` flow stay simple while still
-- emitting the audit envelope.
CREATE OR REPLACE FUNCTION vendor_pool.fn_scope_delete_audit()
  RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO vendor_pool.contract_event
    (tenant_id, contract_id, event_kind, payload, actor_id)
  VALUES
    (OLD.tenant_id, OLD.contract_id, 'scope_revoked',
     jsonb_build_object(
       'scope_id',       OLD.id,
       'resource_type',  OLD.resource_type,
       'resource_id',    OLD.resource_id,
       'permission_key', OLD.permission_key
     ),
     NULLIF(current_setting('app.user_id', true), '')::uuid);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scope_delete_audit ON vendor_pool.scope;
CREATE TRIGGER trg_scope_delete_audit
  BEFORE DELETE ON vendor_pool.scope
  FOR EACH ROW EXECUTE FUNCTION vendor_pool.fn_scope_delete_audit();

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE vendor_pool.contract        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_pool.scope           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_pool.contract_event  ENABLE ROW LEVEL SECURITY;
-- geographic_scope inherits tenancy via contract_id; no direct RLS column.

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['contract','scope','contract_event'])
  LOOP
    pol := t || '_tenant_iso';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'vendor_pool' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON vendor_pool.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol, t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
