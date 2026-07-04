// =============================================================================
// /api/v1/analytics/dashboard — period-scoped headline KPI grid.
// -----------------------------------------------------------------------------
// `GET /analytics/dashboard/metrics?period=week|month|quarter|year`
//
// Reads pre-computed analytics.daily_tenant_metrics for [from, today) then
// adds a live "today" partial bucket computed straight from sales.*. The
// response envelope stays drop-in compatible with the existing dashboard.html
// React surface so omitted period falls back to 'month'.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq, parseQuery } from '../http.mjs';
import { resolvePeriodRange } from './rollup.mjs';

const PERIODS = new Set(['week','month','quarter','year']);

// ---- /analytics/dashboard/metrics?period=... -------------------------------
export async function dashboardMetrics(req, res) {
  const qs = parseQuery(req.url);
  const period = qs.period && PERIODS.has(qs.period) ? qs.period : 'month';
  const { from, today } = resolvePeriodRange(period);
  const tenantId = req.tenant.id;

  // Snapshot KPIs come from live sales.lead so the headline numbers reflect
  // current state. The period-scoped fields (new_leads_period, new_clients_
  // period, total_revenue_period, open_revenue) come from the rollup + live
  // today.
  const { rows: snap } = await q(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('Info Request','Lead','Client'))             AS total_leads,
        COUNT(*) FILTER (WHERE status = 'Info Request')                                AS pending_info,
        COUNT(*) FILTER (WHERE status = 'Client')                                      AS active_clients,
        COUNT(*) FILTER (WHERE status = 'Lead')                                        AS open_leads,
        COALESCE(SUM(total_revenue) FILTER (WHERE status = 'Client'), 0)               AS total_profit
       FROM sales.lead
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const c = snap[0];
  const totalLeads = Number(c.total_leads);
  const activeClients = Number(c.active_clients);
  const conversionRate = totalLeads === 0 ? 0
    : Math.round((activeClients / totalLeads) * 1000) / 10; // 1-decimal

  // Period rollup sum [from, today)
  const { rows: histRows } = await q(
    `SELECT
        COALESCE(SUM(new_leads), 0)::int   AS new_leads,
        COALESCE(SUM(new_clients), 0)::int AS new_clients,
        COALESCE(SUM(total_revenue), 0)    AS total_revenue,
        MAX(open_revenue)                  AS open_revenue,
        COALESCE(SUM(meetings_held), 0)::int  AS meetings_held,
        COALESCE(SUM(messages_sent), 0)::int  AS messages_sent
       FROM analytics.daily_tenant_metrics
      WHERE tenant_id = $1
        AND bucket_date >= $2::date
        AND bucket_date <  $3::date`,
    [tenantId, from, today],
  );
  const h = histRows[0];

  // Live "today" partial bucket — pulled directly from sales.* so the dashboard
  // reflects intra-day movement without waiting on a rollup tick.
  const { rows: liveRows } = await q(
    `SELECT
        COALESCE(SUM(CASE WHEN status IN ('Lead','Client')
                          AND ((status_timestamps->>'convertedToLeadAt')::timestamptz
                                BETWEEN $2::date AND ($2::date + INTERVAL '1 day'))
                     THEN 1 ELSE 0 END), 0)::int                              AS new_leads,
        COALESCE(SUM(CASE WHEN status = 'Client'
                          AND ((status_timestamps->>'convertedToClientAt')::timestamptz
                                BETWEEN $2::date AND ($2::date + INTERVAL '1 day'))
                     THEN 1 ELSE 0 END), 0)::int                              AS new_clients
       FROM sales.lead WHERE tenant_id = $1`,
    [tenantId, today],
  );
  const { rows: liveRev } = await q(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status IN ('recognized','paid')
                                       AND recognized_at IS NOT NULL
                                       AND recognized_at >= $2::date
                                       AND recognized_at <  $2::date + INTERVAL '1 day'), 0) AS total_revenue,
        COALESCE(SUM(amount) FILTER (WHERE status = 'booked' AND recognized_at IS NULL), 0)  AS open_revenue
       FROM sales.revenue_record
      WHERE tenant_id = $1`,
    [tenantId, today],
  );
  const live = liveRows[0];
  const liveR = liveRev[0];

  // ---- 12-month trend (unchanged shape) ------------------------------------
  const { rows: bucketRows } = await q(
    `WITH months AS (
       SELECT generate_series(
         date_trunc('month', now()) - INTERVAL '11 months',
         date_trunc('month', now()),
         '1 month'
       )::date AS month_start
     ),
     leads_per_month AS (
       SELECT date_trunc('month',
                COALESCE(
                  (status_timestamps->>'convertedToLeadAt')::timestamptz,
                  (status_timestamps->>'infoRequestedAt')::timestamptz,
                  created_at))::date AS month_start,
              COUNT(*) AS n
         FROM sales.lead
        WHERE tenant_id = $1 AND status IN ('Lead','Client')
        GROUP BY 1
     ),
     clients_per_month AS (
       SELECT date_trunc('month',
                COALESCE((status_timestamps->>'convertedToClientAt')::timestamptz, created_at))::date AS month_start,
              COUNT(*) AS n,
              COALESCE(SUM(total_revenue), 0) AS revenue
         FROM sales.lead
        WHERE tenant_id = $1 AND status = 'Client'
        GROUP BY 1
     )
     SELECT m.month_start,
            COALESCE(l.n, 0)::int       AS leads,
            COALESCE(c.n, 0)::int       AS clients,
            COALESCE(c.revenue, 0)::numeric AS revenue
       FROM months m
       LEFT JOIN leads_per_month  l ON l.month_start  = m.month_start
       LEFT JOIN clients_per_month c ON c.month_start = m.month_start
      ORDER BY m.month_start`,
    [tenantId],
  );
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let cumLeads = 0, cumClients = 0;
  const chartData = bucketRows.map((r) => {
    cumLeads   += r.leads;
    cumClients += r.clients;
    return {
      month: MONTH_NAMES[new Date(r.month_start).getUTCMonth()],
      leads: r.leads,
      clients: r.clients,
      revenue: Number(r.revenue),
      conversionRate: cumLeads === 0 ? 0 : Math.round((cumClients / cumLeads) * 1000) / 10,
    };
  });

  ok(res, {
    period,
    periodFrom: from,
    periodTo:   today,
    totalLeads,
    pendingInfoRequests: Number(c.pending_info),
    totalActiveClients:  activeClients,
    openLeads:           Number(c.open_leads),
    totalProfit:         Number(c.total_profit),
    conversionRate,
    // NEW period-scoped fields
    new_leads_period:    Number(h.new_leads)   + Number(live.new_leads),
    new_clients_period:  Number(h.new_clients) + Number(live.new_clients),
    total_revenue_period: Number(h.total_revenue) + Number(liveR.total_revenue),
    open_revenue:        Number(liveR.open_revenue || h.open_revenue || 0),
    meetings_held_period: Number(h.meetings_held),
    messages_sent_period: Number(h.messages_sent),
    chartData,
  });
}
