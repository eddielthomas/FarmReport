-- =============================================================================
-- 122_sales_lifecycle.sql — EPIC-003 P-003 CRM Lifecycle Objects (Sprint 2A).
-- -----------------------------------------------------------------------------
-- Adds first-class Organization / Contact / Activity / RevenueRecord / Vendor.
--   - 5 PG enum types in the sales schema
--   - new tenant-scoped tables (all with leading tenant_id index + RLS)
--   - append-only triggers on sales.activity + sales.revenue_record
--   - 3 new FK columns on sales.lead (organization_id, primary_contact_id, vendor_id)
--   - lead status/source CHECK constraints aligned with the 5-value lifecycle
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

BEGIN;

-- ---- 1) PG enum types -------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'sales' AND t.typname = 'lead_status_t') THEN
    CREATE TYPE sales.lead_status_t AS ENUM (
      'Info Request','Lead','Client','Archived','Contact Only'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'sales' AND t.typname = 'lead_source_t') THEN
    CREATE TYPE sales.lead_source_t AS ENUM (
      'Agent','RWR Generated','Vendor','Direct','Social Media'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'sales' AND t.typname = 'activity_kind_t') THEN
    CREATE TYPE sales.activity_kind_t AS ENUM (
      'system','note','status_change','call','email','sms',
      'meeting','assignment','attachment','message','revenue'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'sales' AND t.typname = 'activity_entity_kind_t') THEN
    CREATE TYPE sales.activity_entity_kind_t AS ENUM (
      'lead','contact','organization','client','opportunity',
      'meeting','revenue_record','vendor'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'sales' AND t.typname = 'revenue_status_t') THEN
    CREATE TYPE sales.revenue_status_t AS ENUM (
      'booked','recognized','invoiced','paid','refunded','credited'
    );
  END IF;
END$$;

