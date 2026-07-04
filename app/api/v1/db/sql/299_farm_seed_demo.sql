-- =============================================================================
-- 299_farm_seed_demo.sql — ONE demo buyer + ONE supplier + ONE region + ONE farm.
-- -----------------------------------------------------------------------------
-- Seeds the minimal supply-chain-wedge demo substrate over a REAL, Sentinel-2-
-- covered AOI (central Iowa corn belt: W -93.75, S 41.95, E -93.55, N 42.10):
--   iam.tenant 'demo-buyer' (Demo Buyer Co)  → the buyer
--   farm.sourcing_region 'Central Iowa'
--   farm.supplier 'Prairie Grain Cooperative'
--   farm.farm_profile 'Demo Corn Farm' (real bbox + boundaries)
--   farm.parcel 'North 80' + farm.zone 'Center Pivot A' (irrigation intent)
--
-- HARD INVARIANT (docs/03 §6): ZERO observations/derived_signals/alerts/reports/
-- scans/recommendations/risk rows — those only ever arrive from a real AlphaGeo
-- round-trip and are NEVER fabricated.
--
-- Fully idempotent: tenant via ON CONFLICT(slug); every child via a NOT EXISTS
-- guard on its natural key. A DO block resolves ids so re-runs are no-ops.
-- =============================================================================

-- ---- buyer tenant -----------------------------------------------------------
INSERT INTO iam.tenant (slug, display_name, plan)
VALUES ('demo-buyer', 'Demo Buyer Co', 'pro')
ON CONFLICT (slug) DO NOTHING;

-- ---- buyer admin user (demoability; harmless) -------------------------------
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'admin@demo-buyer.local', 'Admin (Demo Buyer Co)',
       ARRAY['tenant.admin','farm:view','farm:onboard']::TEXT[]
  FROM iam.tenant t
 WHERE t.slug = 'demo-buyer'
ON CONFLICT (tenant_id, email) DO NOTHING;

DO $$
DECLARE
  v_tenant   UUID;
  v_region   UUID;
  v_supplier UUID;
  v_farm     UUID;
  -- Central Iowa corn-belt AOI (real, Sentinel-2 covered).
  v_w NUMERIC := -93.75; v_s NUMERIC := 41.95; v_e NUMERIC := -93.55; v_n NUMERIC := 42.10;
BEGIN
  SELECT id INTO v_tenant FROM iam.tenant WHERE slug = 'demo-buyer';
  IF v_tenant IS NULL THEN
    RAISE NOTICE '[299] demo-buyer tenant absent; skipping farm demo seed.';
    RETURN;
  END IF;

  -- sourcing region ----------------------------------------------------------
  SELECT id INTO v_region FROM farm.sourcing_region
   WHERE tenant_id = v_tenant AND name = 'Central Iowa';
  IF v_region IS NULL THEN
    INSERT INTO farm.sourcing_region (tenant_id, name, country, admin_area, geom, centroid)
    VALUES (v_tenant, 'Central Iowa', 'US', 'Iowa',
            ST_Multi(ST_MakeEnvelope(v_w, v_s, v_e, v_n, 4326))::geography,
            ST_SetSRID(ST_MakePoint((v_w+v_e)/2, (v_s+v_n)/2), 4326)::geography)
    RETURNING id INTO v_region;
  END IF;

  -- supplier -----------------------------------------------------------------
  SELECT id INTO v_supplier FROM farm.supplier
   WHERE tenant_id = v_tenant AND name = 'Prairie Grain Cooperative';
  IF v_supplier IS NULL THEN
    INSERT INTO farm.supplier (tenant_id, sourcing_region_id, name, external_ref, status, tier)
    VALUES (v_tenant, v_region, 'Prairie Grain Cooperative', 'SUP-0001', 'active', 'strategic')
    RETURNING id INTO v_supplier;
  END IF;

  -- farm profile (real bbox + boundaries) ------------------------------------
  SELECT id INTO v_farm FROM farm.farm_profile
   WHERE tenant_id = v_tenant AND name = 'Demo Corn Farm';
  IF v_farm IS NULL THEN
    INSERT INTO farm.farm_profile (
      tenant_id, supplier_id, name, timezone, currency, farm_types, crops,
      total_area_ha, boundaries, signal_source,
      aoi_west, aoi_south, aoi_east, aoi_north, status
    ) VALUES (
      v_tenant, v_supplier, 'Demo Corn Farm', 'America/Chicago', 'USD',
      ARRAY['row-crop']::TEXT[], ARRAY['corn','soybean']::TEXT[],
      1200,
      ST_Multi(ST_MakeEnvelope(v_w, v_s, v_e, v_n, 4326))::geography,
      'gateway', v_w, v_s, v_e, v_n, 'active'
    ) RETURNING id INTO v_farm;
  END IF;

  -- parcel (a sub-rectangle of the AOI) --------------------------------------
  IF NOT EXISTS (SELECT 1 FROM farm.parcel WHERE tenant_id = v_tenant AND farm_id = v_farm AND name = 'North 80') THEN
    INSERT INTO farm.parcel (tenant_id, farm_id, name, geom, area_ha, tags)
    VALUES (v_tenant, v_farm, 'North 80',
            ST_MakeEnvelope(-93.72, 41.98, -93.62, 42.05, 4326)::geography,
            320, ARRAY['field']::TEXT[]);
  END IF;

  -- zone with irrigation intent (standingWaterAllowed = false) ---------------
  IF NOT EXISTS (SELECT 1 FROM farm.zone WHERE tenant_id = v_tenant AND farm_id = v_farm AND name = 'Center Pivot A') THEN
    INSERT INTO farm.zone (tenant_id, farm_id, parcel_id, name, type, intent, geom, tags)
    SELECT v_tenant, v_farm,
           (SELECT id FROM farm.parcel WHERE tenant_id = v_tenant AND farm_id = v_farm AND name = 'North 80'),
           'Center Pivot A', 'irrigation-zone',
           jsonb_build_object(
             'expectedWaterFlow', true,
             'standingWaterAllowed', false,
             'vegetationPriority', 'high',
             'alertSensitivity', 'medium'
           ),
           ST_MakeEnvelope(-93.70, 41.99, -93.66, 42.02, 4326)::geography,
           ARRAY['irrigated']::TEXT[];
  END IF;

  RAISE NOTICE '[299] farm demo seeded (tenant=%, region=%, supplier=%, farm=%).',
    v_tenant, v_region, v_supplier, v_farm;
END $$;
