-- =============================================================================
-- 112_audit_immutable.sql — iam.audit_event is append-only
-- -----------------------------------------------------------------------------
-- Defense-in-depth: revoke UPDATE/DELETE at grant level AND install a BEFORE
-- trigger that raises 'audit_event_immutable'. This blocks even superusers
-- inside a stored procedure path (the trigger fires regardless of grants).
--
-- Partitioning is deferred to Phase 2 (calendar-month range partition on
-- created_at) — see crm-plan-audit.md.
--
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

REVOKE UPDATE, DELETE ON iam.audit_event FROM PUBLIC;

-- Best-effort revoke from a named app role if it exists. The role is created
-- by ops; the DO block silently skips if absent so dev DBs without the role
-- still apply this migration cleanly.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rwr_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON iam.audit_event FROM rwr_app';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION iam.fn_audit_event_immutable_guard()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_event_immutable: % denied on iam.audit_event', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_event_guard ON iam.audit_event;
CREATE TRIGGER trg_audit_event_guard
  BEFORE UPDATE OR DELETE ON iam.audit_event
  FOR EACH ROW EXECUTE FUNCTION iam.fn_audit_event_immutable_guard();

COMMENT ON TABLE iam.audit_event IS
  'append-only — REVOKE UPDATE/DELETE + trigger; modifications raise audit_event_immutable';
