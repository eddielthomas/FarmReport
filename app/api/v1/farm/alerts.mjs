// =============================================================================
// /api/v1/farm/alerts — operator-facing farm alerts (Wave-2 Lane 2).
// -----------------------------------------------------------------------------
//   GET  /farm/alerts?farm_id&status   list farm.alert (tenant-scoped)
//   POST /farm/alerts/:id/ack          transition an open alert → ack
//
// Like observations, alerts are only ever produced from real derived signals, so
// this list is honestly empty until the P2 ingest + rollup worker runs.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { ok, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { farmGate, UUID_RE } from './gate.mjs';

const ALERT_SELECT = `
  id, tenant_id, farm_id, zone_id, derived_signal_id,
  severity, category, title, summary, evidence, confidence,
  estimated_impact, recommended_actions, channels, status, dedup_key,
  created_at, updated_at`;

const VALID_STATUS = new Set(['open', 'ack', 'resolved', 'suppressed']);

export async function list(req, res) {
  if (!farmGate(req, res, 'farm.alert.read', 'farm:view')) return;
  const qs = new URL(req.url, 'http://x').searchParams;
  const farmId = qs.get('farm_id');
  const status = qs.get('status');
  if (farmId && !UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');

  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (farmId) { params.push(farmId); where += ` AND farm_id = $${params.length}`; }
  if (status && VALID_STATUS.has(status)) {
    params.push(status); where += ` AND status = $${params.length}`;
  }

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${ALERT_SELECT} FROM farm.alert
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 500`, params);
    return r.rows;
  });
  ok(res, rows);
}

// POST /farm/alerts/:id/ack — open → ack. Idempotent-ish: acking an already-ack
// alert returns it unchanged; acking a resolved/suppressed one is a 409.
export async function ack(req, res, id) {
  if (!farmGate(req, res, 'farm.alert.manage', 'alert:manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_alert_id');

  const outcome = await withTenantConn(req, async (client) => {
    const cur = await client.query(
      `SELECT ${ALERT_SELECT} FROM farm.alert WHERE id = $1`, [id]);
    if (cur.rows.length === 0) return { kind: 'not_found' };
    const before = cur.rows[0];
    if (before.status === 'resolved' || before.status === 'suppressed') {
      return { kind: 'conflict', status: before.status };
    }
    const r = await client.query(
      `UPDATE farm.alert SET status = 'ack', updated_at = now()
        WHERE id = $1 RETURNING ${ALERT_SELECT}`, [id]);
    return { kind: 'ok', before, after: r.rows[0] };
  });

  if (outcome.kind === 'not_found') return notFound(res);
  if (outcome.kind === 'conflict') {
    return send(res, 409, { success: false, error: 'invalid_status_transition',
      detail: { from: outcome.status, to: 'ack' } });
  }
  recordAudit({ req, action: 'farm.alert.ack', resource: 'farm.alert',
    resourceId: id, payload: { from: outcome.before.status, to: 'ack' } });
  ok(res, outcome.after);
}
