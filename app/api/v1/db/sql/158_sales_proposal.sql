-- =============================================================================
-- 158_sales_proposal.sql — Sprint: Proposal + Contract entities.
-- -----------------------------------------------------------------------------
-- sales.proposal — a first-class quote/proposal in the CRM pipeline, sitting
-- between an opportunity reaching the `proposal` stage and a signed contract.
-- Either opportunity_id OR lead_id (or both, or neither) may anchor it; both
-- are nullable so a proposal can be drafted standalone and linked later.
--
-- Lifecycle: draft -> sent -> accepted | rejected | expired.
--   sent_at    stamped on draft->sent
--   decided_at stamped on the terminal transition (accepted/rejected/expired)
--
-- Tenant RLS: deny-by-default + FORCE ROW LEVEL SECURITY so every access path
-- must go through withTenantConn() (which SET LOCAL app.tenant_id).
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE IF NOT EXISTS sales.proposal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  opportunity_id  UUID NULL REFERENCES sales.opportunity(id) ON DELETE SET NULL,
  lead_id         UUID NULL REFERENCES sales.lead(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  amount          NUMERIC(14,2) NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  valid_until     DATE NULL,
  line_items      JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes           TEXT NULL,
  created_by      UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ NULL,
  decided_at      TIMESTAMPTZ NULL
);

-- Leading tenant_id index (audit:tenant gate) + the (tenant, opportunity) and
-- (tenant, status) hot paths.
CREATE INDEX IF NOT EXISTS proposal_tenant_opportunity_idx
  ON sales.proposal (tenant_id, opportunity_id);
CREATE INDEX IF NOT EXISTS proposal_tenant_status_idx
  ON sales.proposal (tenant_id, status);

COMMENT ON TABLE sales.proposal IS
  'CRM proposal/quote. Lifecycle draft->sent->accepted|rejected|expired. Anchored to an opportunity and/or lead.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE sales.proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.proposal FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='sales' AND tablename='proposal'
                AND policyname='proposal_tenant_iso') THEN
    DROP POLICY proposal_tenant_iso ON sales.proposal;
  END IF;
  CREATE POLICY proposal_tenant_iso ON sales.proposal
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

COMMIT;
