-- =============================================================================
-- 207_farm_rollup.sql — supply-chain rollup store + views (docs/06 D2 / P3.5).
-- -----------------------------------------------------------------------------
-- Mirrors RWR's analytics.rollup / org rollup pattern (163–165, 126): a compact
-- aggregate store the rollup worker writes to, plus supplier → region → buyer
-- rollup VIEWS the portfolio dashboard reads.
--
-- Store tables (tenant-scoped = buyer-scoped; RLS in 210):
--   farm.risk_score       — one score per (subject, day). subject_type in
--                           farm|supplier|region|buyer; subject_id is the entity
--                           id (for buyer scope, subject_id = the tenant id).
--   farm.yield_at_risk    — yield/revenue at risk per (subject, day, crop).
--   farm.disruption_alert — buyer-level "X% of Region Y sourcing at yield risk".
--
-- Rollup VIEWS (NOT tables — invoker-rights, so base-table RLS still isolates):
--   farm.v_farm_latest_risk → farm.v_supplier_rollup → farm.v_region_rollup
--   → farm.v_buyer_rollup.
--
-- Additive + idempotent. No fabricated rows — the store is empty until the
-- rollup worker computes from real observations/signals.
-- =============================================================================

-- ---- farm.risk_score --------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.risk_score (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('farm','supplier','region','buyer')),
  subject_id     UUID NOT NULL,                          -- buyer scope: subject_id = tenant_id
  bucket_date    DATE NOT NULL,
  score          NUMERIC NOT NULL DEFAULT 0,             -- 0..100
  band           TEXT,                                   -- low|medium|high|critical
  factors        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- contributing signals + weights
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, subject_type, subject_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS farm_risk_score_subject_idx
  ON farm.risk_score (tenant_id, subject_type, subject_id, bucket_date DESC);

-- ---- farm.yield_at_risk -----------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.yield_at_risk (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('farm','supplier','region','buyer')),
  subject_id          UUID NOT NULL,
  bucket_date         DATE NOT NULL,
  crop                TEXT NOT NULL DEFAULT 'all',
  yield_at_risk_pct   NUMERIC NOT NULL DEFAULT 0,
  revenue_at_risk_usd NUMERIC NOT NULL DEFAULT 0,
  area_ha_at_risk     NUMERIC NOT NULL DEFAULT 0,
  basis               JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, subject_type, subject_id, bucket_date, crop)
);
CREATE INDEX IF NOT EXISTS farm_yield_at_risk_subject_idx
  ON farm.yield_at_risk (tenant_id, subject_type, subject_id, bucket_date DESC);

-- ---- farm.disruption_alert --------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.disruption_alert (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE, -- the buyer
  sourcing_region_id  UUID REFERENCES farm.sourcing_region(id) ON DELETE SET NULL,
  supplier_id         UUID REFERENCES farm.supplier(id) ON DELETE SET NULL,
  severity            TEXT NOT NULL,                     -- critical|high|medium|low
  category            TEXT NOT NULL,                     -- yield-risk|weather|disruption|...
  title               TEXT NOT NULL,
  summary             TEXT,
  share_at_risk_pct   NUMERIC,                           -- % of region/supplier sourcing at risk
  revenue_at_risk_usd NUMERIC,
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'open',       -- open|ack|resolved|suppressed
  dedup_key           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS farm_disruption_alert_tenant_idx
  ON farm.disruption_alert (tenant_id, created_at DESC);

-- ---- rollup views (supplier → region → buyer) -------------------------------
-- Latest farm-level risk (one row per farm).
CREATE OR REPLACE VIEW farm.v_farm_latest_risk AS
  SELECT DISTINCT ON (rs.tenant_id, rs.subject_id)
         rs.tenant_id,
         rs.subject_id AS farm_id,
         rs.score,
         rs.band,
         rs.bucket_date
    FROM farm.risk_score rs
   WHERE rs.subject_type = 'farm'
   ORDER BY rs.tenant_id, rs.subject_id, rs.bucket_date DESC;

-- Supplier rollup: aggregate its farms' latest risk + revenue-at-risk. A WITH
-- clause + scalar subquery keeps yield_at_risk from fanning out farm_count.
CREATE OR REPLACE VIEW farm.v_supplier_rollup AS
  WITH farm_risk AS (
    SELECT fp.tenant_id,
           fp.id AS farm_id,
           fp.supplier_id,
           flr.score AS risk_score,
           (SELECT COALESCE(sum(y.revenue_at_risk_usd), 0)
              FROM farm.yield_at_risk y
             WHERE y.subject_type = 'farm' AND y.subject_id = fp.id) AS revenue_at_risk_usd
      FROM farm.farm_profile fp
      LEFT JOIN farm.v_farm_latest_risk flr
        ON flr.farm_id = fp.id AND flr.tenant_id = fp.tenant_id
     WHERE fp.supplier_id IS NOT NULL
  )
  SELECT s.tenant_id,
         s.id AS supplier_id,
         s.name AS supplier_name,
         s.sourcing_region_id,
         count(fr.farm_id) AS farm_count,
         avg(fr.risk_score) AS avg_risk_score,
         max(fr.risk_score) AS max_risk_score,
         COALESCE(sum(fr.revenue_at_risk_usd), 0) AS revenue_at_risk_usd
    FROM farm.supplier s
    LEFT JOIN farm_risk fr ON fr.supplier_id = s.id
   GROUP BY s.tenant_id, s.id, s.name, s.sourcing_region_id;

-- Region rollup: aggregate its suppliers.
CREATE OR REPLACE VIEW farm.v_region_rollup AS
  SELECT r.tenant_id,
         r.id AS sourcing_region_id,
         r.name AS region_name,
         count(sr.supplier_id) AS supplier_count,
         COALESCE(sum(sr.farm_count), 0) AS farm_count,
         avg(sr.avg_risk_score) AS avg_risk_score,
         max(sr.max_risk_score) AS max_risk_score,
         COALESCE(sum(sr.revenue_at_risk_usd), 0) AS revenue_at_risk_usd
    FROM farm.sourcing_region r
    LEFT JOIN farm.v_supplier_rollup sr ON sr.sourcing_region_id = r.id
   GROUP BY r.tenant_id, r.id, r.name;

-- Buyer rollup: one row per tenant (buyer), aggregating all its suppliers. The
-- portfolio dashboard filters this by the caller's tenant_id.
CREATE OR REPLACE VIEW farm.v_buyer_rollup AS
  SELECT t.id AS tenant_id,
         t.slug AS buyer_slug,
         t.display_name AS buyer_name,
         count(sr.supplier_id) AS supplier_count,
         count(DISTINCT sr.sourcing_region_id) AS region_count,
         COALESCE(sum(sr.farm_count), 0) AS farm_count,
         avg(sr.avg_risk_score) AS avg_risk_score,
         max(sr.max_risk_score) AS max_risk_score,
         COALESCE(sum(sr.revenue_at_risk_usd), 0) AS revenue_at_risk_usd
    FROM iam.tenant t
    LEFT JOIN farm.v_supplier_rollup sr ON sr.tenant_id = t.id
   GROUP BY t.id, t.slug, t.display_name;

COMMENT ON VIEW farm.v_buyer_rollup IS
  'Buyer (tenant) portfolio rollup over supplier → region. Base tables are RLS-'
  'scoped; the dashboard still filters by the caller''s tenant_id.';
