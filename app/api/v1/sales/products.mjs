// =============================================================================
// /api/v1/sales/products — catalog list (read-only for now).
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok } from '../http.mjs';

export async function list(req, res) {
  const { rows } = await q(
    `SELECT id, name, sku, price, active
       FROM sales.product
      WHERE tenant_id = $1 AND active = TRUE
      ORDER BY name`,
    [req.tenant.id],
  );
  ok(res, rows);
}
