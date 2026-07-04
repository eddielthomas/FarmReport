// =============================================================================
// iam/orgs.mjs — Sprint A5.1 (ADR-0024) org-tier resolution + endpoints.
// -----------------------------------------------------------------------------
// The org tier sits ABOVE tenants. A user holds per-tenant roles in one or more
// districts (tenants) plus, optionally, org-tier roles on the parent org. This
// module:
//   * resolveOrgContextForTenant(userId, tenantId) — the org claim block
//     ({ org_id, org_slug, org_roles[], org_permissions[] }) for the org that
//     OWNS the active tenant, or null when the tenant has no org (back-compat:
//     org_id IS NULL ⇒ no org claim ⇒ byte-identical to today).
//   * listMyOrgs(req, res) — GET /iam/my-orgs: the caller's orgs and, per org,
//     the districts (tenants) they can act in (their tenant memberships).
//
// Pure reads — no DML, so no recordAudit() is required (audit:coverage only
// gates mutators).
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok } from '../http.mjs';

// Resolve the org context for the org that owns `tenantId`, scoped to the
// org-tier roles `userId` holds on that org. Returns null when:
//   * the tenant has no org_id (standalone tenant — back-compat), OR
//   * the user holds no org-tier role on that org.
// In both cases the caller mints/hydrates WITHOUT an org claim, preserving the
// exact pre-A5.1 token + request shape.
export async function resolveOrgContextForTenant(userId, tenantId) {
  if (!userId || !tenantId) return null;

  // 1) Which org (if any) owns this tenant?
  const { rows: orgRows } = await q(
    `SELECT o.id AS org_id, o.slug AS org_slug, o.display_name, o.billing_mode
       FROM iam.tenant t
       JOIN iam.org o ON o.id = t.org_id
      WHERE t.id = $1
      LIMIT 1`,
    [tenantId],
  );
  if (orgRows.length === 0) return null; // org_id IS NULL → no org claim
  const org = orgRows[0];

  // 2) Which org-tier roles does this user hold on that org?
  const { rows: roleRows } = await q(
    `SELECT org_role_key
       FROM iam.org_user_role
      WHERE org_id = $1 AND user_ref = $2`,
    [org.org_id, userId],
  );
  const orgRoles = roleRows.map((r) => r.org_role_key);
  if (orgRoles.length === 0) return null; // member of the district but not org-tier

  // 3) Expand org roles → org permission bundle.
  const { rows: permRows } = await q(
    `SELECT DISTINCT permission_key
       FROM iam.org_role_permission
      WHERE org_role_key = ANY($1::text[])`,
    [orgRoles],
  );
  const orgPermissions = permRows.map((r) => r.permission_key);

  return {
    org_id:          org.org_id,
    org_slug:        org.org_slug,
    org_display_name: org.display_name,
    billing_mode:    org.billing_mode,
    org_roles:       orgRoles,
    org_permissions: orgPermissions,
  };
}

// GET /iam/my-orgs — the caller's orgs and, per org, the districts (tenants)
// they can act in (their tenant memberships within that org). Read-only.
export async function listMyOrgs(req, res) {
  const userId = req.user?.sub;
  const email  = req.user?.email ?? null;

  // The caller's org memberships (org-tier roles they hold).
  const { rows: orgRows } = await q(
    `SELECT o.id AS org_id, o.slug, o.display_name, o.billing_mode,
            array_agg(DISTINCT our.org_role_key) AS org_roles
       FROM iam.org_user_role our
       JOIN iam.org o ON o.id = our.org_id
      WHERE our.user_ref = $1
      GROUP BY o.id, o.slug, o.display_name, o.billing_mode
      ORDER BY o.display_name`,
    [userId],
  );

  // The districts (tenants) under each org that this user is a MEMBER of.
  // Membership is by email across the org's tenants (iam.user_profile is
  // tenant-scoped, one row per (tenant,email)). This is the set the switcher
  // lets the caller switch between.
  const orgs = [];
  for (const o of orgRows) {
    const { rows: districts } = await q(
      `SELECT t.id AS tenant_id, t.slug AS tenant_slug, t.display_name,
              up.id AS user_profile_id
         FROM iam.tenant t
         JOIN iam.user_profile up
           ON up.tenant_id = t.id AND up.email = $2
        WHERE t.org_id = $1
        ORDER BY t.display_name`,
      [o.org_id, email],
    );
    orgs.push({
      org_id:       o.org_id,
      org_slug:     o.slug,
      display_name: o.display_name,
      billing_mode: o.billing_mode,
      org_roles:    (o.org_roles ?? []).filter(Boolean),
      districts:    districts.map((d) => ({
        tenant_id:    d.tenant_id,
        tenant_slug:  d.tenant_slug,
        display_name: d.display_name,
      })),
    });
  }

  ok(res, { orgs });
}
