-- =============================================================================
-- 120_iam_rbac_seed.sql — Canonical permission catalog + system roles + default
-- role->permission grants + default field policies. (Sprint 1B / EPIC-002).
--
-- ON CONFLICT DO NOTHING everywhere so re-applies are no-ops.
-- =============================================================================

-- ---- 1) Permission catalog -------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('platform.admin.all',         'Bypass tenant isolation; super-admin',     'platform'),

  -- crm leads
  ('crm.lead.read',              'List/read leads in tenant',                'tenant'),
  ('crm.lead.read.assigned',     'Read only leads assigned to caller',       'resource'),
  ('crm.lead.write',             'Create/update leads',                      'tenant'),
  ('crm.lead.delete',            'Soft-delete leads',                        'tenant'),
  ('crm.lead.assign',            'Assign or reassign leads',                 'tenant'),

  -- crm contact + org + client + opp
  ('crm.contact.read',           'Read contacts',                            'tenant'),
  ('crm.contact.write',          'Create/update contacts',                   'tenant'),
  ('crm.organization.read',      'Read organizations',                       'tenant'),
  ('crm.organization.write',     'Create/update organizations',              'tenant'),
  ('crm.client.read',            'Read clients',                             'tenant'),
  ('crm.client.write',           'Create/update clients',                    'tenant'),
  ('crm.opportunity.read',       'Read opportunities',                       'tenant'),
  ('crm.opportunity.write',      'Create/update opportunities',              'tenant'),

  -- dashboards
  ('crm.dashboard.view',         'View standard CRM dashboard',              'tenant'),
  ('crm.dashboard.revenue.view', 'View revenue dashboard',                   'tenant'),

  -- chat + analytics
  ('crm.chat.read',              'Read chat threads',                        'tenant'),
  ('crm.chat.export',            'Export chat threads',                      'tenant'),
  ('crm.analytics.view',         'View analytics module',                    'tenant'),

  -- ops + cases
  ('cases.read',                 'Read cases',                               'tenant'),
  ('cases.manage',               'Create/update/assign cases',               'tenant'),

  -- iam + tenant admin
  ('iam.users.read',             'Read tenant users',                        'tenant'),
  ('iam.users.manage',           'Create/update tenant users',               'tenant'),
  ('iam.roles.read',             'Read roles',                               'tenant'),
  ('iam.roles.manage',           'Create/update roles',                      'tenant'),
  ('iam.teams.read',             'Read teams',                               'tenant'),
  ('iam.teams.manage',           'Manage teams + memberships',               'tenant'),

  -- cross-cutting visibility flags
  ('data.read.global',           'See all rows in tenant regardless assign', 'tenant'),
  ('data.read.assigned',         'See only assigned rows (default)',         'tenant'),

  -- audit
  ('audit.read',                 'Read audit log',                           'tenant'),
  ('audit.export',               'Bulk export audit log',                    'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2) System roles -------------------------------------------------------
INSERT INTO iam.role (tenant_id, key, name, description, is_system) VALUES
  (NULL, 'platform.admin',     'Platform Admin',       'Super-admin; bypasses tenant isolation', true),
  (NULL, 'tenant.admin',       'Tenant Admin',         'Manages all data within a single tenant', true),
  (NULL, 'sales.manager',      'Sales Manager',        'Sees all leads in tenant; manages assignments', true),
  (NULL, 'sales.agent',        'Sales Agent',          'Sees only assigned leads', true),
  (NULL, 'ops.manager',        'Ops Manager',          'Manages cases; assigns ops', true),
  (NULL, 'customer.support',   'Customer Support',     'Sees all rows globally; cannot mutate billing', true),
  (NULL, 'analytics.viewer',   'Analytics Viewer',     'Read-only on analytics', true),
  (NULL, 'dashboard.viewer',   'Dashboard Viewer',     'Read-only on dashboards', true),
  (NULL, 'customer.viewer',    'Customer Portal User', 'External customer self-service', true),
  (NULL, 'vendor.viewer',      'Vendor Portal User',   'External vendor with masked lead view', true),
  (NULL, 'viewer.exec',        'Executive Viewer',     'PII-masked executive read', true),
  (NULL, 'auditor',            'Auditor',              'Audit log read-only', true)
ON CONFLICT (key) WHERE tenant_id IS NULL DO NOTHING;

-- ---- 3) Role -> permission mapping -----------------------------------------
-- platform.admin: every permission
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- tenant.admin: every permission except platform.*
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
     AND p.key NOT LIKE 'platform.%'
ON CONFLICT DO NOTHING;

-- sales.manager (legacy sales:manage uplift)
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.lead.write','crm.lead.assign','crm.lead.delete',
           'crm.contact.read','crm.contact.write',
           'crm.organization.read','crm.organization.write',
           'crm.client.read','crm.client.write',
           'crm.opportunity.read','crm.opportunity.write',
           'crm.dashboard.view','crm.dashboard.revenue.view',
           'crm.chat.read','crm.chat.export',
           'crm.analytics.view','data.read.global',
           'iam.users.read','iam.teams.read'
         ]) k
   WHERE r.key = 'sales.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- sales.agent (default assignment-bounded)
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.lead.write',
           'crm.contact.read','crm.contact.write',
           'crm.organization.read',
           'crm.opportunity.read','crm.opportunity.write',
           'crm.dashboard.view','crm.chat.read',
           'data.read.assigned'
         ]) k
   WHERE r.key = 'sales.agent' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ops.manager
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'cases.read','cases.manage',
           'crm.lead.read','crm.contact.read',
           'crm.dashboard.view','data.read.global',
           'iam.teams.read'
         ]) k
   WHERE r.key = 'ops.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- customer.support
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.contact.read','crm.organization.read',
           'crm.client.read','crm.opportunity.read',
           'cases.read','cases.manage',
           'crm.chat.read','crm.dashboard.view',
           'data.read.global'
         ]) k
   WHERE r.key = 'customer.support' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- analytics.viewer
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.analytics.view','crm.dashboard.view','crm.dashboard.revenue.view'
         ]) k
   WHERE r.key = 'analytics.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- dashboard.viewer
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.dashboard.view'
         ]) k
   WHERE r.key = 'dashboard.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- customer.viewer
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.chat.read','crm.dashboard.view',
           'data.read.assigned'
         ]) k
   WHERE r.key = 'customer.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- vendor.viewer
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.dashboard.view','data.read.assigned'
         ]) k
   WHERE r.key = 'vendor.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- viewer.exec
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.lead.read','crm.contact.read',
           'crm.dashboard.view','crm.dashboard.revenue.view',
           'crm.analytics.view','data.read.global'
         ]) k
   WHERE r.key = 'viewer.exec' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- auditor
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'audit.read','audit.export'
         ]) k
   WHERE r.key = 'auditor' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) Default field-policy (PII masking) ---------------------------------
INSERT INTO iam.field_policy (role_key, resource, field, action) VALUES
  ('vendor.viewer',   'lead',    'email',           'mask'),
  ('vendor.viewer',   'lead',    'phone',           'mask'),
  ('vendor.viewer',   'lead',    'total_revenue',   'deny'),
  ('vendor.viewer',   'lead',    'address_full',    'mask'),
  ('viewer.exec',     'lead',    'email',           'mask'),
  ('viewer.exec',     'lead',    'phone',           'mask'),
  ('viewer.exec',     'contact', 'email',           'mask'),
  ('customer.viewer', 'lead',    'internal_notes',  'deny'),
  ('analytics.viewer','contact_submission','email','mask')
ON CONFLICT DO NOTHING;
