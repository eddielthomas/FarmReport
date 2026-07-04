-- =============================================================================
-- 168_clients_projects_seed.sql — three real clients, three projects.
-- -----------------------------------------------------------------------------
-- Replaces the single inconsistent demo project with THREE separate clients,
-- each in their own gateway-backed project pointed at a real AOI that returns
-- live AlphaGeoCore indicators:
--
--   Client                          Project                       AOI indicators
--   Puerto Plata Water Authority    Puerto Plata — Water Recon    ~258
--   Houston Core Utilities          Houston Core — Water Recon    ~775
--   Cypress (LSC) Water District    Cypress (LSC) — Water Recon   ~205
--
-- Each client = sales.organization + sales.contact (customer identity) +
-- sales.lead (Client stage) linked via sales.contact_lead, owning one
-- crm.project with the correct AOI/center/zoom + a default scene.
--
-- All three live under the demoville-a operator tenant; the customer portal
-- scopes each customer-<city>@demoville-a.demo login to only their own project.
-- Strictly additive + idempotent (lookup-first / ON CONFLICT DO NOTHING).
-- =============================================================================

DO $$
DECLARE
  v_tenant UUID;
  rec      RECORD;
  org_id   UUID;
  c_id     UUID;
  l_id     UUID;
  p_id     UUID;
