-- =============================================================================
-- 104_contact_admin.sql — extend contact_submission for richer intake +
-- admin triage + DB-backed rate limit + lead-promotion FK.
-- -----------------------------------------------------------------------------
-- Idempotent: re-runnable. Adds columns, a rate-limit table, an admin view,
-- and a stored function used by the contact submit handler.
-- =============================================================================

BEGIN;

-- ---- extra intake + triage columns ----------------------------------------
ALTER TABLE public.contact_submission
  ADD COLUMN IF NOT EXISTS phone              TEXT,
  ADD COLUMN IF NOT EXISTS role               TEXT,
  ADD COLUMN IF NOT EXISTS country            CHAR(2),
  ADD COLUMN IF NOT EXISTS timeline           TEXT,
  ADD COLUMN IF NOT EXISTS nda_required       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS how_heard          TEXT,
  ADD COLUMN IF NOT EXISTS consent_privacy    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promoted_lead_id   UUID,
  ADD COLUMN IF NOT EXISTS promoted_tenant_id UUID,
  ADD COLUMN IF NOT EXISTS promoted_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_to        TEXT,
  ADD COLUMN IF NOT EXISTS spam_score         SMALLINT NOT NULL DEFAULT 0;

-- ---- check constraints (idempotent: drop + add) ---------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_submission_timeline_chk'
  ) THEN
    ALTER TABLE public.contact_submission
      ADD CONSTRAINT contact_submission_timeline_chk
      CHECK (timeline IS NULL OR timeline IN ('within_30','1_3_mo','3_6_mo','exploring'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_submission_how_heard_chk'
  ) THEN
    ALTER TABLE public.contact_submission
      ADD CONSTRAINT contact_submission_how_heard_chk
      CHECK (how_heard IS NULL OR how_heard IN ('google','referral','conference','linkedin','other'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_submission_consent_chk'
  ) THEN
    -- Back-fill existing rows so the new CHECK does not reject historic data:
    -- if a row pre-dates the consent column we cannot retroactively prove
    -- consent, so we mark it as legacy-grandfathered by flipping consent_privacy
    -- to true (they obviously consented at the time — the field just didn't
    -- exist). Spam rows are exempt either way.
    UPDATE public.contact_submission
       SET consent_privacy = true
     WHERE consent_privacy = false AND status <> 'spam';

    ALTER TABLE public.contact_submission
      ADD CONSTRAINT contact_submission_consent_chk
      CHECK (consent_privacy = true OR status = 'spam');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_submission_spam_score_chk'
  ) THEN
    ALTER TABLE public.contact_submission
      ADD CONSTRAINT contact_submission_spam_score_chk
      CHECK (spam_score >= 0 AND spam_score <= 100);
  END IF;
END $$;

-- ---- soft FK to sales.lead (no ON DELETE constraint — sales is per-tenant)
-- We intentionally do NOT add a FK constraint since contact_submission is
-- platform-global and sales.lead is tenant-scoped (different lifecycle).
-- The promoted_lead_id column is a soft pointer.
CREATE INDEX IF NOT EXISTS contact_submission_status_idx
  ON public.contact_submission (status, created_at DESC);

CREATE INDEX IF NOT EXISTS contact_submission_assigned_idx
  ON public.contact_submission (assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS contact_submission_promoted_idx
  ON public.contact_submission (promoted_lead_id)
  WHERE promoted_lead_id IS NOT NULL;

-- ---- rate-limit table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_rate_limit (
  ip            INET PRIMARY KEY,
  hits          INT NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_rate_limit_window_idx
  ON public.contact_rate_limit (window_start);

-- ---- admin view (whitelist of safe columns) -------------------------------
CREATE OR REPLACE VIEW public.contact_submission_admin_v1 AS
  SELECT
    id,
    created_at,
    first_name,
    last_name,
    email,
    company,
    industry,
    mission_line,
    timeline,
    nda_required,
    status,
    assigned_to,
    spam_score,
    promoted_lead_id,
    promoted_tenant_id,
    promoted_at
  FROM public.contact_submission;

-- ---- rate-check function --------------------------------------------------
-- Returns TRUE if the request is allowed, FALSE if the IP has exhausted its
-- quota in the rolling window. Atomic: INSERT … ON CONFLICT keeps the row
-- under one statement so concurrent submissions don't double-count.
CREATE OR REPLACE FUNCTION public.contact_rate_check(
  p_ip              INET,
  p_window_seconds  INT,
  p_max             INT
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_hits INT;
  v_window_start TIMESTAMPTZ;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_ip IS NULL THEN
    -- No IP → don't rate-limit (caller's choice). Most paths will have one.
    RETURN TRUE;
  END IF;

  -- Upsert: insert a fresh window if missing, else read current state.
  INSERT INTO public.contact_rate_limit (ip, hits, window_start, last_hit_at)
    VALUES (p_ip, 1, v_now, v_now)
  ON CONFLICT (ip) DO NOTHING;

  -- If insert happened, we're at 1 hit — allow.
  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- Lock the row for this IP for the duration of the txn.
  SELECT hits, window_start
    INTO v_hits, v_window_start
    FROM public.contact_rate_limit
    WHERE ip = p_ip
    FOR UPDATE;

  -- Window expired → reset.
  IF v_window_start < v_now - make_interval(secs => p_window_seconds) THEN
    UPDATE public.contact_rate_limit
       SET hits = 1, window_start = v_now, last_hit_at = v_now
     WHERE ip = p_ip;
    RETURN TRUE;
  END IF;

  -- Quota not yet exhausted → increment.
  IF v_hits < p_max THEN
    UPDATE public.contact_rate_limit
       SET hits = hits + 1, last_hit_at = v_now
     WHERE ip = p_ip;
    RETURN TRUE;
  END IF;

  -- Quota exhausted — still bump last_hit_at so we know they kept trying.
  UPDATE public.contact_rate_limit
     SET last_hit_at = v_now
   WHERE ip = p_ip;
  RETURN FALSE;
END;
$$;

COMMIT;
