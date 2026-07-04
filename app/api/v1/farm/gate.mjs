// =============================================================================
// farm/gate.mjs — farm-domain permission gate (mirrors index.mjs gateOrRole).
// -----------------------------------------------------------------------------
// The farm surface must honor BOTH the modern dot-form permission keys hydrated
// by policy.mjs (farm.profile.read, farm.report.generate, …) AND the colon-form
// legacy prefix roles seeded in 211_farm_rbac_seed / carried on user_profile
// .roles[] (farm:view, farm:onboard, alert:manage, report:generate). This helper
// is the gateOrRole pattern expressed once so every farm handler can stay
// self-contained (like the crm/* modules) while still accepting legacy callers.
//
// Passes when the caller holds the required dot-perm, is a platform admin, or
// carries any of the supplied legacy roles. Writes 403 + returns false on miss.
// =============================================================================

import { forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

export function farmGate(req, res, perm, ...legacyRoles) {
  const perms = req.user?.permissions;
  if (perms && (perms.has('platform.admin.all') || perms.has(perm))) return true;

  const roles = req.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  for (const r of legacyRoles) if (roles.includes(r)) return true;

  try {
    recordAudit({
      req, action: 'authz.denied', resource: 'iam.permission', resourceId: null,
      payload: { required: perm, legacy_fallbacks: legacyRoles, role_keys: req.user?.roleKeys ?? [] },
    });
  } catch (_e) { /* audit best-effort */ }

  forbid(res, 'missing_permission:' + perm);
  return false;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
