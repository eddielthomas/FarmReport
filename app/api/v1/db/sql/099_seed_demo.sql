-- =============================================================================
-- 099_seed_demo.sql — demo tenants + leads + products
-- -----------------------------------------------------------------------------
-- Idempotent: uses ON CONFLICT (slug) so re-running the migration runner is
-- a no-op even though this file always inserts. Lead rows are gated behind a
-- per-tenant guard so they only seed once per tenant.
-- =============================================================================

-- ---- tenants ----------------------------------------------------------------
-- NOTE: slugs are kept as-is (FK-woven through 148/152/163/166 legacy seeds);
-- only the farm-facing display copy matters. 320_farm_reshape_legacy_demo.sql
-- reshapes any pre-existing water rows in a running DB to match these names.
INSERT INTO iam.tenant (slug, display_name, plan)
VALUES
  ('demoville-a', 'Prairie Harvest Collective', 'mvp'),
  ('acme-water',  'Sunbelt Grower Alliance',    'pro')
ON CONFLICT (slug) DO NOTHING;

-- ---- seed users -------------------------------------------------------------
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'admin@' || t.slug || '.local', 'Admin (' || t.display_name || ')',
       ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view']::TEXT[]
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
ON CONFLICT (tenant_id, email) DO NOTHING;

-- ---- product catalog per tenant --------------------------------------------
INSERT INTO sales.product (tenant_id, name, sku, price, active)
SELECT t.id, p.name, p.sku, p.price, TRUE
  FROM iam.tenant t
  CROSS JOIN (VALUES
    ('Crop Health Survey',          'LDS-100',  12500.00),
    ('Irrigation Monitoring Plan',  'PMK-200',   4250.00),
    ('SAR Field Assessment',        'SAR-300',  18000.00),
    ('Quarterly Yield Report',      'QHR-400',   3500.00),
    ('Disruption Response Retainer','ERR-500',  9500.00)
  ) AS p(name, sku, price)
 WHERE t.slug IN ('demoville-a','acme-water')
   AND NOT EXISTS (SELECT 1 FROM sales.product sp WHERE sp.tenant_id = t.id AND sp.sku = p.sku);

-- ---- leads (only seed if tenant has fewer than 5 leads already) ------------
WITH targets AS (
  SELECT t.id AS tenant_id, t.slug
    FROM iam.tenant t
   WHERE t.slug IN ('demoville-a','acme-water')
     AND (SELECT COUNT(*) FROM sales.lead l WHERE l.tenant_id = t.id) < 5
),
seed_rows AS (
  SELECT t.tenant_id,
         (ARRAY['Info Request','Info Request','Info Request','Info Request','Info Request','Info Request',
                'Lead','Lead','Lead','Lead','Lead','Lead','Lead',
                'Client','Client','Client','Client','Client','Client','Client'])[gs] AS status,
         gs AS seq
    FROM targets t
    CROSS JOIN generate_series(1, 20) gs
)
INSERT INTO sales.lead (
  tenant_id, name, email, phone, company, position, status, source, source_details,
  interest, total_revenue, status_timestamps, selected_products, created_at, updated_at
)
SELECT
  sr.tenant_id,
  'Contact ' || sr.seq || ' (' || sr.status || ')',
  'contact' || sr.seq || '@example-' || (sr.seq % 5 + 1) || '.com',
  '+1-555-01' || LPAD(sr.seq::TEXT, 2, '0'),
  (ARRAY['Riverside Orchards','Northbay Produce','Greenfield Grain Co-op','Metro Grain Traders','Acme Foods'])[(sr.seq % 5) + 1],
  (ARRAY['Operations Manager','Field Supervisor','GIS Lead','Procurement Officer','VP Agronomy'])[(sr.seq % 5) + 1],
  sr.status,
  (ARRAY['Website','Referral','Trade Show','Cold Outreach','Existing Client'])[(sr.seq % 5) + 1],
  'Seeded sample lead #' || sr.seq,
  (ARRAY['Crop Health','Irrigation Monitoring','SAR Field Assessment','Quarterly Yield Reporting','Disruption Response'])[(sr.seq % 5) + 1],
  CASE WHEN sr.status = 'Client' THEN ((sr.seq * 1750)::NUMERIC + 5000) ELSE 0 END,
  CASE
    WHEN sr.status = 'Info Request'
      THEN jsonb_build_object('infoRequestedAt', (now() - (sr.seq || ' days')::INTERVAL)::TEXT)
    WHEN sr.status = 'Lead'
      THEN jsonb_build_object(
        'infoRequestedAt',     (now() - ((sr.seq + 14) || ' days')::INTERVAL)::TEXT,
        'convertedToLeadAt',   (now() - (sr.seq || ' days')::INTERVAL)::TEXT
      )
    ELSE jsonb_build_object(
        'infoRequestedAt',     (now() - ((sr.seq + 30) || ' days')::INTERVAL)::TEXT,
        'convertedToLeadAt',   (now() - ((sr.seq + 14) || ' days')::INTERVAL)::TEXT,
        'convertedToClientAt', (now() - (sr.seq || ' days')::INTERVAL)::TEXT
      )
  END,
  '[]'::jsonb,
  now() - (sr.seq || ' days')::INTERVAL,
  now() - (sr.seq || ' days')::INTERVAL
FROM seed_rows sr;

-- ---- a handful of demo cases per tenant ------------------------------------
WITH ct AS (
  SELECT t.id AS tenant_id, t.slug
    FROM iam.tenant t
   WHERE t.slug IN ('demoville-a','acme-water')
     AND (SELECT COUNT(*) FROM ops.case c WHERE c.tenant_id = t.id) < 3
)
INSERT INTO ops.case (tenant_id, title, description, status, priority, detection_id, opened_at)
SELECT
  ct.tenant_id,
  'Investigate observation ' || ('OBS-' || (1000 + gs)),
  'Auto-seeded case linked to a field observation.',
  (ARRAY['open','assigned','in_progress','blocked','closed'])[((gs - 1) % 5) + 1],
  (ARRAY['low','medium','high','critical'])[((gs - 1) % 4) + 1],
  'OBS-' || (1000 + gs),
  now() - (gs || ' days')::INTERVAL
FROM ct
CROSS JOIN generate_series(1, 10) gs;
