-- =============================================================================
-- 149_access_code_stardate.sql — replace the pilot demo access code.
-- -----------------------------------------------------------------------------
-- The S10B seed inserted three pilot codes (RWR-DEMO-2026, RWR-DEMOVILLE-2026,
-- RWR-ACME-2026). Per operator request, the new platform-global demo code is
-- `StarDateMay26`. This migration:
--   1. Inserts the new code as platform-global (tenant_id NULL).
--   2. Revokes the three legacy demo codes by setting revoked_at = now() on
--      their hashes (idempotent: only revokes if not already revoked).
--
-- Hash was computed with:
--   node -e "console.log(require('crypto').createHash('sha256').update('StarDateMay26').digest('hex'))"
-- = f48780b7a643917dde9b25dc7c1b1e6187f57f8210d2f198e7ae2efa74247cee
--
-- Idempotent via ON CONFLICT (code_hash) DO NOTHING + WHERE revoked_at IS NULL.
-- =============================================================================

BEGIN;

-- Insert the new platform-global code: StarDateMay26
INSERT INTO iam.access_code (tenant_id, code_hash, name)
VALUES (
  NULL,
  'f48780b7a643917dde9b25dc7c1b1e6187f57f8210d2f198e7ae2efa74247cee',
  'Pilot — Platform Global (StarDateMay26)'
)
ON CONFLICT (code_hash) DO NOTHING;

-- Revoke the three legacy pilot codes (idempotent — only revoke if active).
UPDATE iam.access_code
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND code_hash IN (
     '4f30a943a41f8b620e394c7f0349bda3afa09da42f59e90f120190ca85c2b62e',  -- RWR-DEMO-2026
     '71a30c7288c61fe153b48faed273cf9a5ccf6a5320caf3142e4edc6ba44c7102',  -- RWR-DEMOVILLE-2026
     '3bc2208e99c54ff497147ecdcae5291d023a50ee649351be91964d2d35be2f56'   -- RWR-ACME-2026
   );

COMMIT;
