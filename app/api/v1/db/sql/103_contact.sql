-- =============================================================================
-- 103_contact.sql — public contact form submissions + newsletter subscribers.
-- -----------------------------------------------------------------------------
-- These tables are platform-global (no tenant_id) because they capture inbound
-- traffic *before* a tenant relationship exists. They are exempt from the
-- audit-tenant-id check.
-- =============================================================================

-- Inbound contact form submissions.
CREATE TABLE IF NOT EXISTS public.contact_submission (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT NOT NULL,
  company         TEXT NOT NULL,
  industry        TEXT,
  mission_line    TEXT,
  message         TEXT NOT NULL,
  newsletter      BOOLEAN NOT NULL DEFAULT false,
  source          TEXT NOT NULL DEFAULT 'contact_page',
  ip              INET,
  user_agent      TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','triaged','responded','closed','spam')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_submission_created_idx
  ON public.contact_submission (created_at DESC);

CREATE INDEX IF NOT EXISTS contact_submission_email_idx
  ON public.contact_submission (lower(email));

-- Newsletter subscribers — double-opt-in.
CREATE TABLE IF NOT EXISTS public.newsletter_subscriber (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  first_name      TEXT,
  confirm_token   TEXT,
  confirmed_at    TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'contact_page',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS newsletter_subscriber_email_idx
  ON public.newsletter_subscriber (lower(email));
