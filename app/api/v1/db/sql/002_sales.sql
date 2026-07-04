-- =============================================================================
-- 002_sales.sql — Sales Manager lifecycle
-- -----------------------------------------------------------------------------
-- Mirrors the Figma Make CRM model: lead → opportunity, plus notes / meetings /
-- messages / files / products catalog / status history. All tables carry a
-- tenant_id FK so the same Postgres instance serves N isolated customers.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS sales;

-- ---- core: lead -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.lead (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  company           TEXT,
  position          TEXT,
  status            TEXT NOT NULL DEFAULT 'Info Request',   -- Info Request | Lead | Client
  source            TEXT,
  source_details    TEXT,
  interest          TEXT,
  total_revenue     NUMERIC(12,2) NOT NULL DEFAULT 0,
  status_timestamps JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_products JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_tenant_status_idx ON sales.lead (tenant_id, status);
CREATE INDEX IF NOT EXISTS lead_tenant_created_idx ON sales.lead (tenant_id, created_at DESC);

-- ---- opportunity ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.opportunity (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id    UUID REFERENCES sales.lead(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  stage      TEXT NOT NULL DEFAULT 'discovery', -- discovery | qualified | proposal | won | lost
  amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  close_date DATE,
  owner_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_tenant_stage_idx ON sales.opportunity (tenant_id, stage);

-- ---- note -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.note (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id    UUID NOT NULL REFERENCES sales.lead(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  author_id  UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_lead_idx ON sales.note (tenant_id, lead_id, created_at DESC);

-- ---- meeting ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.meeting (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id    UUID REFERENCES sales.lead(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ NOT NULL,
  location   TEXT,
  attendees  JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_tenant_start_idx ON sales.meeting (tenant_id, start_at);

-- ---- message ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.message (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES sales.lead(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,                       -- agent | contact
  body        TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_lead_idx ON sales.message (tenant_id, lead_id, created_at);

-- ---- file -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.file (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id      UUID REFERENCES sales.lead(id) ON DELETE SET NULL,
  file_name    TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  file_type    TEXT,
  storage_path TEXT NOT NULL,
  signed_url   TEXT,
  uploaded_by  UUID,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_lead_idx ON sales.file (tenant_id, lead_id);

-- ---- product catalog --------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.product (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  sku       TEXT,
  price     NUMERIC(12,2) NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS product_tenant_idx ON sales.product (tenant_id, active);

-- ---- status history ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES sales.lead(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by  UUID,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS status_history_lead_idx ON sales.status_history (tenant_id, lead_id, changed_at DESC);
