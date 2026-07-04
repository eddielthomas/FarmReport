-- =============================================================================
-- 320_farm_reshape_legacy_demo.sql — de-water the legacy 099 demo tenants.
-- -----------------------------------------------------------------------------
-- The original 099_seed_demo.sql seeded two water-utility demo tenants
-- ('demoville-a' → "Demoville Water Authority", 'acme-water' → "Acme Water
-- Services") with leak-detection products, water leads and detection cases.
-- Report.Farm is a FARM product — none of that copy should be user-visible.
--
-- 099 guards every insert with ON CONFLICT DO NOTHING / NOT EXISTS, so simply
-- editing 099 only helps fresh databases. This migration reshapes the rows that
-- already exist in a running DB to farm vocabulary. Slugs are intentionally left
-- alone (they are FK-woven through 148/152/163/166 legacy seeds); only the
-- human-visible display copy changes. Fully idempotent — safe to re-run.
-- =============================================================================

-- ---- tenant display names ---------------------------------------------------
UPDATE iam.tenant SET display_name = 'Prairie Harvest Collective'
 WHERE slug = 'demoville-a';
UPDATE iam.tenant SET display_name = 'Sunbelt Grower Alliance'
 WHERE slug = 'acme-water';

-- ---- seeded admin user display names (embed the tenant name) -----------------
UPDATE iam.user_profile up
   SET display_name = 'Admin (' || t.display_name || ')'
  FROM iam.tenant t
 WHERE up.tenant_id = t.id
   AND t.slug IN ('demoville-a','acme-water')
   AND up.email = 'admin@' || t.slug || '.local';

-- ---- product catalog → farm monitoring services -----------------------------
UPDATE sales.product p SET name = v.new_name
  FROM iam.tenant t,
       (VALUES
         ('LDS-100', 'Crop Health Survey'),
         ('PMK-200', 'Irrigation Monitoring Plan'),
         ('SAR-300', 'SAR Field Assessment'),
         ('QHR-400', 'Quarterly Yield Report'),
         ('ERR-500', 'Disruption Response Retainer')
       ) AS v(sku, new_name)
 WHERE p.tenant_id = t.id
   AND t.slug IN ('demoville-a','acme-water')
   AND p.sku = v.sku;

-- ---- leads → farm buyers/co-ops + farm interests -----------------------------
-- Company + interest were derived from (seq % 5); remap each water value to its
-- farm equivalent wherever it still shows up on the seeded rows.
UPDATE sales.lead l SET company = v.new_company
  FROM iam.tenant t,
       (VALUES
         ('Riverside Utilities', 'Riverside Orchards'),
         ('Northbay Water',      'Northbay Produce'),
         ('Greenfield Co-op',    'Greenfield Grain Co-op'),
         ('Metro PUD',           'Metro Grain Traders'),
         ('Acme Civil Works',    'Acme Foods')
       ) AS v(old_company, new_company)
 WHERE l.tenant_id = t.id
   AND t.slug IN ('demoville-a','acme-water')
   AND l.company = v.old_company;

UPDATE sales.lead l SET interest = v.new_interest
  FROM iam.tenant t,
       (VALUES
         ('Leak Detection',      'Crop Health'),
         ('Pressure Monitoring', 'Irrigation Monitoring'),
         ('SAR Assessment',      'SAR Field Assessment'),
         ('Quarterly Reporting', 'Quarterly Yield Reporting'),
         ('Emergency Response',  'Disruption Response')
       ) AS v(old_interest, new_interest)
 WHERE l.tenant_id = t.id
   AND t.slug IN ('demoville-a','acme-water')
   AND l.interest = v.old_interest;

-- ---- cases: "detection" → "observation" -------------------------------------
UPDATE ops.case c
   SET title = REPLACE(c.title, 'Investigate detection DET-', 'Investigate observation OBS-'),
       description = 'Auto-seeded case linked to a field observation.',
       detection_id = REPLACE(c.detection_id, 'DET-', 'OBS-')
  FROM iam.tenant t
 WHERE c.tenant_id = t.id
   AND t.slug IN ('demoville-a','acme-water')
   AND c.title LIKE 'Investigate detection DET-%';
