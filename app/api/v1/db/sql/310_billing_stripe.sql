-- =============================================================================
-- 310_billing_stripe.sql — Stripe billing: customers, subscriptions, invoices.
-- -----------------------------------------------------------------------------
-- Stripe is the source of truth; these tables MIRROR the objects we need to
-- render the account/billing UI without a round-trip, and give us a local join
-- key (tenant_id ↔ stripe_customer_id). Kept in the existing `billing` schema
-- (125_billing_stream.sql) with the same tenant-isolation RLS pattern.
--   billing.customer       tenant ↔ Stripe Customer (one per buyer tenant)
--   billing.subscription   mirror of the tenant's Stripe Subscription
--   billing.invoice        mirror of the tenant's Stripe Invoices
--   billing.webhook_event  idempotency log (global — webhooks have no session)
-- Plan definitions (Starter/Growth/Enterprise → Stripe Price IDs) live in code
-- (api/v1/billing/plans.mjs), not a table, so they track env config.
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS billing;

-- ---- billing.customer -------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.customer (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  email              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (stripe_customer_id)
);

-- ---- billing.subscription ---------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.subscription (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_price_id        TEXT,
  plan_key               TEXT,                     -- 'starter' | 'growth' | 'enterprise'
  status                 TEXT NOT NULL DEFAULT 'incomplete', -- Stripe sub status
  quantity               INTEGER NOT NULL DEFAULT 1,
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at            TIMESTAMPTZ,
  trial_end              TIMESTAMPTZ,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id)
);
CREATE INDEX IF NOT EXISTS billing_sub_tenant_idx ON billing.subscription (tenant_id, created_at DESC);

-- ---- billing.invoice --------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing.invoice (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  stripe_invoice_id   TEXT NOT NULL,
  stripe_customer_id  TEXT,
  number              TEXT,
  status              TEXT,          -- draft|open|paid|void|uncollectible
  amount_due          BIGINT,        -- minor units (cents)
  amount_paid         BIGINT,
  currency            TEXT NOT NULL DEFAULT 'usd',
  hosted_invoice_url  TEXT,
  invoice_pdf         TEXT,
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_invoice_id)
);
CREATE INDEX IF NOT EXISTS billing_invoice_tenant_idx ON billing.invoice (tenant_id, created_at DESC);

-- ---- billing.webhook_event (idempotency; GLOBAL, no tenant session) ---------
CREATE TABLE IF NOT EXISTS billing.webhook_event (
  stripe_event_id  TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled          BOOLEAN NOT NULL DEFAULT FALSE,
  error            TEXT
);

-- ---- RLS (tenant isolation on the three tenant-scoped tables) ---------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer','subscription','invoice'] LOOP
    EXECUTE format('ALTER TABLE billing.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname='billing' AND tablename=t
        AND policyname = t || '_tenant_iso'
    ) THEN
      EXECUTE format($POL$
        CREATE POLICY %I ON billing.%I
          USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
          WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
      $POL$, t || '_tenant_iso', t);
    END IF;
  END LOOP;
END $$;
-- billing.webhook_event is intentionally NOT row-level-secured: Stripe webhooks
-- arrive with no tenant session and are written by the platform role.

COMMIT;
