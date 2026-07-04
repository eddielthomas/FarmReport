-- =============================================================================
-- 005_iam_teams.sql — tenant teams + memberships
-- -----------------------------------------------------------------------------
-- iam.team is a logical grouping of users inside a tenant (e.g. "Field Ops",
-- "Sales", "Support"). iam.team_member joins users to teams. Used by the
-- operations dashboard to show workload-by-team and by the assignment picker
-- to filter assignees.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.team (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS iam.team_member (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES iam.team(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',  -- member | lead
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_tenant_idx        ON iam.team        (tenant_id);
CREATE INDEX IF NOT EXISTS team_member_tenant_idx ON iam.team_member (tenant_id);
CREATE INDEX IF NOT EXISTS team_member_user_idx   ON iam.team_member (user_id);

-- ---- demo seed: one team per tenant + extra users + memberships -----------
INSERT INTO iam.team (tenant_id, slug, name, description)
SELECT t.id, 'field-ops', 'Field Operations', 'Leak detection and on-site response'
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
   AND NOT EXISTS (SELECT 1 FROM iam.team x WHERE x.tenant_id = t.id AND x.slug = 'field-ops');

INSERT INTO iam.team (tenant_id, slug, name, description)
SELECT t.id, 'sales', 'Sales', 'Pipeline and customer acquisition'
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
   AND NOT EXISTS (SELECT 1 FROM iam.team x WHERE x.tenant_id = t.id AND x.slug = 'sales');

-- Extra users per tenant so dashboards have someone to assign to.
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id,
       'ops-' || t.slug || '@' || t.slug || '.local',
       'Ops Lead (' || t.display_name || ')',
       ARRAY['ops:manage','dashboard:view']::TEXT[]
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
ON CONFLICT (tenant_id, email) DO NOTHING;

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id,
       'sales-' || t.slug || '@' || t.slug || '.local',
       'Sales Lead (' || t.display_name || ')',
       ARRAY['sales:manage','analytics:view','dashboard:view']::TEXT[]
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
ON CONFLICT (tenant_id, email) DO NOTHING;

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id,
       'customer-' || t.slug || '@example.com',
       'Demo Customer (' || t.display_name || ')',
       ARRAY['customer:view']::TEXT[]
  FROM iam.tenant t
 WHERE t.slug IN ('demoville-a','acme-water')
ON CONFLICT (tenant_id, email) DO NOTHING;

-- Wire memberships: ops lead → field-ops, sales lead → sales.
INSERT INTO iam.team_member (tenant_id, team_id, user_id, role)
SELECT u.tenant_id, tm.id, u.id, 'lead'
  FROM iam.user_profile u
  JOIN iam.team tm ON tm.tenant_id = u.tenant_id
 WHERE u.email LIKE 'ops-%' AND tm.slug = 'field-ops'
ON CONFLICT (team_id, user_id) DO NOTHING;

INSERT INTO iam.team_member (tenant_id, team_id, user_id, role)
SELECT u.tenant_id, tm.id, u.id, 'lead'
  FROM iam.user_profile u
  JOIN iam.team tm ON tm.tenant_id = u.tenant_id
 WHERE u.email LIKE 'sales-%' AND tm.slug = 'sales'
ON CONFLICT (team_id, user_id) DO NOTHING;
