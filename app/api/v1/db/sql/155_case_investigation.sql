-- =============================================================================
-- 155_case_investigation.sql — Sprint: Investigation Typing.
-- -----------------------------------------------------------------------------
-- Promotes the generic ops.case into a typed investigation by adding the
-- typing + geospatial + customer + human-reference columns. ALL columns are
-- nullable so every pre-existing case keeps working untouched (back-compat).
--
--   investigation_type  TEXT FK -> ops.investigation_type(key). NULL = untyped
--                       legacy case.
--   aoi                 GEOGRAPHY(Polygon,4326) — area of interest polygon.
--   customer_id         UUID — the customer/account this investigation is for.
--                       Intentionally NOT FK-constrained (customers live across
--                       several tables across verticals); validated at the app.
--   case_number         TEXT — human reference like INV-2026-000123. Generated
--                       lazily by the API on first typing (PATCH investigation).
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE ops.case
  ADD COLUMN IF NOT EXISTS investigation_type TEXT NULL
    REFERENCES ops.investigation_type(key),
  ADD COLUMN IF NOT EXISTS aoi                GEOGRAPHY(Polygon,4326) NULL,
  ADD COLUMN IF NOT EXISTS customer_id        UUID NULL,
  ADD COLUMN IF NOT EXISTS case_number        TEXT NULL;

-- Human-reference uniqueness is scoped per-tenant (each tenant has its own
-- INV-<year>-<seq> series). Partial unique index ignores the NULL legacy rows.
CREATE UNIQUE INDEX IF NOT EXISTS case_tenant_case_number_uidx
  ON ops.case (tenant_id, case_number)
  WHERE case_number IS NOT NULL;

-- Hot path: list/filter cases by investigation type within a tenant.
CREATE INDEX IF NOT EXISTS case_tenant_investigation_type_idx
  ON ops.case (tenant_id, investigation_type);

-- Customer drill-down: all investigations for a customer within a tenant.
CREATE INDEX IF NOT EXISTS case_tenant_customer_idx
  ON ops.case (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

COMMENT ON COLUMN ops.case.investigation_type IS
  'FK -> ops.investigation_type(key). NULL = untyped legacy case.';
COMMENT ON COLUMN ops.case.aoi IS
  'Area-of-interest polygon (EPSG:4326). NULL when no geometry supplied.';
COMMENT ON COLUMN ops.case.case_number IS
  'Human reference INV-<year>-<seq>, generated lazily on first typing; unique per tenant.';

-- ---- Per-tenant case_number sequence helper ---------------------------------
-- A single counter table keyed by (tenant_id, year). The API calls
-- ops.next_case_number(tenant, year) inside its transaction to atomically mint
-- the next sequence value. SECURITY DEFINER is NOT used — the call runs under
-- the request's RLS-bound connection; the table is tenant-scoped + RLS-guarded.
CREATE TABLE IF NOT EXISTS ops.case_number_seq (
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  year       INT  NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);
CREATE INDEX IF NOT EXISTS case_number_seq_tenant_idx
  ON ops.case_number_seq (tenant_id, year);

ALTER TABLE ops.case_number_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.case_number_seq FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='ops' AND tablename='case_number_seq'
                AND policyname='case_number_seq_tenant_iso') THEN
    DROP POLICY case_number_seq_tenant_iso ON ops.case_number_seq;
  END IF;
  CREATE POLICY case_number_seq_tenant_iso ON ops.case_number_seq
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

-- Atomic mint. Upserts the (tenant, year) counter and returns the new value.
CREATE OR REPLACE FUNCTION ops.next_case_number(p_tenant UUID, p_year INT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v BIGINT;
BEGIN
  INSERT INTO ops.case_number_seq (tenant_id, year, last_value)
    VALUES (p_tenant, p_year, 1)
  ON CONFLICT (tenant_id, year)
    DO UPDATE SET last_value = ops.case_number_seq.last_value + 1
  RETURNING last_value INTO v;
  RETURN v;
END;
$$;

COMMIT;
