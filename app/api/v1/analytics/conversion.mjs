// =============================================================================
// /api/v1/analytics/conversion?cohort_start=YYYY-MM-DD&cohort_end=YYYY-MM-DD
// -----------------------------------------------------------------------------
// Returns cohort-funnel totals over the supplied date window (default 90 days
// ending today). Read straight from analytics.conversion_rollups.
//
// Response: { cohort_start, cohort_end, funnel: { cohort_size, to_lead,
// to_client, to_archived, median_days_to_lead, median_days_to_client },
// buckets: [{ bucket_date, cohort_size, to_client, conversion_rate_bps }] }
// =============================================================================

import { q } from '../db/pool.mjs';
import { ok, badReq, parseQuery } from '../http.mjs';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function conversion(req, res) {
  const qs = parseQuery(req.url);
  const tenantId = req.tenant.id;

  // Default window: last 90 days ending today.
  const todayIso = new Date().toISOString().slice(0, 10);
  const defStart = new Date();
  defStart.setUTCDate(defStart.getUTCDate() - 89);
  const defStartIso = defStart.toISOString().slice(0, 10);

  const start = ISO_DATE_RE.test(qs.cohort_start ?? '') ? qs.cohort_start : defStartIso;
  const end   = ISO_DATE_RE.test(qs.cohort_end   ?? '') ? qs.cohort_end   : todayIso;

  // Aggregate funnel totals over the cohort window.
  const { rows: fun } = await q(
    `SELECT
        COALESCE(SUM(cohort_size), 0)::int AS cohort_size,
        COALESCE(SUM(to_lead),     0)::int AS to_lead,
        COALESCE(SUM(to_client),   0)::int AS to_client,
        COALESCE(SUM(to_archived), 0)::int AS to_archived,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY median_days_to_lead)   FILTER (WHERE median_days_to_lead   IS NOT NULL))::int AS median_days_to_lead,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY median_days_to_client) FILTER (WHERE median_days_to_client IS NOT NULL))::int AS median_days_to_client
       FROM analytics.conversion_rollups
      WHERE tenant_id = $1
        AND bucket_date >= $2::date
        AND bucket_date <= $3::date`,
    [tenantId, start, end],
  );

  // Per-bucket breakdown (one row per cohort day).
  const { rows: buckets } = await q(
    `SELECT bucket_date, cohort_size, to_lead, to_client, to_archived,
            median_days_to_lead, median_days_to_client,
            CASE WHEN cohort_size = 0 THEN 0
                 ELSE (to_client * 10000 / NULLIF(cohort_size, 0))::int END AS conversion_rate_bps
       FROM analytics.conversion_rollups
      WHERE tenant_id = $1
        AND bucket_date >= $2::date
        AND bucket_date <= $3::date
      ORDER BY bucket_date`,
    [tenantId, start, end],
  );

  const f = fun[0];
  ok(res, {
    cohort_start: start,
    cohort_end:   end,
    funnel: {
      cohort_size:           Number(f.cohort_size),
      to_lead:               Number(f.to_lead),
      to_client:             Number(f.to_client),
      to_archived:           Number(f.to_archived),
      median_days_to_lead:   f.median_days_to_lead ?? null,
      median_days_to_client: f.median_days_to_client ?? null,
      conversion_rate_bps:   Number(f.cohort_size) === 0 ? 0
        : Math.round((Number(f.to_client) * 10000) / Number(f.cohort_size)),
    },
    buckets: buckets.map((b) => ({
      bucket_date: b.bucket_date,
      cohort_size: Number(b.cohort_size),
      to_lead:     Number(b.to_lead),
      to_client:   Number(b.to_client),
      to_archived: Number(b.to_archived),
      conversion_rate_bps: Number(b.conversion_rate_bps),
    })),
  });
}
