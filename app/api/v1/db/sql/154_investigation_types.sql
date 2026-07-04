-- =============================================================================
-- 154_investigation_types.sql — Sprint: Investigation Typing.
-- -----------------------------------------------------------------------------
-- ops.investigation_type — platform-wide catalog of the investigation kinds a
-- generic ops.case can be specialised into. This is the typing dimension that
-- the Reporting engine keys off (each type drives a report template + default
-- priority).
--
-- Posture: SYSTEM CATALOG (no tenant_id). Analogous to iam.permission /
-- iam.field_policy — a platform-wide enumeration consumed read-only by every
-- tenant. It is NOT a place to store tenant data; ops.case carries the tenant.
-- The tenant-id audit gate exempts it for the same reason it exempts
-- iam.permission (see scripts/audit-tenant-id.mjs EXEMPT set).
--
-- Strictly additive + idempotent. Re-runs are no-ops (seed is ON CONFLICT).
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.investigation_type (
  key              TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  category         TEXT NOT NULL,
  default_priority TEXT NOT NULL DEFAULT 'medium'
                    CHECK (default_priority IN ('low','medium','high','critical')),
  description      TEXT,
  sort_order       INT  NOT NULL DEFAULT 100,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.investigation_type IS
  'Platform-wide catalog of investigation kinds a case can be typed as. Drives report templates + default priority. System catalog (no tenant_id).';

-- ---- Seed the 15 canonical investigation types ------------------------------
-- category groups types for the dashboard filter rail. default_priority is the
-- priority a freshly-typed case adopts unless the operator overrides it.
INSERT INTO ops.investigation_type (key, label, category, default_priority, description, sort_order) VALUES
  ('water_leak',            'Water Leak',             'water',          'high',     'Suspected potable / distribution water leak detected from imagery.',        10),
  ('pipeline_leak',         'Pipeline Leak',          'infrastructure', 'critical', 'Oil / gas / fluid pipeline leak or seepage.',                              20),
  ('infrastructure_damage', 'Infrastructure Damage',  'infrastructure', 'high',     'General built-infrastructure damage requiring assessment.',                30),
  ('bridge_damage',         'Bridge Damage',          'infrastructure', 'critical', 'Structural damage or deformation to a bridge.',                            40),
  ('road_damage',           'Road Damage',            'infrastructure', 'medium',   'Surface failure, potholing, or subsidence on roadway.',                    50),
  ('rail_damage',           'Rail Damage',            'infrastructure', 'high',     'Track, embankment, or rail structure damage.',                             60),
  ('environmental_event',   'Environmental Event',    'environment',    'high',     'Spill, contamination, or other environmental incident.',                   70),
  ('flood_risk',            'Flood Risk',             'environment',    'high',     'Elevated flood exposure or active inundation risk.',                       80),
  ('sinkhole_risk',         'Sinkhole Risk',          'environment',    'critical', 'Ground subsidence / sinkhole formation risk.',                             90),
  ('mining_opportunity',    'Mining Opportunity',     'resource',       'medium',   'Prospective mineral / aggregate extraction opportunity.',                 100),
  ('land_acquisition',      'Land Acquisition',       'land',           'medium',   'Parcel evaluation for acquisition (see land-acquisition domain).',        110),
  ('utility_mapping',       'Utility Mapping',        'infrastructure', 'low',      'Survey / mapping of utility assets and corridors.',                       120),
  ('illegal_construction',  'Illegal Construction',   'compliance',     'high',     'Unpermitted or non-compliant construction activity.',                     130),
  ('roof_damage',           'Roof Damage',            'infrastructure', 'medium',   'Roof / building-envelope damage assessment.',                             140),
  ('agricultural_analysis', 'Agricultural Analysis',  'agriculture',    'low',      'Crop health, yield, or land-use agricultural analysis.',                  150)
ON CONFLICT (key) DO UPDATE
  SET label            = EXCLUDED.label,
      category         = EXCLUDED.category,
      default_priority = EXCLUDED.default_priority,
      description      = EXCLUDED.description,
      sort_order       = EXCLUDED.sort_order;

COMMIT;
