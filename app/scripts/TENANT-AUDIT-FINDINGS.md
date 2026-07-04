# Tenant Isolation Schema Audit — Findings

**Play A · Prove 100% data segmentation across the multi-tenant schema**

- Audit script: `mvp/scripts/audit-tenant-id.mjs`
- Scanned directory: `mvp/api/v1/db/sql/*.sql`
- Migration files audited (lex-sorted):
  - `001_iam.sql`
  - `002_sales.sql`
  - `003_ops.sql`
  - `004_ai.sql`
  - `005_iam_teams.sql`
  - `099_seed_demo.sql` (seed only — no CREATE TABLE)
  - `100_demo_accounts.sql` (seed only — no CREATE TABLE)

## Result

```
17 tables audited · 17 passed · 0 violations
```

Exit code: `0`. All tenant-scoped tables satisfy the four isolation rules.
No SQL changes required.

## Per-table verdict

| # | Table | Verdict | Notes |
|---|-------|---------|-------|
| 1 | `iam.tenant` | PASS (exempt) | Tenant root. |
| 2 | `iam.user_profile` | PASS | UUID NOT NULL FK + index `user_profile_tenant_idx`. |
| 3 | `iam.team` | PASS | UUID NOT NULL FK + index `team_tenant_idx`. |
| 4 | `iam.team_member` | PASS (exempt) | Join table; tenancy enforced via `team_id -> iam.team(tenant_id)`. Column `tenant_id` and index `team_member_tenant_idx` are also present as a belt-and-braces measure. |
| 5 | `sales.lead` | PASS | Two composite indexes lead with `tenant_id`. |
| 6 | `sales.opportunity` | PASS | `opportunity_tenant_stage_idx (tenant_id, stage)`. |
| 7 | `sales.note` | PASS | `note_lead_idx (tenant_id, lead_id, created_at DESC)`. |
| 8 | `sales.meeting` | PASS | `meeting_tenant_start_idx (tenant_id, start_at)`. |
| 9 | `sales.message` | PASS | `message_lead_idx (tenant_id, lead_id, created_at)`. |
| 10 | `sales.file` | PASS | `file_lead_idx (tenant_id, lead_id)`. |
| 11 | `sales.product` | PASS | `product_tenant_idx (tenant_id, active)`. |
| 12 | `sales.status_history` | PASS | `status_history_lead_idx (tenant_id, lead_id, changed_at DESC)`. |
| 13 | `ops.case` | PASS | Two composite indexes lead with `tenant_id`. |
| 14 | `ops.case_assignment` | PASS | `case_assignment_case_idx (tenant_id, case_id)`. |
| 15 | `ops.case_activity` | PASS | `case_activity_case_idx (tenant_id, case_id, created_at DESC)`. |
| 16 | `ops.case_attachment` | PASS | `case_attachment_case_idx (tenant_id, case_id)`. |
| 17 | `ai.agent_run` | PASS | `agent_run_tenant_idx (tenant_id, started_at DESC)`. |

## Violations

None.

## Exempt list (documented)

The following tables are deliberately excluded from the `tenant_id`
requirement; the audit treats them as PASS with the `(exempt)` annotation:

- `iam.tenant` — the tenant root. It IS the tenancy boundary.
- `public._migrations` — platform-global migration ledger (not yet created as a
  CREATE TABLE in `mvp/api/v1/db/sql/`; reserved as exempt for when it lands).
- `iam.team_member` — join table. Each row is reachable only via a parent
  `iam.team` row that is itself tenant-scoped (`ON DELETE CASCADE` from
  `iam.team(id)`, which cascades from `iam.tenant(id)`). The current schema
  additionally carries `tenant_id` on this table as defence-in-depth, but the
  exemption stands so future join-only tables don't get blocked by the audit.

## Verbatim audit run

```
PASS iam.tenant (exempt)
PASS iam.user_profile
PASS sales.lead
PASS sales.opportunity
PASS sales.note
PASS sales.meeting
PASS sales.message
PASS sales.file
PASS sales.product
PASS sales.status_history
PASS ops.case
PASS ops.case_assignment
PASS ops.case_activity
PASS ops.case_attachment
PASS ai.agent_run
PASS iam.team
PASS iam.team_member (exempt)

17 tables audited · 17 passed · 0 violations
```

## Recommended fixes

None — schema is clean. If a future migration introduces a tenant-scoped table
that fails the audit, the next available migration slot is **`006_*.sql`**
(highest existing numbered migration before seeds is `005_iam_teams.sql`; seed
files `099_*` and `100_*` are reserved for seed data only).

A future violation would be fixed with the following template (drop into the
new `006_*.sql`):

```sql
-- Add tenant_id column if missing.
ALTER TABLE <schema>.<table>
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfill from the parent relation (replace <parent_id> with the real FK col).
UPDATE <schema>.<table> t
   SET tenant_id = p.tenant_id
  FROM <parent_schema>.<parent_table> p
 WHERE p.id = t.<parent_id>
   AND t.tenant_id IS NULL;

-- Enforce NOT NULL and the FK.
ALTER TABLE <schema>.<table>
  ALTER COLUMN tenant_id SET NOT NULL,
  ADD CONSTRAINT <table>_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES iam.tenant(id) ON DELETE CASCADE;

-- Tenant-leading index.
CREATE INDEX IF NOT EXISTS <table>_tenant_idx
  ON <schema>.<table> (tenant_id);
```

## How to reproduce

```bash
node mvp/scripts/audit-tenant-id.mjs
```

- Exit code `0` only when all-green.
- Exit code `1` if any non-exempt table fails any of the four rules.
- Pure ESM, zero dependencies — runs on any Node 18+ install.
- Idempotent: two consecutive runs produce byte-identical output.
