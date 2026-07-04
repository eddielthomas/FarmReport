// =============================================================================
// /api/v1/farm/portfolio — buyer supply-chain rollups (Wave-2 Lane 2, docs/06 D2).
// -----------------------------------------------------------------------------
//   GET /farm/portfolio/rollup     v_buyer_rollup for the caller's tenant (buyer)
//   GET /farm/portfolio/suppliers  v_supplier_rollup rows (+ region name)
//   GET /farm/portfolio/regions    v_region_rollup rows
//
// The rollup VIEWS aggregate supplier → region → buyer over the risk_score /
// yield_at_risk store. That store is empty until the rollup worker computes from
// real observations, so risk/revenue figures come back as NULL/0 — the supplier
// and region *structure* (seeded chain) is real, the risk numbers are honestly
// absent until P2/P3.5.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { ok } from '../http.mjs';
import { farmGate } from './gate.mjs';

// GET /farm/portfolio/rollup — one buyer row for the current tenant.
export async function rollup(req, res) {
  if (!farmGate(req, res, 'farm.portfolio.view', 'farm:view')) return;
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT tenant_id, buyer_slug, buyer_name,
              supplier_count, region_count, farm_count,
              avg_risk_score, max_risk_score, revenue_at_risk_usd
         FROM farm.v_buyer_rollup
        WHERE tenant_id = $1`, [req.tenant.id]);
    return r.rows[0] ?? null;
  });
  // A brand-new buyer with no suppliers still gets an honest zeroed rollup.
  ok(res, row ?? {
    tenant_id: req.tenant.id, buyer_slug: req.tenant.slug ?? null, buyer_name: null,
    supplier_count: 0, region_count: 0, farm_count: 0,
    avg_risk_score: null, max_risk_score: null, revenue_at_risk_usd: 0,
  });
}

// GET /farm/portfolio/suppliers — supplier rollup rows + owning region name.
export async function suppliers(req, res) {
  if (!farmGate(req, res, 'farm.portfolio.view', 'farm:view')) return;
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT sr.supplier_id, sr.supplier_name, sr.sourcing_region_id,
              rg.name AS region_name,
              sr.farm_count, sr.avg_risk_score, sr.max_risk_score,
              sr.revenue_at_risk_usd
         FROM farm.v_supplier_rollup sr
         LEFT JOIN farm.sourcing_region rg ON rg.id = sr.sourcing_region_id
        WHERE sr.tenant_id = $1
        ORDER BY sr.max_risk_score DESC NULLS LAST, sr.supplier_name`, [req.tenant.id]);
    return r.rows;
  });
  ok(res, rows);
}

// GET /farm/portfolio/regions — region rollup rows.
export async function regions(req, res) {
  if (!farmGate(req, res, 'farm.portfolio.view', 'farm:view')) return;
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT sourcing_region_id, region_name,
              supplier_count, farm_count,
              avg_risk_score, max_risk_score, revenue_at_risk_usd
         FROM farm.v_region_rollup
        WHERE tenant_id = $1
        ORDER BY max_risk_score DESC NULLS LAST, region_name`, [req.tenant.id]);
    return r.rows;
  });
  ok(res, rows);
}
