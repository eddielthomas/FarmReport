// =============================================================================
// /api/v1/farm/reports/schedule — automated report runs (the automation layer).
// -----------------------------------------------------------------------------
//   POST   /farm/reports/schedule   {farm_id?, report_type, cadence, recipients[]}
//   GET    /farm/reports/schedules
//   DELETE /farm/reports/schedule/:id
//
// startReportScheduler() runs an in-process worker (mirrors startAlphaGeoIngest):
// each interval it finds due active schedules and GENERATES the report through
// the SAME path as the on-demand endpoint (reports.mjs buildAndStoreReport), then
// advances next_run_at by cadence. This is Report.Farm's "watch the farm, ship
// scheduled reports on its own" thesis — the render mechanism can later delegate
// to Meridian Studio without changing the schedule/trigger surface.
//
// Delivery: the generated report lands in farm.report (visible via GET
// /farm/reports). Wiring the recipients to the email outbox is the last mile
// (marked below) — generation-on-schedule is the automation core.
// =============================================================================

import { pool, withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { farmGate, UUID_RE } from './gate.mjs';
import { buildAndStoreReport } from './reports.mjs';

const CADENCE = { daily: '1 day', weekly: '7 days', monthly: '1 month' };
const KINDS = new Set(['field', 'executive-monthly']);
const SCHED_SELECT =
  'id, farm_id, report_type, cadence, recipients, active, next_run_at, last_run_at, created_at';

// POST /farm/reports/schedule
export async function create(req, res) {
  if (!farmGate(req, res, 'farm.report.generate', 'report:generate')) return;
  const body = (await readBody(req)) || {};
  const kind = body.report_type ?? 'field';
  const cadence = body.cadence;
  const farmId = body.farm_id ?? null;
  if (!KINDS.has(kind)) return badReq(res, 'invalid_report_type');
  if (!CADENCE[cadence]) return badReq(res, 'invalid_cadence');
  if (farmId && !UUID_RE.test(String(farmId))) return badReq(res, 'invalid_farm_id');
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter((x) => typeof x === 'string' && x.includes('@')).slice(0, 50) : [];
  const createdBy = UUID_RE.test(String(req.user?.sub ?? '')) ? req.user.sub : null;

  const row = await withTenantConn(req, async (c) => {
    const r = await c.query(
      `INSERT INTO farm.report_schedule
         (tenant_id, farm_id, report_type, cadence, recipients, created_by, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING ${SCHED_SELECT}`,
      [req.tenant.id, farmId, kind, cadence, recipients, createdBy]);
    return r.rows[0];
  });
  recordAudit({ req, action: 'farm.report.schedule.create', resource: 'farm.report_schedule', resourceId: row.id, payload: { kind, cadence } });
  created(res, row);
}

// GET /farm/reports/schedules
export async function list(req, res) {
  if (!farmGate(req, res, 'farm.report.read', 'farm:view')) return;
  const rows = await withTenantConn(req, async (c) => {
    const r = await c.query(
      `SELECT ${SCHED_SELECT} FROM farm.report_schedule
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.tenant.id]);
    return r.rows;
  });
  ok(res, rows);
}

// DELETE /farm/reports/schedule/:id
export async function remove(req, res, id) {
  if (!farmGate(req, res, 'farm.report.generate', 'report:generate')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_id');
  const n = await withTenantConn(req, async (c) => {
    const r = await c.query('DELETE FROM farm.report_schedule WHERE id = $1', [id]);
    return r.rowCount;
  });
  if (!n) return notFound(res);
  recordAudit({ req, action: 'farm.report.schedule.delete', resource: 'farm.report_schedule', resourceId: id });
  ok(res, { deleted: true });
}

// ---- WORKER ----------------------------------------------------------------
// Cross-tenant. farm.report_schedule is FORCE-RLS (scoped to app.tenant_id), so a
// bare pool read returns nothing. We enumerate tenants (iam.tenant, pre-RLS) and,
// per tenant, SET LOCAL app.tenant_id inside a tx so every read passes the policy.
export async function runDueSchedules() {
  let tenants;
  try {
    const t = await pool.query('SELECT id FROM iam.tenant');
    tenants = t.rows;
  } catch {
    return 0; // registry not readable / not migrated yet — no-op quietly
  }
  let processed = 0;
  for (const t of tenants) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', t.id]);
      const due = await client.query(
        `SELECT ${SCHED_SELECT} FROM farm.report_schedule
          WHERE active AND next_run_at <= now() ORDER BY next_run_at LIMIT 25`);
      for (const s of due.rows) {
        if (s.farm_id) {
          try {
            await buildAndStoreReport(client, {
              tenantId: t.id, farmId: s.farm_id, kind: s.report_type,
              period: null, generatedBy: null, trigger: 'scheduled',
            });
          } catch (e) { console.warn('[report-scheduler] generate failed', s.id, e?.message ?? e); }
        }
        // TODO(delivery): enqueue `s.recipients` to the email outbox (131_email_outbox).
        await client.query(
          'UPDATE farm.report_schedule SET last_run_at = now(), next_run_at = now() + $2::interval WHERE id = $1',
          [s.id, CADENCE[s.cadence] ?? '1 day']);
        processed++;
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      console.warn('[report-scheduler] tenant', t.id, e?.message ?? e);
    } finally {
      client.release();
    }
  }
  return processed;
}

let timer = null;
export function startReportScheduler() {
  if (process.env.REPORT_SCHEDULER_ENABLED === '0') { console.log('[report-scheduler] disabled (REPORT_SCHEDULER_ENABLED=0)'); return; }
  const everyMs = Math.max(15000, Number(process.env.REPORT_SCHEDULER_INTERVAL_MS || 60000));
  const tick = async () => {
    try { const n = await runDueSchedules(); if (n) console.log(`[report-scheduler] ran ${n} due schedule(s)`); }
    catch (e) { console.warn('[report-scheduler] tick failed', e?.message ?? e); }
  };
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref(); // never hold the process open
  console.log(`[report-scheduler] started (every ${Math.round(everyMs / 1000)}s)`);
}
