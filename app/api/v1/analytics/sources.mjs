// =============================================================================
// /api/v1/analytics/lead-sources?period=week|month|quarter|year
// -----------------------------------------------------------------------------
// Aggregates analytics.lead_source_rollups over the period window, returning
// one row per `source` with totals + a conversion rate (basis points).
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq, parseQuery } from '../http.mjs';
import { resolvePeriodRange } from './rollup.mjs';

const PERIODS = new Set(['week','month','quarter','year']);

export async function leadSources(req, res) {
  const qs = parseQuery(req.url);
  const period = qs.period && PERIODS.has(qs.period) ? qs.period : 'month';
  const { from, today } = resolvePeriodRange(period);
  const tenantId = req.tenant.id;

  // Historical rollup buckets [from, today).
  const { rows: hist } = await q(
    `SELECT source,
            SUM(new_leads)::int     AS new_leads,
            SUM(converted)::int     AS converted,
            SUM(total_revenue)      AS total_revenue
       FROM analytics.lead_source_rollups
      WHERE tenant_id = $1
        AND bucket_date >= $2::date
        AND bucket_date <  $3::date
      GROUP BY source
      ORDER BY new_leads DESC`,
    [tenantId, from, today],
  );

  // Live today: count leads created today by source.
  const { rows: live } = await q(
    `SELECT COALESCE(NULLIF(source::text, ''), 'unknown') AS source,
            COUNT(*)::int                                   AS new_leads,
            COUNT(*) FILTER (WHERE status = 'Client')::int AS converted,
            COALESCE(SUM(total_revenue) FILTER (WHERE status = 'Client'), 0) AS total_revenue
       FROM sales.lead
      WHERE tenant_id = $1
        AND created_at >= current_date
        AND created_at <  current_date + INTERVAL '1 day'
      GROUP BY 1`,
    [tenantId],
  );

  // Merge live into hist by source.
  const merged = new Map();
  for (const r of hist) {
    merged.set(r.source, {
      source: r.source,
      new_leads: Number(r.new_leads),
      converted: Number(r.converted),
      total_revenue: Number(r.total_revenue),
    });
  }
  for (const r of live) {
    const cur = merged.get(r.source) ?? { source: r.source, new_leads: 0, converted: 0, total_revenue: 0 };
    cur.new_leads     += Number(r.new_leads);
    cur.converted     += Number(r.converted);
    cur.total_revenue += Number(r.total_revenue);
    merged.set(r.source, cur);
  }

  const out = Array.from(merged.values()).map((r) => ({
    ...r,
    conversion_rate_bps: r.new_leads === 0 ? 0 : Math.round((r.converted * 10000) / r.new_leads),
  }));
  out.sort((a, b) => b.new_leads - a.new_leads);
  ok(res, { period, periodFrom: from, periodTo: today, sources: out });
}
