-- =============================================================================
-- 204_farm_recommendation_report.sql — Report + Recommendation + ActionFeedback.
-- -----------------------------------------------------------------------------
-- Completes the canonical entities (research doc §Canonical data model / §Example
-- JSON schemas):
--   farm.report          — scheduled/urgent/on-demand report; sections JSONB +
--                          frozen artifact URLs.
--   farm.recommendation  — an AI-suggested action tied to an alert and/or report;
--                          carries an ROI estimate.
--   farm.action_feedback — the human-in-the-loop learning label ("was this alert/
--                          recommendation useful?") that closes the feedback loop.
--
-- report is defined first so recommendation can FK it. Additive + idempotent.
-- RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.report ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.report (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id       UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'scheduled',      -- scheduled|urgent|on-demand
  title         TEXT NOT NULL,
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'draft',          -- draft|final|delivered
  summary       TEXT,
  sections      JSONB NOT NULL DEFAULT '[]'::jsonb,     -- ordered report sections
  artifact_url  TEXT,                                   -- primary rendered artifact (pdf/html)
  artifact_urls JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {pdf, html, csv, …} frozen artifacts
  channels      TEXT[] NOT NULL DEFAULT '{}',           -- email|portal|webhook|...
  generated_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_report_farm_idx ON farm.report (tenant_id, farm_id, created_at DESC);

COMMENT ON TABLE farm.report IS
  'Scheduled/urgent/on-demand report. sections is the ordered content; '
  'artifact_urls freezes rendered PDF/HTML for reproducibility.';

-- ---- farm.recommendation ----------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.recommendation (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id     UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  alert_id    UUID REFERENCES farm.alert(id) ON DELETE SET NULL,
  report_id   UUID REFERENCES farm.report(id) ON DELETE SET NULL,
  zone_id     UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  action_type TEXT,                                     -- inspect|irrigate|treat|schedule|...
  priority    TEXT NOT NULL DEFAULT 'medium',           -- critical|high|medium|low
  roi         JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {costUsd, benefitUsd, paybackDays, …}
  status      TEXT NOT NULL DEFAULT 'open',             -- open|accepted|dismissed|done
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_reco_farm_idx  ON farm.recommendation (tenant_id, farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_reco_alert_idx ON farm.recommendation (tenant_id, alert_id);

-- ---- farm.action_feedback ---------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.action_feedback (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id           UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  alert_id          UUID REFERENCES farm.alert(id) ON DELETE SET NULL,
  recommendation_id UUID REFERENCES farm.recommendation(id) ON DELETE SET NULL,
  label             TEXT NOT NULL,                       -- useful|not-useful|false-positive|actioned|dismissed
  rating            INTEGER,                             -- optional 1..5
  comment           TEXT,
  actor_id          UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_feedback_farm_idx ON farm.action_feedback (tenant_id, farm_id, created_at DESC);

COMMENT ON TABLE farm.action_feedback IS
  'Human-in-the-loop label on an alert/recommendation; feeds the learning loop.';
