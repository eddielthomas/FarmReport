// =============================================================================
// /api/v1/analytics — barrel module.
// -----------------------------------------------------------------------------
// Re-exports the four refactored analytics endpoint handlers + the legacy
// `stats` adapter. Backwards-compatible with the v1 router which imports this
// file under the `analytics` lazy key.
//
// Real code lives in:
//   - dashboard.mjs  (period-scoped KPI grid)
//   - income.mjs     (income time series, period-scoped buckets)
//   - sources.mjs    (lead-source breakdown)
//   - streams.mjs    (billing-stream breakdown)
//   - conversion.mjs (cohort funnel)
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok } from '../http.mjs';

export { dashboardMetrics } from './dashboard.mjs';
export { income }           from './income.mjs';
export { leadSources }      from './sources.mjs';
export { billingStreams }   from './streams.mjs';
export { conversion }       from './conversion.mjs';

// ---- /analytics/stats (legacy adapter) -------------------------------------
// Kept verbatim for the existing dashboard.html stats banner — drops in a
// few simple counts so a partial UI port still works without the rollup.
export async function stats(req, res) {
  const { rows } = await q(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'Info Request')                                         AS open_requests,
        COUNT(*) FILTER (WHERE status = 'Lead')                                                 AS open_leads,
        COUNT(*) FILTER (WHERE status = 'Info Request'
                          AND created_at >= date_trunc('day', now()))                           AS new_leads_today,
        COALESCE(SUM(total_revenue) FILTER (WHERE status = 'Client'
                          AND created_at >= date_trunc('week', now())), 0)                      AS revenue_this_week
       FROM sales.lead WHERE tenant_id = $1`,
    [req.tenant.id],
  );
  const { rows: mrows } = await q(
    `SELECT COUNT(*) AS meetings_today
       FROM sales.meeting
      WHERE tenant_id = $1
        AND start_at >= date_trunc('day', now())
        AND start_at <  date_trunc('day', now()) + INTERVAL '1 day'`,
    [req.tenant.id],
  );
  ok(res, {
    newLeadsToday:   Number(rows[0].new_leads_today),
    openRequests:    Number(rows[0].open_requests),
    openLeads:       Number(rows[0].open_leads),
    meetingsToday:   Number(mrows[0].meetings_today),
    revenueThisWeek: Number(rows[0].revenue_this_week),
  });
}
