// =============================================================================
// /api/v1/sales/contacts/search — search across sales.lead by name/email/company.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, parseQuery } from '../http.mjs';

export async function search(req, res) {
  const { q: term = '', limit = '25' } = parseQuery(req.url);
  const needle = `%${String(term).toLowerCase()}%`;
  const lim = Math.min(Number(limit) || 25, 100);
  const { rows } = await q(
    `SELECT id, name, email, company, position, status
       FROM sales.lead
      WHERE tenant_id = $1
        AND (LOWER(name) LIKE $2 OR LOWER(COALESCE(email,'')) LIKE $2 OR LOWER(COALESCE(company,'')) LIKE $2)
      ORDER BY name ASC
      LIMIT ${lim}`,
    [req.tenant.id, needle],
  );
  ok(res, rows);
}
