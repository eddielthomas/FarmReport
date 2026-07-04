-- =============================================================================
-- 137_permission_templates.sql — S4B / EPIC-009 P-009 Phase 3:
--                                 iam.permission_template + 5 system templates.
-- -----------------------------------------------------------------------------
-- A permission_template captures the canonical permission bundle for one of the
-- five vendor archetypes. POST /iam/vendors/:user_id/apply-template uses these
-- rows to mint iam.user_role grants + vendor_pool.scope rows on the vendor's
-- active contract.
--
-- contract_kind CHECK matches vendor_pool.contract.contract_kind exactly so the
-- application can refuse to apply a template against a contract of a different
-- archetype.
--
-- Idempotent. Seed uses ON CONFLICT DO NOTHING so re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS iam.permission_template (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  contract_kind   TEXT NOT NULL
                    CHECK (contract_kind IN (
                      'sales_partner','data_provider','channel_partner',
                      'implementation_partner','repair_partner'
                    )),
  permissions     JSONB NOT NULL,                     -- array of permission keys
  default_scope   JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. { sources:['Vendor'] }
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_template_kind_idx
  ON iam.permission_template (contract_kind);

COMMENT ON TABLE iam.permission_template IS
  'Canonical permission bundle per vendor archetype. Applied via POST /iam/vendors/:user_id/apply-template.';

-- ---- Seed 5 system templates -----------------------------------------------
INSERT INTO iam.permission_template (key, name, description, contract_kind, permissions, default_scope) VALUES
  ('sales_partner',
   'Sales Partner',
   'External sales partner. Reads leads + contacts + opportunities in own contract scope.',
   'sales_partner',
   '["crm.lead.read","crm.contact.read","crm.opportunity.read"]'::jsonb,
   '{}'::jsonb),

  ('data_provider',
   'Data Provider',
   'Writes leads tagged with source = Vendor only. No read on other tenant data.',
   'data_provider',
   '["crm.lead.write"]'::jsonb,
   '{"sources":["Vendor"]}'::jsonb),

  ('channel_partner',
   'Channel Partner',
   'Reads leads assigned to channel + reads opportunities in scope.',
   'channel_partner',
   '["crm.lead.read","crm.opportunity.read"]'::jsonb,
   '{"assignment_only":true}'::jsonb),

  ('implementation_partner',
   'Implementation Partner',
   'Reads + manages cases scoped to the assignments granted by the contract.',
   'implementation_partner',
   '["cases.read","cases.manage"]'::jsonb,
   '{"assignment_only":true}'::jsonb),

  ('repair_partner',
   'Repair Partner',
   'Read-only on cases assigned to the repair partner.',
   'repair_partner',
   '["cases.read"]'::jsonb,
   '{"assignment_only":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
