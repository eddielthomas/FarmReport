-- =============================================================================
-- 150_crm_project_scene.sql — Sprint 14A: customer projects + saved map scenes.
-- -----------------------------------------------------------------------------
-- Ops/sales can curate per-customer projects and pin a stack of saved map scenes
-- (camera, basemap, SAR overlay, layer toggles, time-window, scan refs) per
-- project. The customer portal renders the project's `is_default` scene as
-- the hero map and lists the rest in a horizontal carousel.
--
-- Tables:
--   crm.project         — one row per commissioned customer engagement.
--                         Links optionally to a sales.lead (source), a
--                         sales.contact (the customer identity) and/or a
--                         sales.organization (firmographic anchor).
--   crm.project_scene   — saved map scene under a project. At-most-one row may
--                         carry is_default=true (unique partial index).
--
-- RLS + Bell-LaPadula clearance lattice are bound to every row via the canonical
-- tenant_id + classification pattern shared with 139_classification.sql.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;

-- ---- crm.project ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.project (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification           TEXT NOT NULL DEFAULT 'internal'
                             CHECK (classification IN ('public','internal','confidential','secret')),
  customer_contact_id      UUID NULL REFERENCES sales.contact(id) ON DELETE SET NULL,
  customer_organization_id UUID NULL REFERENCES sales.organization(id) ON DELETE SET NULL,
  source_lead_id           UUID NULL REFERENCES sales.lead(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  description              TEXT NULL,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','paused','completed','archived')),
  created_by               UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_tenant_customer_status_idx
  ON crm.project (tenant_id, customer_contact_id, status);
CREATE INDEX IF NOT EXISTS project_tenant_org_status_idx
  ON crm.project (tenant_id, customer_organization_id, status);
CREATE INDEX IF NOT EXISTS project_tenant_source_lead_idx
  ON crm.project (tenant_id, source_lead_id);
CREATE INDEX IF NOT EXISTS project_classification_idx
  ON crm.project (tenant_id, classification) WHERE classification <> 'internal';

COMMENT ON TABLE crm.project IS
  'Customer engagement aggregate. Each row is an ops/sales-curated project that '
  'a customer may see in their portal. Hosts an ordered set of crm.project_scene '
  'rows; the scene marked is_default=true renders as the hero map.';
COMMENT ON COLUMN crm.project.customer_contact_id IS
  'The customer identity (sales.contact). Customer portal scopes /customer/me/projects '
  'against rows where this matches the caller, OR via source_lead_id -> contact_lead chain.';
COMMENT ON COLUMN crm.project.source_lead_id IS
  'Originating sales.lead (when the project graduated from a lead). Used as the '
  'fallback path for /customer/me/projects scoping via sales.contact_lead.';

-- ---- crm.project_scene ------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.project_scene (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification  TEXT NOT NULL DEFAULT 'internal'
                    CHECK (classification IN ('public','internal','confidential','secret')),
  project_id      UUID NOT NULL REFERENCES crm.project(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NULL,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  ordinal         INTEGER NOT NULL DEFAULT 0,
  center_lat      NUMERIC(9,6) NULL,
  center_lon      NUMERIC(9,6) NULL,
  zoom            NUMERIC(5,2) NULL,
  pitch           NUMERIC(5,2) NOT NULL DEFAULT 0,
  bearing         NUMERIC(5,2) NOT NULL DEFAULT 0,
  basemap_id      TEXT NULL,
  sar_overlay     BOOLEAN NOT NULL DEFAULT FALSE,
  sar_opacity     INTEGER NOT NULL DEFAULT 60
                    CHECK (sar_opacity BETWEEN 0 AND 100),
  active_layers   TEXT[] NOT NULL DEFAULT '{}',
  time_start      TIMESTAMPTZ NULL,
  time_end        TIMESTAMPTZ NULL,
  scan_ids        UUID[] NOT NULL DEFAULT '{}',
  thumbnail_url   TEXT NULL,
  created_by      UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_scene_tenant_project_ordinal_idx
  ON crm.project_scene (tenant_id, project_id, ordinal);
CREATE INDEX IF NOT EXISTS project_scene_classification_idx
  ON crm.project_scene (tenant_id, classification) WHERE classification <> 'internal';

-- At most one default per project — enforced at the storage layer.
CREATE UNIQUE INDEX IF NOT EXISTS project_scene_default_uniq
  ON crm.project_scene (project_id) WHERE is_default = true;

COMMENT ON TABLE crm.project_scene IS
  'Saved map scene under a crm.project. UI hydrates camera + basemap + SAR + '
  'active_layers + time window from this row. is_default=true means the customer '
  'portal hero map renders this scene; only one row per project may have it set '
  '(enforced by project_scene_default_uniq partial index).';
COMMENT ON COLUMN crm.project_scene.basemap_id IS
  'Brand basemap id (hydrovision/thermsight/pressurepulse/nightwatch/echoscan/'
  'coherencemap/greenline/deepgrid/riskatlas/satellite) OR legacy '
  '(satellite/streets/dark). Validated in the API layer.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE crm.project       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.project_scene ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['project','project_scene']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'crm' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON crm.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
      pol, t);
  END LOOP;
END $$;

COMMIT;
