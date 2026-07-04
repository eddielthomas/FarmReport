// =============================================================================
// /api/v1/org/rollup.mjs — Sprint A5.2 (ADR-0024) org oversight roll-up.
// -----------------------------------------------------------------------------
// The State sees the FOREST, never the trees.
//
// Two paths live here:
//
//   1. refreshOrgRollup(orgId)  — the PUBLISH path. For each district (tenant)
//      under the org we open a DISTRICT-tenant-scoped connection (withTenantConn
//      sets rwr.tenant_id to that district, so RLS gates the read to that
//      district's OWN rows) and compute a small set of pre-aggregated metrics
//      per bucket_date. Only AGGREGATES — never row ids / PII — are UPSERTed into
//      analytics.org_rollup, each tagged with a classification. Modeled here as a
//      synchronous refresh; a real deployment moves this to the ADR-0019
//      transactional outbox (each district publishes on its own write path).
//
//   2. The OVERSIGHT READ path — reads ONLY analytics.org_rollup, filtered by
//      org_id + window + the caller's classification ceiling. It sets NO district
//      tenant GUC and touches NO district business table. (See readRollup below —
//      the single `FROM analytics.org_rollup`.)
//
// Endpoints:
//   POST /api/v1/org/rollup/refresh  — refresh the caller's org (org.rollup.view)
//   GET  /api/v1/org/rollup          — read the caller's org roll-up (org.rollup.view)
//
// Both are gated by the org claim + org.rollup.view. Org-less callers → 403,
// so the org_id IS NULL path is byte-identical to pre-A5.2.
// =============================================================================

import { q, withTenantConn } from '../db/pool.mjs';
import { ok, forbid, badReq } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

// Bell-LaPadula lattice (low → high). The oversight read returns only aggregates
// whose classification is AT OR BELOW the caller's ceiling.
const CLASS_ORDER = { public: 0, internal: 1, confidential: 2, secret: 3 };

// The metrics each district publishes. Kept deliberately small; all are counts
// or sums — aggregates only, never row identity.
//   leads      — total leads in the district
//   clients    — leads in the 'Client' lifecycle state
//   open_cases — ops cases not yet closed
//   revenue    — booked revenue (sum)
// All published at classification 'internal' (the default oversight tier). The
// classification tag is what the read path caps against the caller's clearance.
const PUBLISH_CLASSIFICATION = 'internal';

// ---- org claim / gate helpers ----------------------------------------------

// The caller's org id from the additive A5.1 org claim, or null.
function callerOrgId(req) {
  return req?.user?.org?.org_id ?? null;
}

// Gate: requires the org claim AND the org.rollup.view permission (hydrated into
// req.user.permissions by policy.mjs from the org role bundle). Writes 403 and
// returns false on miss. Org-less callers are refused here.
function requireOrgRollup(req, res) {
  const orgId = callerOrgId(req);
  if (!orgId) { forbid(res, 'org_claim_required'); return null; }
  const perms = req?.user?.permissions;
  const allowed = perms && (perms.has('org.rollup.view') || perms.has('platform.admin.all'));
  if (!allowed) { forbid(res, 'missing_permission:org.rollup.view'); return null; }
  return orgId;
}

// The caller's classification ceiling: the highest tier they may see in the
// roll-up. Driven by clearance; org roles can only narrow, never widen. A
// state.auditor/admin sees up to their clearance; default 'internal'.
function callerClassificationCeiling(req) {
  const clr = req?.user?.clearance;
  if (clr && clr in CLASS_ORDER) return clr;
  return 'internal';
}

