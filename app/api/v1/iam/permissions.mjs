// =============================================================================
// /api/v1/iam/permissions — catalog read (Sprint 1B / EPIC-002).
// -----------------------------------------------------------------------------
// Read-only listing of the canonical permission catalog. Gated on
// `iam.roles.read`. Filterable by ?scope_kind=.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, parseQuery } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';

export async function list(req, res) {
  if (!requirePermission(req, res, 'iam.roles.read')) return;
  const qs = parseQuery(req.url);
  const scopeKind = qs.scope_kind ? String(qs.scope_kind) : null;
  const params = [];
  let where = '';
  if (scopeKind) { params.push(scopeKind); where = ` WHERE scope_kind = $1`; }
  const { rows } = await q(
    `SELECT key, description, scope_kind, created_at
       FROM iam.permission${where}
      ORDER BY key`,
    params,
  );
  ok(res, rows);
}
