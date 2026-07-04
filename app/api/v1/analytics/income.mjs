// =============================================================================
// /api/v1/analytics/income/:period — income time series.
// -----------------------------------------------------------------------------
// Rewritten to read from analytics.revenue_rollups grouped by bucket_date over
// the requested period window, plus a live "today" partial bucket pulled from
// sales.revenue_record. Bucket size adapts to the period:
//   week    → 7 daily   buckets
//   month   → ~4 weekly buckets
//   quarter → 3 monthly buckets
//   year    → 12 monthly buckets
// Each bucket: { label, income }.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq } from '../http.mjs';

const PERIODS = new Set(['week','month','quarter','year']);

export async function income(req, res, period) {
  if (!PERIODS.has(period)) return badReq(res, 'invalid_period');
  const tenantId = req.tenant.id;

  // Per-day rollup totals over the period window, then re-bucket in JS to keep
  // the original wire-shape (labels). Recognized + paid statuses contribute to
  // income; refunded/credited offset.
  const days = period === 'week' ? 7 : period === 'month' ? 30 : period === 'quarter' ? 90 : 365;
  const { rows: rollupRows } = await q(
    `SELECT bucket_date,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('recognized','paid')), 0)::numeric AS income,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('refunded','credited')), 0)::numeric AS offset_amount
       FROM analytics.revenue_rollups
      WHERE tenant_id = $1
        AND bucket_date >= current_date - ($2::int - 1)
        AND bucket_date <  current_date
      GROUP BY bucket_date
      ORDER BY bucket_date`,
    [tenantId, days],
  );

  // Add live today bucket from sales.revenue_record.
  const { rows: live } = await q(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status IN ('recognized','paid')
          AND recognized_at IS NOT NULL
          AND recognized_at >= current_date
          AND recognized_at <  current_date + INTERVAL '1 day'), 0)::numeric AS income,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('refunded','credited')
          AND created_at >= current_date
          AND created_at <  current_date + INTERVAL '1 day'), 0)::numeric AS offset_amount
       FROM sales.revenue_record WHERE tenant_id = $1`,
    [tenantId],
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const allRows = [
    ...rollupRows.map((r) => ({
      bucket_date: r.bucket_date,
      income: Number(r.income) - Number(r.offset_amount),
    })),
    { bucket_date: todayIso, income: Number(live[0].income) - Number(live[0].offset_amount) },
  ];

  // Bucket re-labelling
  const out = [];
  if (period === 'week') {
    // 7 daily buckets, labelled Mon/Tue/...
    const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const map = new Map(allRows.map((r) => [r.bucket_date.toString().slice(0, 10), r.income]));
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - 6);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      out.push({ label: DOW[d.getUTCDay()], income: Number(map.get(iso) ?? 0) });
    }
  } else if (period === 'month') {
    // 4 weekly buckets W1..W4 covering last 28 days
    for (let i = 0; i < 4; i++) {
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - (28 - i * 7));
      const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7);
      let sum = 0;
      for (const r of allRows) {
        const ts = new Date(r.bucket_date + (r.bucket_date.length === 10 ? 'T00:00:00Z' : '')).getTime();
        if (ts >= start.getTime() && ts < end.getTime()) sum += Number(r.income);
      }
      out.push({ label: `W${i + 1}`, income: sum });
    }
  } else if (period === 'quarter') {
    // 3 monthly buckets covering last 3 months
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 2; i >= 0; i--) {
      const m = new Date(); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - i);
      const mEnd = new Date(m); mEnd.setUTCMonth(m.getUTCMonth() + 1);
      let sum = 0;
      for (const r of allRows) {
        const ts = new Date(r.bucket_date + (r.bucket_date.length === 10 ? 'T00:00:00Z' : '')).getTime();
        if (ts >= m.getTime() && ts < mEnd.getTime()) sum += Number(r.income);
      }
      out.push({ label: MON[m.getUTCMonth()], income: sum });
    }
  } else { // year
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 11; i >= 0; i--) {
      const m = new Date(); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - i);
      const mEnd = new Date(m); mEnd.setUTCMonth(m.getUTCMonth() + 1);
      let sum = 0;
      for (const r of allRows) {
        const ts = new Date(r.bucket_date + (r.bucket_date.length === 10 ? 'T00:00:00Z' : '')).getTime();
        if (ts >= m.getTime() && ts < mEnd.getTime()) sum += Number(r.income);
      }
      out.push({ label: MON[m.getUTCMonth()], income: sum });
    }
  }
  ok(res, out);
}
