-- =============================================================================
-- 152_demo_customer_seed.sql — wire the demo customer dev-login accounts
-- (`customer@<tenant>.demo`) through the full Project/Scene chain so the
-- customer portal renders something meaningful instead of the
-- "Account being prepared" empty state.
-- -----------------------------------------------------------------------------
-- For each seeded tenant (demoville-a, acme-water):
--   1. Ensure a sales.contact row with the demo customer email
--   2. Ensure a sales.lead linked to that contact
--   3. Link contact ↔ lead via sales.contact_lead
--   4. Ensure a crm.project with that contact as customer_contact_id
--   5. Ensure a default crm.project_scene on that project
--
-- All steps are idempotent — safe to re-apply.
-- =============================================================================

DO $$
DECLARE
  rec RECORD;
  c_id UUID;
  l_id UUID;
  p_id UUID;
  s_lat NUMERIC;
  s_lon NUMERIC;
  s_company TEXT;
  s_project_title TEXT;
BEGIN
  FOR rec IN
    SELECT id, slug FROM iam.tenant WHERE slug IN ('demoville-a','acme-water')
  LOOP
    -- Tenant-specific defaults
    IF rec.slug = 'demoville-a' THEN
      s_lat := 33.4484; s_lon := -112.0740;
      s_company := 'Demoville Water Authority';
      s_project_title := 'Demoville Water Recon Q2 2026';
    ELSE
      s_lat := 29.7604; s_lon := -95.3698;
      s_company := 'Acme Water Services';
      s_project_title := 'Acme Pipeline Survey 2026';
    END IF;

    -- 1) sales.contact (idempotent — partial unique index requires lookup-first)
    SELECT id INTO c_id
      FROM sales.contact
     WHERE tenant_id = rec.id
       AND lower(email) = 'customer@'||rec.slug||'.demo'
     LIMIT 1;
    IF c_id IS NULL THEN
      INSERT INTO sales.contact (tenant_id, first_name, last_name, email, status, source)
      VALUES (rec.id, 'Customer', 'Demo', 'customer@'||rec.slug||'.demo', 'active', 'Direct')
      RETURNING id INTO c_id;
    END IF;

    -- 2) sales.lead (idempotent by tenant + name)
    SELECT id INTO l_id
      FROM sales.lead
     WHERE tenant_id = rec.id AND name = 'Customer Demo Project'
     LIMIT 1;
    IF l_id IS NULL THEN
      INSERT INTO sales.lead (
        tenant_id, name, email, phone, company, status, source,
        total_revenue, primary_contact_id, location
      )
      VALUES (
        rec.id, 'Customer Demo Project',
        'customer@'||rec.slug||'.demo', '+1-555-0100',
        s_company, 'Client', 'Direct', 250000, c_id,
        ST_SetSRID(ST_MakePoint(s_lon, s_lat), 4326)::geography
      )
      RETURNING id INTO l_id;
    ELSE
      -- Ensure the primary_contact_id is wired (in case lead pre-existed)
      UPDATE sales.lead
         SET primary_contact_id = c_id
       WHERE id = l_id AND primary_contact_id IS DISTINCT FROM c_id;
    END IF;

    -- 3) Link contact ↔ lead
    INSERT INTO sales.contact_lead (tenant_id, contact_id, lead_id, role)
    VALUES (rec.id, c_id, l_id, 'primary')
    ON CONFLICT DO NOTHING;

    -- 4) crm.project (idempotent by tenant + title)
    SELECT id INTO p_id
      FROM crm.project
     WHERE tenant_id = rec.id AND title = s_project_title
     LIMIT 1;
    IF p_id IS NULL THEN
      INSERT INTO crm.project (
        tenant_id, customer_contact_id, source_lead_id,
        title, description, status, classification
      )
      VALUES (
        rec.id, c_id, l_id,
        s_project_title,
        'Pilot project — leak detection + AOI survey + scene catalog',
        'active', 'internal'
      )
      RETURNING id INTO p_id;
    END IF;

    -- 5) Default scene
    IF NOT EXISTS (
      SELECT 1 FROM crm.project_scene
       WHERE project_id = p_id AND title = 'Overview'
    ) THEN
      INSERT INTO crm.project_scene (
        tenant_id, project_id, title, description, is_default, ordinal,
        center_lat, center_lon, zoom, pitch, bearing,
        basemap_id, sar_overlay, sar_opacity, active_layers
      )
      VALUES (
        rec.id, p_id, 'Overview',
        'Default project view — leaks + AOI on satellite',
        TRUE, 0,
        s_lat, s_lon, 12.0, 0.0, 0.0,
        'satellite', FALSE, 60,
        ARRAY['leaks','aoi','pois']
      );
    END IF;

    -- Bonus scene: thermal close-up (showcases the brand basemap)
    IF NOT EXISTS (
      SELECT 1 FROM crm.project_scene
       WHERE project_id = p_id AND title = 'Thermal close-up'
    ) THEN
      INSERT INTO crm.project_scene (
        tenant_id, project_id, title, description, is_default, ordinal,
        center_lat, center_lon, zoom, pitch, bearing,
        basemap_id, sar_overlay, sar_opacity, active_layers
      )
      VALUES (
        rec.id, p_id, 'Thermal close-up',
        'ThermSight basemap — buried-pipe heat corridors',
        FALSE, 1,
        s_lat, s_lon, 16.0, 45.0, 30.0,
        'thermsight', FALSE, 60,
        ARRAY['leaks','pois']
      );
    END IF;

    -- Bonus scene: SAR backscatter view
    IF NOT EXISTS (
      SELECT 1 FROM crm.project_scene
       WHERE project_id = p_id AND title = 'SAR survey'
    ) THEN
      INSERT INTO crm.project_scene (
        tenant_id, project_id, title, description, is_default, ordinal,
        center_lat, center_lon, zoom, pitch, bearing,
        basemap_id, sar_overlay, sar_opacity, active_layers
      )
      VALUES (
        rec.id, p_id, 'SAR survey',
        'EchoScan + Sentinel-1 SAR overlay — radar-native ops view',
        FALSE, 2,
        s_lat, s_lon, 13.5, 0.0, 0.0,
        'echoscan', TRUE, 70,
        ARRAY['leaks','aoi','pois']
      );
    END IF;
  END LOOP;
END$$;
