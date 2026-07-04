// =============================================================================
// /api/v1/analytics/rollup.mjs — idempotent daily rollup compute worker.
// -----------------------------------------------------------------------------
// Each rollup is a single SQL UPSERT keyed on its primary key — safe to re-run
// N times per (tenantId, date). The 7 rollups + 1 audit row all run inside a
// single transaction so a mid-batch failure rolls back to the prior good state.
//
// The DB-truth alignment differs from the original plan in a few spots so the
// code matches the *real* schema as of S2A (mig 122):
//   - sales.revenue_record.client_lead_id (not client_id)
//   - sales.revenue_record has no booked_at column → created_at is the boot
//     timestamp; recognized_at marks recognition
//   - revenue status enum: 'booked','recognized','invoiced','paid','refunded',
//     'credited'  →  recognized-bucket sums status IN ('recognized','paid')
// =============================================================================

import { q, pool } from '../db/pool.mjs';
import { recordAudit } from '../audit.mjs';

export const ROLLUP_VERSION = 1;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertDate(date) {
  if (typeof date !== 'string' || !ISO_DATE_RE.test(date)) {
    throw new Error(`computeDay: invalid date '${date}' (expected YYYY-MM-DD)`);
  }
}
function assertTenant(tenantId) {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new Error(`computeDay: invalid tenantId '${tenantId}'`);
  }
}

// -----------------------------------------------------------------------------
// computeDay(tenantId, date, { req }) — recompute one (tenant, day) row across
// all 7 rollup tables in a single transaction. Returns { rowsWritten, runId }.
// -----------------------------------------------------------------------------
export async function computeDay(tenantId, date, { req = null } = {}) {
  assertTenant(tenantId);
  assertDate(date);
  const startedAt = Date.now();

  // 1) Open audit row up-front. Outside the main TX so we can record a failure
  //    even if the rollups themselves abort.
  const runIns = await q(
    `INSERT INTO analytics.rollup_run
        (tenant_id, bucket_date, source_version)
      VALUES ($1::uuid, $2::date, $3::int)
      RETURNING id`,
    [tenantId, date, ROLLUP_VERSION],
  );
  const runId = runIns.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let rowsWritten = 0;
    rowsWritten += await rollupDailyTenantMetrics(client, tenantId, date);
    rowsWritten += await rollupRevenue(client, tenantId, date);
    rowsWritten += await rollupLeadSource(client, tenantId, date);
    rowsWritten += await rollupConversion(client, tenantId, date);
    rowsWritten += await rollupChatActivity(client, tenantId, date);
    rowsWritten += await rollupMeetings(client, tenantId, date);
    rowsWritten += await rollupDailyUserMetrics(client, tenantId, date);
    await client.query('COMMIT');

    await q(
      `UPDATE analytics.rollup_run
          SET finished_at = now(),
              status = 'ok',
              rows_written = $2,
              duration_ms = $3
        WHERE id = $1`,
      [runId, rowsWritten, Date.now() - startedAt],
    );

    // Audit emit. We hand-stamp tenant in the synthetic req if the caller
    // didn't pass one (e.g. CLI / scheduler).
    const auditReq = req ?? { tenant: { id: tenantId }, headers: {}, user: { sub: null, email: 'analytics@rollup' } };
    recordAudit({
      req: auditReq,
      action: 'analytics.rollup.compute',
      resource: 'analytics.daily_tenant_metrics',
      resourceId: tenantId,
      payload: { bucket_date: date, source_version: ROLLUP_VERSION, rows_written: rowsWritten, run_id: runId },
    });

    return { ok: true, runId, rowsWritten };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await q(
      `UPDATE analytics.rollup_run
          SET finished_at = now(),
              status = 'error',
              error_message = $2,
              duration_ms = $3
        WHERE id = $1`,
      [runId, String(err?.message ?? err), Date.now() - startedAt],
    ).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
// computeTenantBackfill(tenantId, startDate, endDate) — runs computeDay for
// every day in [startDate, endDate] inclusive. Returns aggregate stats.
// -----------------------------------------------------------------------------
export async function computeTenantBackfill(tenantId, startDate, endDate, { req = null, log = () => {} } = {}) {
  assertTenant(tenantId);
  assertDate(startDate);
  assertDate(endDate);

  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate   + 'T00:00:00Z');
  if (end < start) throw new Error('computeTenantBackfill: endDate < startDate');

  let ok = 0, fail = 0, totalRows = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    try {
      const r = await computeDay(tenantId, iso, { req });
      ok++;
      totalRows += r.rowsWritten;
      log(`  ok    tenant=${tenantId} date=${iso} rows=${r.rowsWritten}`);
    } catch (err) {
      fail++;
      log(`  FAIL  tenant=${tenantId} date=${iso} ${err?.message ?? err}`);
    }
  }
  return { ok, fail, totalRows };
}

