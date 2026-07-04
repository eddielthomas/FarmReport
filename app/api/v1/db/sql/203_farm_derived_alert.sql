-- =============================================================================
-- 203_farm_derived_alert.sql — DerivedSignal + Alert.
-- -----------------------------------------------------------------------------
-- farm.derived_signal is the explainable middle layer: a change/stress signal
-- computed from one or more observations, carrying the evidence chain.
-- farm.alert is the operator-facing event with severity, evidence, estimated
-- financial impact, and recommended actions. dedup_key keeps event replays from
-- double-firing (mirrors crm.detection idempotency intent).
--
-- Additive + idempotent. RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.derived_signal ----------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.derived_signal (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id      UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id      UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,                          -- ndvi_delta|water_stress|change|disease_risk
  value        NUMERIC,
  baseline     NUMERIC,
  delta_pct    NUMERIC,
  confidence   NUMERIC,
  window_start TIMESTAMPTZ, window_end TIMESTAMPTZ,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,     -- observation ids + values (explainable chain)
  geom         geography(GEOMETRY, 4326),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_derived_farm_idx ON farm.derived_signal (tenant_id, farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_derived_geom_idx ON farm.derived_signal USING GIST (geom);

-- ---- farm.alert -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.alert (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id             UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id             UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  derived_signal_id   UUID REFERENCES farm.derived_signal(id) ON DELETE SET NULL,
  severity            TEXT NOT NULL,                    -- critical|high|medium|low
  category            TEXT NOT NULL,                    -- irrigation-failure|flooding|disease-hotspot|...
  title               TEXT NOT NULL,
  summary             TEXT,
  evidence            JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{signal,value},...]
  confidence          NUMERIC,
  estimated_impact    JSONB NOT NULL DEFAULT '{}'::jsonb,    -- yieldLossPctIfIgnored, revenueAtRiskUsd
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  channels            TEXT[] NOT NULL DEFAULT '{}',          -- email|sms|push|webhook|slack
  status              TEXT NOT NULL DEFAULT 'open',          -- open|ack|resolved|suppressed
  dedup_key           TEXT,                                  -- so replays don't double-fire
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS farm_alert_farm_idx ON farm.alert (tenant_id, farm_id, created_at DESC);

COMMENT ON TABLE farm.alert IS
  'Operator-facing event with severity, evidence chain, estimated financial '
  'impact and recommended actions. dedup_key prevents replay double-fire.';
