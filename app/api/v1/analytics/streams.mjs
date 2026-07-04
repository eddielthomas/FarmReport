// =============================================================================
// /api/v1/analytics/billing-streams?period=week|month|quarter|year
// -----------------------------------------------------------------------------
// Aggregates analytics.revenue_rollups by stream_id over the period window
// and joins billing.stream for display names. Returns one row per stream
// covering: amount_booked, amount_recognized, record_count, currency.
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq, parseQuery } from '../http.mjs';
import { resolvePeriodRange } from './rollup.mjs';

const PERIODS = new Set(['week','month','quarter','year']);

export async function billingStreams(req, res) {
  const qs = parseQuery(req.url);
  const period = qs.period && PERIODS.has(qs.period) ? qs.period : 'month';
  const { from, today } = resolvePeriodRange(period);
  const tenantId = req.tenant.id;

  // Historical [from, today)
  const { rows: hist } = await q(
    `SELECT
        rr.stream_id,
        s.key  AS stream_key,
        s.name AS stream_name,
        rr.currency,
        COALESCE(SUM(rr.amount) FILTER (WHERE rr.status = 'booked'), 0)              AS amount_booked,
        COALESCE(SUM(rr.amount) FILTER (WHERE rr.status IN ('recognized','paid')), 0) AS amount_recognized,
        SUM(rr.record_count)::int AS record_count
       FROM analytics.revenue_rollups rr
       LEFT JOIN billing.stream s ON s.id = rr.stream_id AND s.tenant_id = $1
      WHERE rr.tenant_id = $1
        AND rr.bucket_date >= $2::date
        AND rr.bucket_date <  $3::date
      GROUP BY rr.stream_id, s.key, s.name, rr.currency
      ORDER BY
        COALESCE(SUM(rr.amount) FILTER (WHERE rr.status = 'booked'), 0)
        + COALESCE(SUM(rr.amount) FILTER (WHERE rr.status IN ('recognized','paid')), 0) DESC`,
    [tenantId, from, today],
  );

  // Live today bucket from sales.revenue_record.
  const { rows: live } = await q(
    `SELECT rr.stream_id,
            s.key  AS stream_key,
            s.name AS stream_name,
            rr.currency,
            COALESCE(SUM(rr.amount) FILTER (WHERE rr.status = 'booked'
              AND rr.created_at >= current_date
              AND rr.created_at <  current_date + INTERVAL '1 day'), 0) AS amount_booked,
            COALESCE(SUM(rr.amount) FILTER (WHERE rr.status IN ('recognized','paid')
              AND rr.recognized_at IS NOT NULL
              AND rr.recognized_at >= current_date
              AND rr.recognized_at <  current_date + INTERVAL '1 day'), 0) AS amount_recognized,
            COUNT(*)::int AS record_count
       FROM sales.revenue_record rr
       LEFT JOIN billing.stream s ON s.id = rr.stream_id AND s.tenant_id = $1
      WHERE rr.tenant_id = $1
        AND (
          (rr.status = 'booked'
             AND rr.created_at >= current_date
             AND rr.created_at <  current_date + INTERVAL '1 day')
          OR
          (rr.status IN ('recognized','paid')
             AND rr.recognized_at IS NOT NULL
             AND rr.recognized_at >= current_date
             AND rr.recognized_at <  current_date + INTERVAL '1 day')
        )
      GROUP BY rr.stream_id, s.key, s.name, rr.currency`,
    [tenantId],
  );

  // Merge by (stream_id, currency)
  const key = (r) => `${r.stream_id ?? 'null'}|${r.currency}`;
  const merged = new Map();
  for (const r of hist) {
    merged.set(key(r), {
      stream_id: r.stream_id,
      stream_key: r.stream_key,
      stream_name: r.stream_name ?? '(ungrouped)',
      currency: r.currency,
      amount_booked: Number(r.amount_booked),
      amount_recognized: Number(r.amount_recognized),
      record_count: Number(r.record_count),
    });
  }
  for (const r of live) {
    const k = key(r);
    const cur = merged.get(k) ?? {
      stream_id: r.stream_id,
      stream_key: r.stream_key,
      stream_name: r.stream_name ?? '(ungrouped)',
      currency: r.currency,
      amount_booked: 0, amount_recognized: 0, record_count: 0,
    };
    cur.amount_booked     += Number(r.amount_booked);
    cur.amount_recognized += Number(r.amount_recognized);
    cur.record_count      += Number(r.record_count);
    merged.set(k, cur);
  }

  // Ensure all known streams appear even if they had no activity in the window.
  const { rows: known } = await q(
    `SELECT id, key, name, currency FROM billing.stream WHERE tenant_id = $1 AND active`,
    [tenantId],
  );
  for (const s of known) {
    const k = `${s.id}|${s.currency}`;
    if (!merged.has(k)) {
      merged.set(k, {
        stream_id: s.id, stream_key: s.key, stream_name: s.name,
        currency: s.currency,
        amount_booked: 0, amount_recognized: 0, record_count: 0,
      });
    }
  }

  const out = Array.from(merged.values()).sort((a, b) =>
    (b.amount_booked + b.amount_recognized) - (a.amount_booked + a.amount_recognized)
  );
  ok(res, { period, periodFrom: from, periodTo: today, streams: out });
}