BEGIN
  SELECT id INTO v_tenant FROM iam.tenant WHERE slug = 'demoville-a' LIMIT 1;
  IF v_tenant IS NULL THEN RETURN; END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('Puerto Plata Water Authority', 'customer-pp@demoville-a.demo',
       'Puerto Plata — Water Recon',
       'Leak indicators across the Puerto Plata, DR AOI (AlphaGeoCore L-band / SAR fusion).',
       -70.75599::float8, 19.77537::float8, -70.68454::float8, 19.80362::float8,
       19.789495::numeric, -70.720265::numeric, 13.5::numeric, 'Pedro', 'Martínez'),
      ('Houston Core Utilities', 'customer-houston@demoville-a.demo',
       'Houston Core — Water Recon',
       'Leak indicators across the Houston core AOI (AlphaGeoCore · 4 districts).',
       -95.60934::float8, 29.74698::float8, -95.36423::float8, 29.98138::float8,
       29.864180::numeric, -95.486785::numeric, 11.0::numeric, 'Dana', 'Holloway'),
      ('Cypress (LSC) Water District', 'customer-cypress@demoville-a.demo',
       'Cypress (LSC) — Water Recon',
       'Leak indicators across the Lone Star College–CyFair AOI (AlphaGeoCore).',
       -95.69730::float8, 29.90982::float8, -95.69001::float8, 29.91318::float8,
       29.911500::numeric, -95.693655::numeric, 15.5::numeric, 'Sam', 'Whitfield')
    ) AS t(org_name, email, proj_title, proj_desc,
           w, s, e, n, clat, clon, z, fname, lname)
  LOOP
    -- 1) Organization (the client firmographic anchor)
    SELECT id INTO org_id FROM sales.organization
      WHERE tenant_id = v_tenant AND lower(name) = lower(rec.org_name) LIMIT 1;
    IF org_id IS NULL THEN
      INSERT INTO sales.organization (tenant_id, name, industry, status, source)
      VALUES (v_tenant, rec.org_name, 'Water Utility', 'active', 'Direct')
      RETURNING id INTO org_id;
    END IF;

    -- 2) Contact (the customer login identity)
    SELECT id INTO c_id FROM sales.contact
      WHERE tenant_id = v_tenant AND lower(email) = lower(rec.email) LIMIT 1;
    IF c_id IS NULL THEN
      INSERT INTO sales.contact (tenant_id, organization_id, first_name, last_name, email, status, source)
      VALUES (v_tenant, org_id, rec.fname, rec.lname, rec.email, 'active', 'Direct')
      RETURNING id INTO c_id;
    ELSE
      UPDATE sales.contact SET organization_id = org_id
        WHERE id = c_id AND organization_id IS DISTINCT FROM org_id;
    END IF;

    -- 3) Lead (Client stage) anchored to the contact
    SELECT id INTO l_id FROM sales.lead
      WHERE tenant_id = v_tenant AND name = rec.proj_title LIMIT 1;
    IF l_id IS NULL THEN
      INSERT INTO sales.lead (tenant_id, name, email, company, status, source,
                              total_revenue, primary_contact_id, location)
      VALUES (v_tenant, rec.proj_title, rec.email, rec.org_name, 'Client', 'Direct',
              0, c_id, ST_SetSRID(ST_MakePoint(rec.clon, rec.clat), 4326)::geography)
      RETURNING id INTO l_id;
    ELSE
      UPDATE sales.lead SET primary_contact_id = c_id
        WHERE id = l_id AND primary_contact_id IS DISTINCT FROM c_id;
    END IF;

    -- 4) Link contact ↔ lead
    INSERT INTO sales.contact_lead (tenant_id, contact_id, lead_id, role)
    VALUES (v_tenant, c_id, l_id, 'primary')
    ON CONFLICT DO NOTHING;

    -- 5) Project (gateway-backed, real AOI)
    SELECT id INTO p_id FROM crm.project
      WHERE tenant_id = v_tenant AND title = rec.proj_title LIMIT 1;
    IF p_id IS NULL THEN
      INSERT INTO crm.project (
        tenant_id, customer_contact_id, customer_organization_id, source_lead_id,
        title, description, status, classification,
        aoi_west, aoi_south, aoi_east, aoi_north,
        center_lat, center_lon, default_zoom, leak_source, sub_project_id)
      VALUES (
        v_tenant, c_id, org_id, l_id,
        rec.proj_title, rec.proj_desc, 'active', 'internal',
        rec.w, rec.s, rec.e, rec.n,
        rec.clat, rec.clon, rec.z, 'gateway', NULL)
      RETURNING id INTO p_id;
    ELSE
      -- keep the AOI/customer wiring authoritative if the project pre-existed
      UPDATE crm.project SET
        customer_contact_id = c_id, customer_organization_id = org_id, source_lead_id = l_id,
        aoi_west = rec.w, aoi_south = rec.s, aoi_east = rec.e, aoi_north = rec.n,
        center_lat = rec.clat, center_lon = rec.clon, default_zoom = rec.z,
        leak_source = 'gateway', updated_at = now()
      WHERE id = p_id;
    END IF;

    -- 6) Default scene (hero map flies to the AOI)
    IF NOT EXISTS (SELECT 1 FROM crm.project_scene WHERE project_id = p_id AND title = 'Overview') THEN
      INSERT INTO crm.project_scene (
        tenant_id, project_id, title, description, is_default, ordinal,
        center_lat, center_lon, zoom, pitch, bearing,
        basemap_id, sar_overlay, sar_opacity, active_layers)
      VALUES (
        v_tenant, p_id, 'Overview', 'Leak indicators on satellite', TRUE, 0,
        rec.clat, rec.clon, rec.z, 0.0, 0.0,
        'satellite', FALSE, 60, ARRAY['leaks','aoi','pois']);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM crm.project_scene WHERE project_id = p_id AND title = 'SAR survey') THEN
      INSERT INTO crm.project_scene (
        tenant_id, project_id, title, description, is_default, ordinal,
        center_lat, center_lon, zoom, pitch, bearing,
        basemap_id, sar_overlay, sar_opacity, active_layers)
      VALUES (
        v_tenant, p_id, 'SAR survey', 'EchoScan + Sentinel-1 SAR overlay', FALSE, 1,
        rec.clat, rec.clon, rec.z, 0.0, 0.0,
        'echoscan', TRUE, 70, ARRAY['leaks','aoi','pois']);
    END IF;
  END LOOP;
END$$;
