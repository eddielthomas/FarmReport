// =============================================================================
// /api/v1/iam/vendors — Sprint 4B P-009 Phase 3 vendor admin surface.
// -----------------------------------------------------------------------------
// Endpoints:
//   GET  /iam/vendors                                  — list vendor profiles
//   POST /iam/vendors/:user_id/apply-template          — apply template to vendor
//
// AuthZ: `iam.users.manage` (tenant.admin / platform.admin).
//
// apply-template walks iam.permission_template -> resolves the matching role
// id from iam.role (system row, tenant_id IS NULL) -> grants the role via
// iam.user_role -> inserts a vendor_pool.scope row per permission_key against
// the supplied active contract. Idempotent: re-applying the same template is
// a no-op via ON CONFLICT DO NOTHING.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission, invalidatePermissions } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Permission keys -> canonical role keys. We map the high-water-mark role for
// each template so applying e.g. sales_partner grants `vendor:view` (legacy)
// and `vendor:manage` if any write permission appears in the template. Kept
// simple here; finer-grained mapping is a Phase 4 follow-up.
function roleKeysForTemplate(template) {
  const perms = Array.isArray(template.permissions) ? template.permissions : [];
  const out = new Set(['vendor.viewer']);   // canonical key in iam.role
  const hasWrite = perms.some((p) => p.endsWith('.write') || p === 'cases.manage');
  if (hasWrite) out.add('vendor.manager');  // tenant admins may have minted this
  return [...out];
}

// ---- list -------------------------------------------------------------------
export async function list(req, res) {
  if (!requirePermission(req, res, 'iam.users.read')) return;
  const { rows } = await q(
    `SELECT vp.id, vp.tenant_id, vp.user_id, vp.category, vp.status,
            vp.company_name, vp.primary_contact_email, vp.mfa_required,
            vp.created_at, vp.updated_at,
            up.email AS user_email, up.display_name
       FROM iam.vendor_profile vp
       JOIN iam.user_profile up ON up.id = vp.user_id
      WHERE vp.tenant_id = $1
      ORDER BY vp.created_at DESC
      LIMIT 500`,
    [req.tenant.id],
  );
  ok(res, rows);
}

// ---- apply-template --------------------------------------------------------
export async function applyTemplate(req, res, userId) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(userId)) return badReq(res, 'invalid_user_id');
  const body = (await readBody(req)) || {};
  const templateKey = String(body.template_key ?? '').trim();
  const contractId  = String(body.contract_id ?? '').trim();
  if (!templateKey) return badReq(res, 'template_key_required');
  if (!UUID_RE.test(contractId)) return badReq(res, 'invalid_contract_id');

  // Look up template + vendor profile + contract in parallel.
  const [tplRes, vpRes, cRes] = await Promise.all([
    q(`SELECT id, key, name, contract_kind, permissions, default_scope
         FROM iam.permission_template WHERE key = $1 LIMIT 1`, [templateKey]),
    q(`SELECT id, status FROM iam.vendor_profile
        WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [req.tenant.id, userId]),
    q(`SELECT id, contract_kind, status, vendor_user_id FROM vendor_pool.contract
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [req.tenant.id, contractId]),
  ]);
  if (tplRes.rows.length === 0) return badReq(res, 'unknown_template');
  if (vpRes.rows.length  === 0) return badReq(res, 'vendor_profile_missing');
  if (cRes.rows.length   === 0) return notFound(res);

  const tpl      = tplRes.rows[0];
  const contract = cRes.rows[0];
  if (contract.vendor_user_id !== userId) return badReq(res, 'contract_vendor_mismatch');
  if (contract.contract_kind  !== tpl.contract_kind) return badReq(res, 'contract_kind_mismatch');
  if (contract.status !== 'active') return badReq(res, 'contract_not_active');

  const permKeys = Array.isArray(tpl.permissions)
    ? tpl.permissions
    : JSON.parse(tpl.permissions || '[]');

  const roleKeys = roleKeysForTemplate({ permissions: permKeys });

  const result = await withTx(async (client) => {
    // 1) grant the canonical role(s) — INSERT ... ON CONFLICT DO NOTHING.
    const granted = [];
    for (const roleKey of roleKeys) {
      const r = await client.query(
        `SELECT id FROM iam.role WHERE key = $1 AND tenant_id IS NULL LIMIT 1`,
        [roleKey],
      );
      if (r.rows.length === 0) continue;       // role not seeded yet — skip
      await client.query(
        `INSERT INTO iam.user_role (user_id, role_id, granted_by, granted_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, r.rows[0].id, req.user?.sub ?? null],
      );
      granted.push({ role_key: roleKey, role_id: r.rows[0].id });
    }

    // 2) insert one vendor_pool.scope row per permission_key (tenant-wide).
    const scopeIds = [];
    for (const pk of permKeys) {
      const ins = await client.query(
        `INSERT INTO vendor_pool.scope
           (tenant_id, contract_id, resource_type, resource_id,
            permission_key, starts_at, ends_at)
         VALUES ($1, $2, $3, NULL, $4, now(), NULL)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [req.tenant.id, contractId, deriveResourceType(pk), pk],
      );
      if (ins.rows[0]) scopeIds.push(ins.rows[0].id);
    }

    // 3) record a single contract_event for the template apply.
    await client.query(
      `INSERT INTO vendor_pool.contract_event
         (tenant_id, contract_id, event_kind, payload, actor_id)
       VALUES ($1, $2, 'template_applied', $3::jsonb, $4)`,
      [req.tenant.id, contractId,
       JSON.stringify({ template_key: templateKey, permissions: permKeys, scope_ids: scopeIds }),
       req.user?.sub ?? null],
    );

    return { granted_roles: granted, scope_ids: scopeIds };
  });

  invalidatePermissions(userId);
  recordAudit({
    req,
    action: 'iam.vendor.apply_template',
    resource: 'iam.vendor_profile',
    resourceId: userId,
    payload: { after: { template_key: templateKey, contract_id: contractId, ...result } },
  });
  ok(res, { user_id: userId, contract_id: contractId, template_key: templateKey, ...result });
}

// Map permission_key prefix -> resource_type label used by vendor_pool.scope.
// The middleware (vendorScope.mjs) uses the same labels to gate access.
function deriveResourceType(permissionKey) {
  if (permissionKey.startsWith('crm.lead.'))         return 'lead';
  if (permissionKey.startsWith('crm.contact.'))      return 'contact';
  if (permissionKey.startsWith('crm.organization.')) return 'organization';
  if (permissionKey.startsWith('crm.opportunity.'))  return 'opportunity';
  if (permissionKey.startsWith('crm.client.'))       return 'client';
  if (permissionKey.startsWith('cases.'))            return 'case';
  return permissionKey.split('.')[0] || 'unknown';
}