-- ---- 2) sales.organization --------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.organization (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  domain        TEXT,
  industry      TEXT,
  size_band     TEXT CHECK (size_band IS NULL OR size_band IN
                  ('1-10','11-50','51-200','201-1000','1001-5000','5000+')),
  address       JSONB NOT NULL DEFAULT '{}'::jsonb,
  website       TEXT,
  parent_org_id UUID REFERENCES sales.organization(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','prospect','archived')),
  source        sales.lead_source_t,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_tenant_idx
  ON sales.organization (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS organization_tenant_name_uniq
  ON sales.organization (tenant_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS organization_tenant_domain_uniq
  ON sales.organization (tenant_id, lower(domain)) WHERE domain IS NOT NULL;

-- ---- 3) sales.contact -------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.contact (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  organization_id   UUID REFERENCES sales.organization(id) ON DELETE SET NULL,
  first_name        TEXT,
  last_name         TEXT,
  full_name         TEXT GENERATED ALWAYS AS
                      (trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) STORED,
  email             TEXT,
  email_secondary   TEXT,
  phone             TEXT,
  phone_secondary   TEXT,
  title             TEXT,
  position          TEXT,
  avatar_url        TEXT,
  linkedin_url      TEXT,
  preferred_channel TEXT CHECK (preferred_channel IS NULL OR preferred_channel IN
                      ('email','phone','sms','in_app')),
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT FALSE,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','archived','bounced','do_not_contact')),
  notes             TEXT,
  source            sales.lead_source_t,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_tenant_idx
  ON sales.contact (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS contact_tenant_email_uniq
  ON sales.contact (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_tenant_org_idx
  ON sales.contact (tenant_id, organization_id);

-- ---- 4) sales.contact_lead --------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.contact_lead (
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES sales.contact(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES sales.lead(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'primary'
                CHECK (role IN ('primary','decision_maker','influencer','champion','blocker','observer')),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by   UUID,
  unlinked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, contact_id, lead_id)
);
CREATE INDEX IF NOT EXISTS contact_lead_tenant_lead_idx
  ON sales.contact_lead (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS contact_lead_tenant_contact_idx
  ON sales.contact_lead (tenant_id, contact_id);

-- ---- 5) sales.activity ------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.activity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  entity_kind     sales.activity_entity_kind_t NOT NULL,
  entity_id       UUID NOT NULL,
  kind            sales.activity_kind_t NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','system','external')),
  actor_id        UUID,
  actor_label     TEXT,
  text            TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_event_id  UUID,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_tenant_entity_idx
  ON sales.activity (tenant_id, entity_kind, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_tenant_actor_idx
  ON sales.activity (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS activity_tenant_kind_idx
  ON sales.activity (tenant_id, kind, occurred_at DESC);

-- Append-only enforcement (UPDATE + DELETE rejected; INSERT allowed).
CREATE OR REPLACE FUNCTION sales.activity_block_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sales.activity is append-only (op=%)', TG_OP;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS activity_no_mutation ON sales.activity;
CREATE TRIGGER activity_no_mutation BEFORE UPDATE OR DELETE ON sales.activity
  FOR EACH ROW EXECUTE FUNCTION sales.activity_block_mutation();

-- ---- 6) sales.revenue_record ------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.revenue_record (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  client_lead_id        UUID NOT NULL REFERENCES sales.lead(id) ON DELETE RESTRICT,
  organization_id       UUID REFERENCES sales.organization(id) ON DELETE SET NULL,
  opportunity_id        UUID REFERENCES sales.opportunity(id) ON DELETE SET NULL,
  product_id            UUID REFERENCES sales.product(id) ON DELETE SET NULL,
  amount                NUMERIC(12,2) NOT NULL,
  currency              CHAR(3) NOT NULL DEFAULT 'USD',
  billing_period_start  DATE,
  billing_period_end    DATE,
  recognized_at         TIMESTAMPTZ,
  status                sales.revenue_status_t NOT NULL DEFAULT 'booked',
  invoice_ref           TEXT,
  external_ref          TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount >= 0 OR status IN ('refunded','credited'))
);
CREATE INDEX IF NOT EXISTS revenue_tenant_idx
  ON sales.revenue_record (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS revenue_tenant_client_idx
  ON sales.revenue_record (tenant_id, client_lead_id, recognized_at DESC);
CREATE INDEX IF NOT EXISTS revenue_tenant_status_idx
  ON sales.revenue_record (tenant_id, status);

-- Append-only on DELETE (UPDATE allowed only for status transitions via API).
-- Per plan: refunds are issued as compensating rows; DELETE is forbidden.
CREATE OR REPLACE FUNCTION sales.revenue_block_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sales.revenue_record is append-only (op=%)', TG_OP;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS revenue_no_delete ON sales.revenue_record;
CREATE TRIGGER revenue_no_delete BEFORE DELETE ON sales.revenue_record
  FOR EACH ROW EXECUTE FUNCTION sales.revenue_block_delete();

-- Rollup view (lead-level totals).
CREATE OR REPLACE VIEW sales.v_lead_revenue AS
  SELECT
    tenant_id,
    client_lead_id AS lead_id,
    sum(amount) FILTER (WHERE status IN ('recognized','paid'))   AS recognized_total,
    sum(amount) FILTER (WHERE status = 'booked')                 AS booked_total,
    sum(amount) FILTER (WHERE status IN ('refunded','credited')) AS offset_total,
    currency
  FROM sales.revenue_record
  GROUP BY tenant_id, client_lead_id, currency;

-- ---- 7) sales.vendor --------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.vendor (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  payout_terms  TEXT,
  payout_pct    NUMERIC(5,2),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','archived')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_tenant_idx
  ON sales.vendor (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_tenant_name_uniq
  ON sales.vendor (tenant_id, lower(name));

-- ---- 8) Extend sales.lead ---------------------------------------------------
ALTER TABLE sales.lead
  ADD COLUMN IF NOT EXISTS organization_id    UUID,
  ADD COLUMN IF NOT EXISTS primary_contact_id UUID,
  ADD COLUMN IF NOT EXISTS vendor_id          UUID,
  ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason    TEXT;

-- Attach FKs only if missing (DO blocks are idempotent — pg_constraint check).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_organization_id_fkey') THEN
    ALTER TABLE sales.lead ADD CONSTRAINT lead_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES sales.organization(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_primary_contact_id_fkey') THEN
    ALTER TABLE sales.lead ADD CONSTRAINT lead_primary_contact_id_fkey
      FOREIGN KEY (primary_contact_id) REFERENCES sales.contact(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_vendor_id_fkey') THEN
    ALTER TABLE sales.lead ADD CONSTRAINT lead_vendor_id_fkey
      FOREIGN KEY (vendor_id) REFERENCES sales.vendor(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lead_tenant_org_idx
  ON sales.lead (tenant_id, organization_id);
CREATE INDEX IF NOT EXISTS lead_tenant_primary_contact_idx
  ON sales.lead (tenant_id, primary_contact_id);
CREATE INDEX IF NOT EXISTS lead_tenant_vendor_idx
  ON sales.lead (tenant_id, vendor_id);

-- Lead status CHECK aligned with the 5-value lifecycle. The API layer is the
-- source-of-truth for legal transitions; the constraint just keeps the column
-- inside the lifecycle vocabulary. Existing rows already use the 3-value
-- subset (Info Request / Lead / Client) so this is non-breaking.
ALTER TABLE sales.lead
  DROP CONSTRAINT IF EXISTS lead_status_check;
ALTER TABLE sales.lead
  ADD CONSTRAINT lead_status_check
  CHECK (status IN ('Info Request','Lead','Client','Archived','Contact Only'));

-- Source: we intentionally do NOT add a strict CHECK here — the backfill
-- migration (123) buckets free-text values into the spec vocabulary first.
-- The API layer enforces the spec enum on write going forward.
ALTER TABLE sales.lead
  DROP CONSTRAINT IF EXISTS lead_source_check;

-- ---- 9) RLS on new tenant-scoped tables ------------------------------------
DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['organization','contact','contact_lead','activity','revenue_record','vendor'])
  LOOP
    EXECUTE format('ALTER TABLE sales.%I ENABLE ROW LEVEL SECURITY', t);
    pol := t || '_tenant_iso';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'sales' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON sales.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol, t);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE sales.organization    IS 'First-class firmographic entity per EPIC-003 P-003.';
COMMENT ON TABLE sales.contact         IS 'Person decoupled from Lead lifecycle (m:n via sales.contact_lead).';
COMMENT ON TABLE sales.contact_lead    IS 'Many-to-many contact <-> lead with role + linked/unlinked timestamps.';
COMMENT ON TABLE sales.activity        IS 'Unified polymorphic timeline. Append-only (triggers reject UPDATE/DELETE).';
COMMENT ON TABLE sales.revenue_record  IS 'Billing stream rows; refunds via offsetting compensating row.';
COMMENT ON TABLE sales.vendor          IS 'Vendor / source attribution table.';

COMMIT;
