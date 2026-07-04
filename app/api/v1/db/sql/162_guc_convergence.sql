-- =============================================================================
-- 162_guc_convergence.sql — OperationsOS Phase A / Sprint A4.
-- -----------------------------------------------------------------------------
-- Converge the Postgres tenant GUC from the legacy `app.tenant_id` to the
-- canonical `rwr.tenant_id` for PURE tenant-isolation policies only.
--
-- SAFE strategy (see ADR-0021):
--   * pool.mjs now DUAL-SETS both app.tenant_id (deprecated alias) AND
--     rwr.tenant_id to the same value on every withTenantConn() transaction, so
--     every policy keeps isolating correctly regardless of which GUC it reads.
--   * This migration rewrites ONLY policies whose qual references app.tenant_id
--     and does NOT reference app.clearance. The clearance-combined policies
--     (Bell-LaPadula lattice, 139_classification + descendants) are LEFT on
--     app.tenant_id intentionally — converging them is a future big-bang and the
--     dual-set covers them in the meantime.
--   * Rewrite is a literal substring swap inside the EXISTING USING / WITH CHECK
--     expression (preserving any NULL/''/EXISTS predicate structure), applied
--     via ALTER POLICY. We never DROP/CREATE, so policy ordering and grants are
--     untouched.
--
-- Idempotent: a second run finds no policy still referencing app.tenant_id in a
-- non-clearance qual, so it rewrites nothing. Strictly a metadata change.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r            RECORD;
  new_using    TEXT;
  new_check    TEXT;
  stmt         TEXT;
  n_rewritten  INT := 0;
  n_skipped    INT := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE (qual LIKE '%app.tenant_id%' OR with_check LIKE '%app.tenant_id%')
     ORDER BY schemaname, tablename, policyname
  LOOP
    -- Skip clearance-combined policies — leave them on app.tenant_id.
    IF (COALESCE(r.qual, '') LIKE '%app.clearance%')
       OR (COALESCE(r.with_check, '') LIKE '%app.clearance%') THEN
      n_skipped := n_skipped + 1;
      RAISE NOTICE '[162] SKIP (clearance-combined) %.% :: %',
        r.schemaname, r.tablename, r.policyname;
      CONTINUE;
    END IF;

    -- Pure tenant-isolation policy: swap the GUC name in both expressions,
    -- preserving the rest of the predicate (NULL/''/EXISTS structure, casts).
    new_using := replace(r.qual,       'app.tenant_id', 'rwr.tenant_id');
    new_check := replace(COALESCE(r.with_check, r.qual),
                                       'app.tenant_id', 'rwr.tenant_id');

    -- ALTER POLICY ... USING (...) WITH CHECK (...). Both clauses always present
    -- for our tenant-iso policies (qual and with_check are mirror images).
    stmt := format(
      'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
      r.policyname, r.schemaname, r.tablename, new_using, new_check
    );
    EXECUTE stmt;

    n_rewritten := n_rewritten + 1;
    RAISE NOTICE '[162] REWRITE app.tenant_id -> rwr.tenant_id  %.% :: %',
      r.schemaname, r.tablename, r.policyname;
  END LOOP;

  RAISE NOTICE '[162] GUC convergence complete: % rewritten, % skipped (clearance-combined remain on app.tenant_id).',
    n_rewritten, n_skipped;
END $$;

COMMIT;
