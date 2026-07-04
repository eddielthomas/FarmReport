-- =============================================================================
-- 148_access_code_seed.sql — Sprint 10B: seed the default pilot access codes.
-- -----------------------------------------------------------------------------
-- Inserts the documented demo codes in three flavours:
--   1. tenant-scoped for demoville-a (RWR-DEMOVILLE-2026)
--   2. tenant-scoped for acme-water  (RWR-ACME-2026)
--   3. platform-global               (RWR-DEMO-2026)
--
-- All three plaintexts are documented in mvp/.mempalace/rwr/crm-impl-s10b.md.
-- UNIQUE(code_hash) means we cannot share a hash across rows; each tenant
-- gets its own plaintext, and the platform-global value is distinct.
--
-- Hashes were computed with:
--   node -e "console.log(require('crypto').createHash('sha256').update('RWR-DEMO-2026').digest('hex'))"
-- Re-derive if you change the plaintext.
--
-- Idempotent via ON CONFLICT (code_hash) DO NOTHING.
-- =============================================================================

BEGIN;

-- Platform-global: RWR-DEMO-2026
-- sha256('RWR-DEMO-2026') = 4f30a943a41f8b620e394c7f0349bda3afa09da42f59e90f120190ca85c2b62e
INSERT INTO iam.access_code (tenant_id, code_hash, name)
VALUES (
  NULL,
  '4f30a943a41f8b620e394c7f0349bda3afa09da42f59e90f120190ca85c2b62e',
  'Pilot — Platform Global Demo Code'
)
ON CONFLICT (code_hash) DO NOTHING;

-- demoville-a: RWR-DEMOVILLE-2026
-- sha256('RWR-DEMOVILLE-2026') = 71a30c7288c61fe153b48faed273cf9a5ccf6a5320caf3142e4edc6ba44c7102
INSERT INTO iam.access_code (tenant_id, code_hash, name)
SELECT t.id,
       '71a30c7288c61fe153b48faed273cf9a5ccf6a5320caf3142e4edc6ba44c7102',
       'Pilot — Demoville Water Authority'
  FROM iam.tenant t
 WHERE t.slug = 'demoville-a'
ON CONFLICT (code_hash) DO NOTHING;

-- acme-water: RWR-ACME-2026
-- sha256('RWR-ACME-2026') = 3bc2208e99c54ff497147ecdcae5291d023a50ee649351be91964d2d35be2f56
INSERT INTO iam.access_code (tenant_id, code_hash, name)
SELECT t.id,
       '3bc2208e99c54ff497147ecdcae5291d023a50ee649351be91964d2d35be2f56',
       'Pilot — Acme Water Services'
  FROM iam.tenant t
 WHERE t.slug = 'acme-water'
ON CONFLICT (code_hash) DO NOTHING;

COMMIT;