// =============================================================================
// Individual rollup statements. Each writes to one analytics.* table via UPSERT
// and returns rowCount. Bumping ROLLUP_VERSION causes the source_version
// column to drift, signalling that prior rows are stale and should be re-run.
// =============================================================================

// 1) daily_tenant_metrics
async function rollupDailyTenantMetrics(client, tenantId, date) {
  const { rowCount } = await client.query(
    `INSERT INTO analytics.daily_tenant_metrics
        (tenant_id, bucket_date,
         total_leads, pending_info_requests, open_leads, total_active_clients,
         archived_leads, contact_only, conversion_rate_bps,
         total_revenue, open_revenue,
         meetings_held, messages_sent,
         new_leads, new_clients,
         source_version)
     SELECT
       $1::uuid, $2::date,
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1
            AND status IN ('Info Request','Lead','Client')
            AND created_at <= ($2::date + INTERVAL '1 day')),
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1 AND status = 'Info Request'
            AND created_at <= ($2::date + INTERVAL '1 day')),
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1 AND status = 'Lead'
            AND created_at <= ($2::date + INTERVAL '1 day')),
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1 AND status = 'Client'
            AND created_at <= ($2::date + INTERVAL '1 day')),
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1 AND status = 'Archived'
            AND created_at <= ($2::date + INTERVAL '1 day')),
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1 AND status = 'Contact Only'
            AND created_at <= ($2::date + INTERVAL '1 day')),
       /* conversion_rate_bps: 10000 * new_clients_on_day / NULLIF(new_leads_on_day, 0) */
       (SELECT
          CASE WHEN COALESCE(SUM(new_leads_n), 0) = 0 THEN 0
               ELSE (COALESCE(SUM(new_clients_n), 0) * 10000
                     / NULLIF(SUM(new_leads_n), 0))::int
          END
         FROM (
           SELECT
             COUNT(*) FILTER (
               WHERE (status_timestamps->>'convertedToLeadAt') IS NOT NULL
                 AND (status_timestamps->>'convertedToLeadAt')::timestamptz >= $2::date
                 AND (status_timestamps->>'convertedToLeadAt')::timestamptz <  $2::date + INTERVAL '1 day'
             ) AS new_leads_n,
             COUNT(*) FILTER (
               WHERE (status_timestamps->>'convertedToClientAt') IS NOT NULL
                 AND (status_timestamps->>'convertedToClientAt')::timestamptz >= $2::date
                 AND (status_timestamps->>'convertedToClientAt')::timestamptz <  $2::date + INTERVAL '1 day'
             ) AS new_clients_n
           FROM sales.lead WHERE tenant_id = $1
         ) s),
       /* total_revenue: recognized OR paid on the bucket date */
       (SELECT COALESCE(SUM(amount), 0) FROM sales.revenue_record
          WHERE tenant_id = $1
            AND status IN ('recognized','paid')
            AND recognized_at IS NOT NULL
            AND recognized_at >= $2::date
            AND recognized_at <  $2::date + INTERVAL '1 day'),
       /* open_revenue: booked but not yet recognized, cumulative up to day */
       (SELECT COALESCE(SUM(amount), 0) FROM sales.revenue_record
          WHERE tenant_id = $1
            AND status = 'booked'
            AND recognized_at IS NULL
            AND created_at <= ($2::date + INTERVAL '1 day')),
       /* meetings_held on the bucket date */
       (SELECT COUNT(*) FROM sales.meeting
          WHERE tenant_id = $1
            AND start_at >= $2::date
            AND start_at <  $2::date + INTERVAL '1 day'),
       /* messages_sent on the bucket date */
       (SELECT COUNT(*) FROM sales.message
          WHERE tenant_id = $1
            AND created_at >= $2::date
            AND created_at <  $2::date + INTERVAL '1 day'),
       /* new_leads on day = leads whose convertedToLeadAt OR created_at falls in the bucket */
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1
            AND (
              ((status_timestamps->>'convertedToLeadAt') IS NOT NULL
                AND (status_timestamps->>'convertedToLeadAt')::timestamptz >= $2::date
                AND (status_timestamps->>'convertedToLeadAt')::timestamptz <  $2::date + INTERVAL '1 day')
              OR
              ((status_timestamps->>'convertedToLeadAt') IS NULL
                AND status IN ('Lead','Client')
                AND created_at >= $2::date
                AND created_at <  $2::date + INTERVAL '1 day')
            )),
       /* new_clients on day */
       (SELECT COUNT(*) FROM sales.lead
          WHERE tenant_id = $1
            AND status = 'Client'
            AND (
              ((status_timestamps->>'convertedToClientAt') IS NOT NULL
                AND (status_timestamps->>'convertedToClientAt')::timestamptz >= $2::date
                AND (status_timestamps->>'convertedToClientAt')::timestamptz <  $2::date + INTERVAL '1 day')
              OR
              ((status_timestamps->>'convertedToClientAt') IS NULL
                AND created_at >= $2::date
                AND created_at <  $2::date + INTERVAL '1 day')
            )),
       $3::int
     ON CONFLICT (tenant_id, bucket_date) DO UPDATE SET
       total_leads = EXCLUDED.total_leads,
       pending_info_requests = EXCLUDED.pending_info_requests,
       open_leads = EXCLUDED.open_leads,
       total_active_clients = EXCLUDED.total_active_clients,
       archived_leads = EXCLUDED.archived_leads,
       contact_only = EXCLUDED.contact_only,
       conversion_rate_bps = EXCLUDED.conversion_rate_bps,
       total_revenue = EXCLUDED.total_revenue,
       open_revenue = EXCLUDED.open_revenue,
       meetings_held = EXCLUDED.meetings_held,
       messages_sent = EXCLUDED.messages_sent,
       new_leads = EXCLUDED.new_leads,
       new_clients = EXCLUDED.new_clients,
       source_version = EXCLUDED.source_version,
       computed_at = now()`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 2) revenue_rollups — per (day, stream_id, status, currency)
async function rollupRevenue(client, tenantId, date) {
  // First clear stale rows for this (tenant, bucket_date) so combos that
  // disappeared on this day don't linger (e.g. a refund moved a row out of
  // 'booked' into 'refunded'). Then re-insert from the source.
  await client.query(
    `DELETE FROM analytics.revenue_rollups
      WHERE tenant_id = $1 AND bucket_date = $2`,
    [tenantId, date],
  );
  const { rowCount } = await client.query(
    `INSERT INTO analytics.revenue_rollups
        (tenant_id, bucket_date, stream_id, status, currency,
         amount, record_count, source_version)
     SELECT
       $1::uuid, $2::date,
       rr.stream_id,
       rr.status::text,
       rr.currency,
       SUM(rr.amount),
       COUNT(*),
       $3::int
     FROM sales.revenue_record rr
     WHERE rr.tenant_id = $1
       AND (
         /* 'booked' bucket = created_at lands in the day */
         (rr.status = 'booked'
            AND rr.created_at >= $2::date
            AND rr.created_at <  $2::date + INTERVAL '1 day')
         OR
         /* 'recognized' / 'paid' bucket = recognized_at lands in the day */
         (rr.status IN ('recognized','paid')
            AND rr.recognized_at IS NOT NULL
            AND rr.recognized_at >= $2::date
            AND rr.recognized_at <  $2::date + INTERVAL '1 day')
         OR
         /* offsetting rows ('refunded','credited') use created_at */
         (rr.status IN ('refunded','credited','invoiced')
            AND rr.created_at >= $2::date
            AND rr.created_at <  $2::date + INTERVAL '1 day')
       )
     GROUP BY rr.stream_id, rr.status, rr.currency`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 3) lead_source_rollups
async function rollupLeadSource(client, tenantId, date) {
  await client.query(
    `DELETE FROM analytics.lead_source_rollups
      WHERE tenant_id = $1 AND bucket_date = $2`,
    [tenantId, date],
  );
  const { rowCount } = await client.query(
    `INSERT INTO analytics.lead_source_rollups
        (tenant_id, bucket_date, source, new_leads, converted, total_revenue, source_version)
     SELECT
       $1::uuid, $2::date,
       COALESCE(NULLIF(l.source::text, ''), 'unknown'),
       COUNT(*),
       COUNT(*) FILTER (WHERE l.status = 'Client'),
       COALESCE(SUM(l.total_revenue) FILTER (WHERE l.status = 'Client'), 0),
       $3::int
     FROM sales.lead l
     WHERE l.tenant_id = $1
       AND l.created_at >= $2::date
       AND l.created_at <  $2::date + INTERVAL '1 day'
     GROUP BY COALESCE(NULLIF(l.source::text, ''), 'unknown')`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 4) conversion_rollups — cohort funnel for leads created on bucket_date
async function rollupConversion(client, tenantId, date) {
  const { rowCount } = await client.query(
    `INSERT INTO analytics.conversion_rollups
        (tenant_id, bucket_date,
         cohort_size, to_lead, to_client, to_archived,
         median_days_to_lead, median_days_to_client, source_version)
     SELECT $1::uuid, $2::date,
       COUNT(*),
       COUNT(*) FILTER (WHERE status IN ('Lead','Client')),
       COUNT(*) FILTER (WHERE status = 'Client'),
       COUNT(*) FILTER (WHERE status = 'Archived'),
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY
          EXTRACT(EPOCH FROM ((status_timestamps->>'convertedToLeadAt')::timestamptz - created_at)) / 86400
       ) FILTER (WHERE (status_timestamps->>'convertedToLeadAt') IS NOT NULL))::int,
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY
          EXTRACT(EPOCH FROM ((status_timestamps->>'convertedToClientAt')::timestamptz - created_at)) / 86400
       ) FILTER (WHERE (status_timestamps->>'convertedToClientAt') IS NOT NULL))::int,
       $3::int
     FROM sales.lead
     WHERE tenant_id = $1
       AND created_at >= $2::date
       AND created_at <  $2::date + INTERVAL '1 day'
     ON CONFLICT (tenant_id, bucket_date) DO UPDATE SET
       cohort_size = EXCLUDED.cohort_size,
       to_lead = EXCLUDED.to_lead,
       to_client = EXCLUDED.to_client,
       to_archived = EXCLUDED.to_archived,
       median_days_to_lead = EXCLUDED.median_days_to_lead,
       median_days_to_client = EXCLUDED.median_days_to_client,
       source_version = EXCLUDED.source_version,
       computed_at = now()`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 5) chat_activity_rollups
async function rollupChatActivity(client, tenantId, date) {
  const { rowCount } = await client.query(
    `INSERT INTO analytics.chat_activity_rollups
        (tenant_id, bucket_date,
         messages_inbound, messages_outbound,
         conversations_open, conversations_new,
         median_response_sec, source_version)
     SELECT $1::uuid, $2::date,
       COUNT(*) FILTER (WHERE sender = 'contact'),
       COUNT(*) FILTER (WHERE sender = 'agent'),
       COUNT(DISTINCT lead_id),
       COUNT(DISTINCT lead_id) FILTER (
         WHERE NOT EXISTS (
           SELECT 1 FROM sales.message m2
            WHERE m2.lead_id = m.lead_id
              AND m2.tenant_id = $1
              AND m2.created_at < $2::date
         )
       ),
       NULL::int,
       $3::int
     FROM sales.message m
     WHERE tenant_id = $1
       AND created_at >= $2::date
       AND created_at <  $2::date + INTERVAL '1 day'
     ON CONFLICT (tenant_id, bucket_date) DO UPDATE SET
       messages_inbound = EXCLUDED.messages_inbound,
       messages_outbound = EXCLUDED.messages_outbound,
       conversations_open = EXCLUDED.conversations_open,
       conversations_new = EXCLUDED.conversations_new,
       source_version = EXCLUDED.source_version,
       computed_at = now()`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 6) meeting_rollups
async function rollupMeetings(client, tenantId, date) {
  const { rowCount } = await client.query(
    `INSERT INTO analytics.meeting_rollups
        (tenant_id, bucket_date,
         scheduled, held, cancelled, no_show,
         avg_duration_min, source_version)
     SELECT $1::uuid, $2::date,
       COUNT(*),
       COUNT(*),  /* held proxy: existing meetings table has no status column */
       0,
       0,
       AVG(EXTRACT(EPOCH FROM (end_at - start_at)) / 60)::int,
       $3::int
     FROM sales.meeting
     WHERE tenant_id = $1
       AND start_at >= $2::date
       AND start_at <  $2::date + INTERVAL '1 day'
     ON CONFLICT (tenant_id, bucket_date) DO UPDATE SET
       scheduled = EXCLUDED.scheduled,
       held = EXCLUDED.held,
       cancelled = EXCLUDED.cancelled,
       no_show = EXCLUDED.no_show,
       avg_duration_min = EXCLUDED.avg_duration_min,
       source_version = EXCLUDED.source_version,
       computed_at = now()`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// 7) daily_user_metrics — sources sales.assignment JOIN sales.lead + meeting + message + revenue_record
async function rollupDailyUserMetrics(client, tenantId, date) {
  // Wipe stale rows for the day, then rebuild from the live source so a
  // dropped assignment doesn't leave an orphan row behind.
  await client.query(
    `DELETE FROM analytics.daily_user_metrics
      WHERE tenant_id = $1 AND bucket_date = $2`,
    [tenantId, date],
  );
  const { rowCount } = await client.query(
    `INSERT INTO analytics.daily_user_metrics
        (tenant_id, user_id, bucket_date,
         leads_assigned, leads_converted, clients_owned,
         meetings_held, messages_sent, revenue_booked, source_version)
     SELECT
       $1::uuid, u.user_id, $2::date,
       COUNT(DISTINCT l.id) FILTER (WHERE l.id IS NOT NULL),
       COUNT(DISTINCT l.id) FILTER (
         WHERE l.status = 'Client'
           AND (l.status_timestamps->>'convertedToClientAt') IS NOT NULL
           AND (l.status_timestamps->>'convertedToClientAt')::timestamptz >= $2::date
           AND (l.status_timestamps->>'convertedToClientAt')::timestamptz <  $2::date + INTERVAL '1 day'
       ),
       COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'Client'),
       COUNT(DISTINCT m.id) FILTER (
         WHERE m.start_at >= $2::date AND m.start_at < $2::date + INTERVAL '1 day'
       ),
       COUNT(DISTINCT msg.id) FILTER (
         WHERE msg.created_at >= $2::date
           AND msg.created_at <  $2::date + INTERVAL '1 day'
           AND msg.sender = 'agent'
       ),
       COALESCE(SUM(DISTINCT rr.amount) FILTER (
         WHERE rr.created_at >= $2::date
           AND rr.created_at <  $2::date + INTERVAL '1 day'
           AND rr.status IN ('booked','recognized','paid')
       ), 0),
       $3::int
     FROM (
       SELECT DISTINCT a.user_id, a.entity_id AS lead_id
         FROM sales.assignment a
        WHERE a.tenant_id = $1
          AND a.entity_kind = 'lead'
          AND a.released_at IS NULL
     ) u
     LEFT JOIN sales.lead    l   ON l.id = u.lead_id    AND l.tenant_id = $1
     LEFT JOIN sales.meeting m   ON m.lead_id = l.id    AND m.tenant_id = $1
     LEFT JOIN sales.message msg ON msg.lead_id = l.id  AND msg.tenant_id = $1
     LEFT JOIN sales.revenue_record rr
            ON rr.client_lead_id = l.id AND rr.tenant_id = $1
     GROUP BY u.user_id`,
    [tenantId, date, ROLLUP_VERSION],
  );
  return rowCount;
}

// -----------------------------------------------------------------------------
// resolvePeriodRange(period, today) — returns { from, to } as ISO YYYY-MM-DD.
// `from` is inclusive, `to` is exclusive (the partial today bucket).
// -----------------------------------------------------------------------------
export function resolvePeriodRange(period, today = new Date()) {
  const days = period === 'week'    ? 7
             : period === 'month'   ? 30
             : period === 'quarter' ? 90
             : period === 'year'    ? 365
             : 30;
  const end = new Date(today); end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - (days - 1));
  return {
    from:  start.toISOString().slice(0, 10),
    today: end.toISOString().slice(0, 10),
    days,
  };
}