// =============================================================================
// PUBLISH PATH — refreshOrgRollup(orgId)
// -----------------------------------------------------------------------------
// NOTE (ADR-0019): a real deployment moves per-district publication to the
// transactional outbox — each district emits its aggregates on its own write
// path and the org store is updated asynchronously. This MVP does it
// synchronously: we iterate the org's districts and recompute each in turn.
// =============================================================================
export async function refreshOrgRollup(orgId) {
  // Discover the org's districts (child tenants). This is an org-tier read
  // against iam.tenant — NOT a business-row read, and it sets no district GUC.
  const { rows: districts } = await q(
    `SELECT id, slug FROM iam.tenant WHERE org_id = $1 ORDER BY slug`,
    [orgId],
  );

  let districtsRefreshed = 0;
  let rowsWritten = 0;

  for (const d of districts) {
    // A synthetic request whose tenant is THIS district. withTenantConn binds
    // rwr.tenant_id (+ legacy app.tenant_id) to the district, so every SELECT
    // below is RLS-scoped to that district's OWN rows. The oversight read path
    // NEVER does this — only the publish path sets a district GUC.
    const districtReq = { tenant: { id: d.id }, user: {}, requestId: undefined };

    const written = await withTenantConn(districtReq, async (client) => {
      // Compute the small aggregate set per bucket_date FROM THIS DISTRICT'S
      // OWN rows. Prefer analytics.daily_tenant_metrics (the S2B rollup) when
      // present; fall back to live counts. Each query is wrapped in a SAVEPOINT
      // so a schema variance in one source yields an empty section rather than
      // poisoning the transaction.
      const buckets = await computeDistrictAggregates(client);

      let n = 0;
      for (const b of buckets) {
        for (const [metric, value] of Object.entries(b.metrics)) {
          // UPSERT — aggregates ONLY. Keyed by
          // (org_id, district_id, bucket_date, metric, classification).
          // No row ids, no PII ever land in analytics.org_rollup.
          await client.query(
            `INSERT INTO analytics.org_rollup
               (org_id, district_id, bucket_date, metric, value, classification, refreshed_at)
             VALUES ($1, $2, $3::date, $4, $5, $6, now())
             ON CONFLICT (org_id, district_id, bucket_date, metric, classification)
             DO UPDATE SET value = EXCLUDED.value, refreshed_at = now()`,
            [orgId, d.id, b.bucket_date, metric, value, PUBLISH_CLASSIFICATION],
          );
          n++;
        }
      }
      return n;
    });

    rowsWritten += written;
    districtsRefreshed++;
  }

  return { districtsRefreshed, rowsWritten };
}

// Compute the per-bucket aggregate set for the district bound to `client`.
// Returns [{ bucket_date: 'YYYY-MM-DD', metrics: { leads, clients, open_cases,
// revenue } }]. Reads ONLY this district's own rows (RLS-bound by the caller's
// GUC). SAVEPOINT-guarded so a missing source table degrades gracefully.
async function computeDistrictAggregates(client) {
  // 1) Prefer the S2B daily rollup if it carries rows for this district.
  const daily = await safe(client,
    `SELECT to_char(bucket_date,'YYYY-MM-DD') AS bucket_date,
            total_leads, total_active_clients, total_revenue
       FROM analytics.daily_tenant_metrics
      ORDER BY bucket_date DESC
      LIMIT 90`);

  if (daily.length > 0) {
    // open_cases is not in daily_tenant_metrics → snapshot it against today.
    const openCases = firstNum(await safe(client,
      `SELECT count(*)::numeric AS n FROM ops.case WHERE status <> 'closed'`));
    return daily.map((r, i) => ({
      bucket_date: r.bucket_date,
      metrics: {
        leads:      num(r.total_leads),
        clients:    num(r.total_active_clients),
        revenue:    num(r.total_revenue),
        // Attribute the current open-case snapshot to the latest bucket only.
        open_cases: i === 0 ? openCases : 0,
      },
    }));
  }

  // 2) Fallback — compute a single "today" bucket from live counts.
  const today = new Date().toISOString().slice(0, 10);
  const leads = firstNum(await safe(client,
    `SELECT count(*)::numeric AS n FROM sales.lead`));
  const clients = firstNum(await safe(client,
    `SELECT count(*)::numeric AS n FROM sales.lead WHERE status = 'Client'`));
  const openCases = firstNum(await safe(client,
    `SELECT count(*)::numeric AS n FROM ops.case WHERE status <> 'closed'`));
  const revenue = firstNum(await safe(client,
    `SELECT coalesce(sum(total_revenue),0)::numeric AS n FROM sales.lead`));

  return [{
    bucket_date: today,
    metrics: { leads, clients, open_cases: openCases, revenue },
  }];
}

// SAVEPOINT-guarded query: returns rows, or [] if the source table/column is
// absent. Keeps the surrounding withTenantConn transaction alive on a miss.
async function safe(client, sql, params = []) {
  await client.query('SAVEPOINT org_rollup_sp');
  try {
    const r = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT org_rollup_sp');
    return r.rows;
  } catch (_e) {
    try { await client.query('ROLLBACK TO SAVEPOINT org_rollup_sp'); } catch (_e2) { /* noop */ }
    return [];
  }
}

const num = (v) => (v == null ? 0 : Number(v));
const firstNum = (rows) => num(rows[0]?.n);

