-- =============================================================================
-- 160_sales_proposal_contract_perms.sql — Sprint: Proposal + Contract entities.
-- -----------------------------------------------------------------------------
-- Proposal + Contract reuse the EXISTING CRM opportunity permission pair so no
-- new permission keys, role bundles, or policy.mjs LEGACY edits are required:
--
--   crm.opportunity.read   — list/read proposals + contracts
--   crm.opportunity.write  — create/update/transition proposals + contracts
--
-- Both keys already exist (migrations 120/137) and are already members of the
-- `sales:manage` + `platform:admin` LEGACY bundles in policy.mjs, so demo sales
-- users (sales@demoville-a.demo) authenticate straight through.
--
-- This migration is a belt-and-suspenders re-grant: it ensures the opportunity
-- read/write pair is granted to sales.manager + platform.admin in iam.role_*
-- so JWT callers resolving via canonical iam.role rows (not the legacy bundle)
-- can also reach the new endpoints. All inserts ON CONFLICT DO NOTHING.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

-- Ensure the permission catalog rows exist (no-op if already seeded upstream).
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('crm.opportunity.read',  'List/read opportunities, proposals and contracts',          'tenant'),
  ('crm.opportunity.write', 'Create/update opportunities, proposals and contracts',      'tenant')
ON CONFLICT (key) DO NOTHING;

-- Grant the opportunity read/write pair to the sales manager/agent roles.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['crm.opportunity.read','crm.opportunity.write']) k
   WHERE r.tenant_id IS NULL
     AND r.key IN ('sales.manager','sales.agent')
ON CONFLICT DO NOTHING;

-- Re-grant platform.admin everything (incl. the opportunity pair).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
     AND p.key IN ('crm.opportunity.read','crm.opportunity.write')
ON CONFLICT DO NOTHING;

-- tenant.admin gets the non-platform opportunity pair too.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['crm.opportunity.read','crm.opportunity.write']) k
   WHERE r.tenant_id IS NULL AND r.key = 'tenant.admin'
ON CONFLICT DO NOTHING;

COMMIT;
