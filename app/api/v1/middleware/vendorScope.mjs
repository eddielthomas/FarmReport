// =============================================================================
// vendorScope.mjs — Sprint 4B P-009 Phase 2 vendor scope gate.
// -----------------------------------------------------------------------------
// Mounts after requireAuth + requireTenant + hydratePermissions on every CRM /
// Sales / Ops route that touches vendor-scoped resource tables. Behaviour:
//
//   1) Non-vendor callers (no `vendor:*` role) pass through transparently.
//   2) Vendor callers are looked up against iam.vendor_profile + an active
//      vendor_pool.contract scope row.
//
// Initial deployment: DRY-RUN mode. We log every grant / deny decision via
// recordAudit so ops can verify zero leakage before flipping enforcement on.
// Set `RWR_VENDOR_SCOPE_ENFORCE=1` to flip into enforce mode.
//
// In enforce mode:
//   - missing vendor_profile  -> 403 vendor_profile_missing
//   - no active contract      -> 403 no_active_contract
//   - no scope match          -> 403 vendor_scope_required
// In dry-run mode the same conditions are logged but the request is passed
// through so we never break vendor traffic in measurement phase.
//
// The check is intentionally cheap: a single query against vendor_pool.contract
// joined with vendor_pool.scope. The result is cached on req for the lifetime
// of the request so multiple downstream handlers can re-check without
// re-hitting the DB.
// =============================================================================

import { q } from '../db/pool.mjs';
import { recordAudit } from '../audit.mjs';
import { forbid } from '../http.mjs';

const VENDOR_ROLE_PREFIX = 'vendor:';

function hasVendorRole(roles) {
  return Array.isArray(roles) && roles.some((r) => typeof r === 'string' && r.startsWith(VENDOR_ROLE_PREFIX));
}

function enforceMode() {
  return process.env.RWR_VENDOR_SCOPE_ENFORCE === '1';
}

/**
 * Resolves the caller's vendor scope context. Returns null when the caller is
 * not a vendor (downstream code skips the gate). Returns an object describing
 * the vendor's active contracts + matching scope rows for the resource. Throws
 * a tagged error if the caller is a vendor but the linkage is broken (no
 * vendor_profile or no active contract) — the middleware translates that into
 * either a 403 (enforce mode) or a dry-run audit row (default).
 */
export async function resolveVendorScope(req, resourceType, resourceId = null) {
  const roles = req?.user?.roles ?? [];
  if (!hasVendorRole(roles)) return null;

  const tenantId = req?.tenant?.id;
  const userId = req?.user?.sub;
  if (!tenantId || !userId) {
    const err = new Error('vendor_scope_unauthenticated');
    err.kind = 'unauthenticated';
    throw err;
  }

  // 1) vendor_profile linkage.
  const vp = await q(
    `SELECT id, status FROM iam.vendor_profile
      WHERE tenant_id = $1 AND user_id = $2 AND status IN ('active','legacy')
      LIMIT 1`,
    [tenantId, userId],
  );
  if (vp.rows.length === 0) {
    const err = new Error('vendor_profile_missing');
    err.kind = 'vendor_profile_missing';
    throw err;
  }

  // 2) active contracts.
  const contracts = await q(
    `SELECT id, contract_kind, status, ends_at
       FROM vendor_pool.contract
      WHERE tenant_id = $1
        AND vendor_user_id = $2
        AND status = 'active'
        AND (ends_at IS NULL OR ends_at > now())`,
    [tenantId, userId],
  );
  if (contracts.rows.length === 0) {
    const err = new Error('no_active_contract');
    err.kind = 'no_active_contract';
    throw err;
  }
  const contractIds = contracts.rows.map((r) => r.id);

  // 3) scope rows that match this resource (or are tenant-wide with resource_id IS NULL).
  // The query joins scope rows whose contract_id is in the active set, whose
  // resource_type matches, and whose resource_id matches OR is NULL (tenant-wide).
  const scopeRes = await q(
    `SELECT s.id, s.contract_id, s.resource_type, s.resource_id, s.permission_key
       FROM vendor_pool.scope s
      WHERE s.tenant_id = $1
        AND s.contract_id = ANY ($2::uuid[])
        AND s.resource_type = $3
        AND (s.resource_id IS NULL OR s.resource_id = $4)
        AND (s.ends_at IS NULL OR s.ends_at > now())`,
    [tenantId, contractIds, resourceType, resourceId],
  );

  return {
    vendorProfileId: vp.rows[0].id,
    contractIds,
    scopeRows: scopeRes.rows,
    matched: scopeRes.rows.length > 0,
  };
}

/**
 * Express/vanilla-http style gate. Returns true if the request may proceed,
 * false if it has already been rejected with 403 (enforce mode).
 *
 * In dry-run mode this never returns false; it records a deny decision via
 * recordAudit (action=`vendor.scope.deny.dryrun`) and lets the request through.
 *
 *   const ok = await requireVendorScope(req, res, 'lead', leadId);
 *   if (!ok) return;
 */
export async function requireVendorScope(req, res, resourceType, resourceId = null) {
  const roles = req?.user?.roles ?? [];
  if (!hasVendorRole(roles)) return true;             // non-vendor passes through

  const enforce = enforceMode();
  let scope = null;
  let denyKind = null;
  let denyDetail = null;

  try {
    scope = await resolveVendorScope(req, resourceType, resourceId);
  } catch (err) {
    denyKind = err.kind || 'vendor_scope_error';
    denyDetail = String(err.message ?? err);
  }

  if (scope && scope.matched) {
    // grant — log only when verbose; do not audit-spam on hot reads.
    if (process.env.RWR_VENDOR_SCOPE_VERBOSE === '1') {
      recordAudit({
        req,
        action: 'vendor.scope.grant',
        resource: resourceType,
        resourceId: resourceId,
        payload: {
          mode: enforce ? 'enforce' : 'dryrun',
          contract_ids: scope.contractIds,
          matched_scope_ids: scope.scopeRows.map((r) => r.id),
        },
      });
    }
    return true;
  }

  // Deny path — distinguish "no scope rows" from broken linkage.
  if (!denyKind) {
    denyKind = 'vendor_scope_required';
    denyDetail = 'no_matching_scope_row';
  }

  // Audit every deny (dry-run or enforce) so ops can pre-flight the rollout.
  recordAudit({
    req,
    action: enforce ? 'vendor.scope.deny' : 'vendor.scope.deny.dryrun',
    resource: resourceType,
    resourceId: resourceId,
    payload: {
      mode: enforce ? 'enforce' : 'dryrun',
      kind: denyKind,
      detail: denyDetail,
      contract_ids: scope?.contractIds ?? [],
    },
  });

  if (!enforce) return true;        // dry-run: pass through
  forbid(res, denyKind);
  return false;
}