// =============================================================================
// HTTP — POST /api/v1/org/rollup/refresh
// -----------------------------------------------------------------------------
// Refresh the caller's org roll-up. Gated by the org claim + org.rollup.view.
// Emits recordAudit({ action: 'org.rollup.refresh' }).
// =============================================================================
export async function refresh(req, res) {
  const orgId = requireOrgRollup(req, res);
  if (!orgId) return;

  const result = await refreshOrgRollup(orgId);

  recordAudit({
    req,
    action: 'org.rollup.refresh',
    resource: 'analytics.org_rollup',
    resourceId: orgId,
    payload: {
      org_id: orgId,
      districts_refreshed: result.districtsRefreshed,
      rows_written: result.rowsWritten,
    },
  });

  ok(res, {
    org_id: orgId,
    districts_refreshed: result.districtsRefreshed,
    rows_written: result.rowsWritten,
  });
}

// =============================================================================
// HTTP — GET /api/v1/org/rollup?from=&to=&metric=
// -----------------------------------------------------------------------------
// THE OVERSIGHT READ. Reads ONLY analytics.org_rollup, filtered by the caller's
// org_id + window + the caller's classification ceiling. It sets NO district
// tenant GUC and queries NO district business table. The single `FROM
// analytics.org_rollup` below is the load-bearing acceptance criterion: the
// State sees the FOREST (pre-aggregated roll-ups), never the trees (raw rows).
// =============================================================================
export async function readRollup(req, res) {
  const orgId = requireOrgRollup(req, res);
  if (!orgId) return;

  const url = new URL(req.url, 'http://x');
  const from   = parseDate(url.searchParams.get('from'));
  const to     = parseDate(url.searchParams.get('to'));
  const metric = sanitizeMetric(url.searchParams.get('metric'));

  // Classification ceiling — the caller only ever receives aggregates AT OR
  // BELOW their clearance tier. Expanded to the permitted tier list so the
  // filter is a simple `classification = ANY($..)`.
  const ceiling = callerClassificationCeiling(req);
  const ceilingRank = CLASS_ORDER[ceiling];
  const permittedClasses = Object.keys(CLASS_ORDER).filter(
    (k) => CLASS_ORDER[k] <= ceilingRank,
  );

  // ---- the ONLY query: a single read of the pre-aggregated org-tier store ----
  // No district GUC is set; no district business table is touched. Aggregates
  // only (district_id, bucket_date, metric, value, classification) — no row ids,
  // no PII. This is the entire data surface of the oversight read.
  const params = [orgId, permittedClasses];
  const filters = [
    'org_id = $1',
    'classification = ANY($2::text[])',
  ];
  if (from)   { params.push(from);   filters.push(`bucket_date >= $${params.length}::date`); }
  if (to)     { params.push(to);     filters.push(`bucket_date <= $${params.length}::date`); }
  if (metric) { params.push(metric); filters.push(`metric = $${params.length}`); }

  const { rows } = await q(
    `SELECT district_id, bucket_date, metric, value, classification
       FROM analytics.org_rollup
      WHERE ${filters.join(' AND ')}
      ORDER BY bucket_date DESC, district_id, metric`,
    params,
  );

  // Shape: per-district series + an org-total series. Pure projection over the
  // aggregates already read — still no raw rows.
  const byDistrict = new Map();   // district_id → { district_id, series: [...] }
  const totals = new Map();       // `${bucket_date}|${metric}` → summed value

  for (const r of rows) {
    const bucket = typeof r.bucket_date === 'string'
      ? r.bucket_date
      : r.bucket_date.toISOString().slice(0, 10);
    const value = Number(r.value);

    if (!byDistrict.has(r.district_id)) {
      byDistrict.set(r.district_id, { district_id: r.district_id, series: [] });
    }
    byDistrict.get(r.district_id).series.push({
      bucket_date: bucket,
      metric: r.metric,
      value,
      classification: r.classification,
    });

    const key = `${bucket}|${r.metric}`;
    totals.set(key, (totals.get(key) ?? 0) + value);
  }

  const orgTotalSeries = Array.from(totals.entries())
    .map(([key, value]) => {
      const [bucket_date, metric] = key.split('|');
      return { bucket_date, metric, value };
    })
    .sort((a, b) =>
      b.bucket_date.localeCompare(a.bucket_date) || a.metric.localeCompare(b.metric));

  ok(res, {
    org_id: orgId,
    classification_ceiling: ceiling,
    window: { from: from ?? null, to: to ?? null },
    metric: metric ?? null,
    districts: Array.from(byDistrict.values()),
    org_total: orgTotalSeries,
  });
}

// ---- small input sanitizers -------------------------------------------------
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v) {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return null;
  return v;
}
// Metric names are lowercase identifiers; reject anything else (defence in depth
// even though the value is parameterized).
function sanitizeMetric(v) {
  if (typeof v !== 'string') return null;
  return /^[a-z_]{1,40}$/.test(v) ? v : null;
}
