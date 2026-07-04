-- =============================================================================
-- 159_sales_contract.sql — Sprint: Proposal + Contract entities.
-- -----------------------------------------------------------------------------
-- sales.contract — the closing artifact of the CRM pipeline. Minted from an
-- accepted sales.proposal (or standalone), it carries a human contract number
-- CTR-<year>-<seq> generated per-tenant via sales.next_contract_number, mirror-
-- ing the INV-<year>-<seq> case_number pattern in migration 155.
--
-- Lifecycle: draft -> active -> signed -> expired | terminated.
--   signed_at stamped on the ->signed transition.
--
-- proposal_id / opportunity_id are nullable so a contract can be created
-- standalone; customer_id is a free UUID (customers live across verticals,
-- validated at the app layer like ops.case.customer_id).
--
-- Tenant RLS: deny-by-default + FORCE ROW LEVEL SECURITY.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.contract (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  proposal_id     UUID NULL REFERENCES sales.proposal(id) ON DELETE SET NULL,
  opportunity_id  UUID NULL REFERENCES sales.opportunity(id) ON DELETE SET NULL,
  customer_id     UUID NULL,
  contract_number TEXT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','signed','expired','terminated')),
  value           NUMERIC(14,2) NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  start_date      DATE NULL,
  end_date        DATE NULL,
  signed_at       TIMESTAMPTZ NULL,
  document_ref    TEXT NULL,
  created_by      UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human-reference uniqueness is scoped per-tenant. Partial unique index skips
-- the (rare) NULL contract_number rows.
CREATE UNIQUE INDEX IF NOT EXISTS contract_tenant_number_uidx
  ON sales.contract (tenant_id, contract_number)
  WHERE contract_number IS NOT NULL;

-- Leading tenant_id index (audit:tenant gate) + drill-down hot paths.
CREATE INDEX IF NOT EXISTS contract_tenant_status_idx
  ON sales.contract (tenant_id, status);
CREATE INDEX IF NOT EXISTS contract_tenant_proposal_idx
  ON sales.contract (tenant_id, proposal_id);
CREATE INDEX IF NOT EXISTS contract_tenant_opportunity_idx
  ON sales.contract (tenant_id, opportunity_id);

COMMENT ON TABLE sales.contract IS
  'CRM contract. Lifecycle draft->active->signed->expired|terminated. Minted from an accepted proposal or standalone.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE sales.contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.contract FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='sales' AND tablename='contract'
                AND policyname='contract_tenant_iso') THEN
    DROP POLICY contract_tenant_iso ON sales.contract;
  END IF;
  CREATE POLICY contract_tenant_iso ON sales.contract
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

-- ---- Per-tenant contract_number sequence helper -----------------------------
-- Counter table keyed by (tenant_id, year). The API calls
-- sales.next_contract_number(tenant, year) inside its RLS-bound transaction to
-- atomically mint the next CTR-<year>-<seq> value. Mirrors ops.case_number_seq
-- from migration 155.
CREATE TABLE IF NOT EXISTS sales.contract_number_seq (
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  year       INT  NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);
CREATE INDEX IF NOT EXISTS contract_number_seq_tenant_idx
  ON sales.contract_number_seq (tenant_id, year);

ALTER TABLE sales.contract_number_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.contract_number_seq FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='sales' AND tablename='contract_number_seq'
                AND policyname='contract_number_seq_tenant_iso') THEN
    DROP POLICY contract_number_seq_tenant_iso ON sales.contract_number_seq;
  END IF;
  CREATE POLICY contract_number_seq_tenant_iso ON sales.contract_number_seq
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

CREATE OR REPLACE FUNCTION sales.next_contract_number(p_tenant UUID, p_year INT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v BIGINT;
BEGIN
  INSERT INTO sales.contract_number_seq (tenant_id, year, last_value)
    VALUES (p_tenant, p_year, 1)
  ON CONFLICT (tenant_id, year)
    DO UPDATE SET last_value = sales.contract_number_seq.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END;
$$;

COMMIT;
