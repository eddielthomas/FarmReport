-- =============================================================================
-- 206_farm_supplychain.sql — supply-chain overlay (docs/06 D2, first wedge).
-- -----------------------------------------------------------------------------
-- The buyer is the tenant (iam.tenant) — no separate farm.buyer table; a buyer
-- monitors a portfolio of SUPPLIERS, each optionally grouped into a SOURCING
-- REGION. A farm_profile belongs to a supplier (nullable — single-farm mode
-- still works with supplier_id NULL).
--
--   farm.sourcing_region — a geographic sourcing bucket in a buyer's network.
--   farm.supplier        — an org in a buyer's network; owns farm_profiles.
--   farm.farm_profile    += supplier_id  (additive column on the 200-band table)
--
-- Additive + idempotent. RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.sourcing_region ---------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.sourcing_region (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,   -- the buyer
  name       TEXT NOT NULL,
  country    TEXT,
  admin_area TEXT,                                       -- state/province/region label
  geom       geography(MULTIPOLYGON, 4326),
  centroid   geography(POINT, 4326),
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_region_tenant_idx ON farm.sourcing_region (tenant_id, name);
CREATE INDEX IF NOT EXISTS farm_region_geom_idx   ON farm.sourcing_region USING GIST (geom);

COMMENT ON TABLE farm.sourcing_region IS
  'A geographic sourcing bucket in a buyer''s (tenant''s) supplier network.';

-- ---- farm.supplier ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.supplier (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE, -- the buyer
  sourcing_region_id UUID REFERENCES farm.sourcing_region(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  external_ref       TEXT,                               -- buyer's own supplier code
  status             TEXT NOT NULL DEFAULT 'active',     -- active|inactive|prospective
  tier               TEXT,                               -- strategic|preferred|spot|...
  contact            JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_supplier_tenant_idx ON farm.supplier (tenant_id, name);
CREATE INDEX IF NOT EXISTS farm_supplier_region_idx ON farm.supplier (tenant_id, sourcing_region_id);

COMMENT ON TABLE farm.supplier IS
  'An org in a buyer''s (tenant''s) network. Owns farm_profiles via '
  'farm_profile.supplier_id; optionally grouped by sourcing_region.';

-- ---- farm.farm_profile += supplier_id ---------------------------------------
-- Additive column (append-only: we alter here rather than editing 200).
ALTER TABLE farm.farm_profile
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES farm.supplier(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS farm_profile_supplier_idx ON farm.farm_profile (tenant_id, supplier_id);

COMMENT ON COLUMN farm.farm_profile.supplier_id IS
  'Owning supplier in the buyer network. NULL in single-farm mode.';
