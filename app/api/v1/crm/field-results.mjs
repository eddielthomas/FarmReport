// =============================================================================
// /api/v1/crm/detections/:did/field-results — field verification post-back (P5).
// -----------------------------------------------------------------------------
// Closes the loop a scan opens. A persisted leak indicator (crm.detection) is
// sent to the field; a tech posts results back here, which:
//   1) records the finding in crm.field_result (outcome, measurements, notes,
//      photo evidence, optional field.job handle), and
//   2) graduates the detection's status:
//        outcome 'false_positive' | 'no_leak'  → detection 'false_positive'
//        otherwise ('confirmed_leak'|'repaired')→ detection 'verified'.
//
//   POST /crm/detections/:did/field-results   post a field result (perm: crm.detection.verify)
//   GET  /crm/detections/:did/field-results   list field results for a detection (perm: crm.project.read)
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_OUTCOMES = new Set(['confirmed_leak','no_leak','false_positive','repaired']);

const FIELD_RESULT_COLS = `id, tenant_id, classification, detection_id, project_id,
                           field_job_id, outcome, measurements, notes, photo_urls,
                           verified_by, verified_at, created_at`;

// Outcome → resulting detection status.
function detectionStatusFor(outcome) {
  return (outcome === 'false_positive' || outcome === 'no_leak') ? 'false_positive' : 'verified';
}

// ---- LIST -------------------------------------------------------------------
export async function list(req, res, detectionId) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(detectionId)) return badReq(res, 'invalid_detection_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${FIELD_RESULT_COLS} FROM crm.field_result WHERE detection_id = $1
        ORDER BY verified_at DESC LIMIT 500`, [detectionId]);
    return r.rows;
  });
  ok(res, rows);
}

// ---- CREATE (post a field result) ------------------------------------------
export async function create(req, res, detectionId) {
  if (!requirePermission(req, res, 'crm.detection.verify')) return;
  if (!UUID_RE.test(detectionId)) return badReq(res, 'invalid_detection_id');

  const body = (await readBody(req)) || {};
  const outcome = body.outcome;
  if (!VALID_OUTCOMES.has(outcome)) return badReq(res, 'invalid_outcome');

  const fieldJobId = body.field_job_id ?? null;
  if (fieldJobId != null && !UUID_RE.test(String(fieldJobId))) {
    return badReq(res, 'invalid_field_job_id');
  }
  const measurements = (body.measurements && typeof body.measurements === 'object')
    ? body.measurements : {};
  const notes = typeof body.notes === 'string' ? body.notes : null;
  const photoUrls = Array.isArray(body.photo_urls)
    ? body.photo_urls.filter((u) => typeof u === 'string') : [];

  // Load the detection to confirm it exists + grab its project_id.
  const detection = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, project_id FROM crm.detection WHERE id = $1`, [detectionId]);
    return r.rows[0] ?? null;
  });
  if (!detection) return notFound(res);

  const projectId = detection.project_id;
  const newStatus = detectionStatusFor(outcome);
  const verifiedBy = req.user?.sub && UUID_RE.test(String(req.user.sub)) ? req.user.sub : null;

  const result = await withTenantConn(req, async (client) => {
    const ins = await client.query(
      `INSERT INTO crm.field_result
         (tenant_id, detection_id, project_id, field_job_id, outcome,
          measurements, notes, photo_urls, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
       RETURNING ${FIELD_RESULT_COLS}`,
      [req.tenant.id, detectionId, projectId, fieldJobId, outcome,
       JSON.stringify(measurements), notes, photoUrls, verifiedBy]);

    await client.query(
      `UPDATE crm.detection SET status = $2, updated_at = now() WHERE id = $1`,
      [detectionId, newStatus]);

    return ins.rows[0];
  });

  recordAudit({
    req, action: 'crm.detection.verify', resource: 'crm.detection', resourceId: detectionId,
    payload: { project_id: projectId, outcome, detection_status: newStatus,
               field_result_id: result.id, field_job_id: fieldJobId },
  });
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: projectId,
    kind: 'status_change', source: 'system',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: `Field result: ${outcome} — detection ${newStatus}`,
    metadata: { action: 'detection.field_result', detection_id: detectionId,
                outcome, detection_status: newStatus, field_result_id: result.id },
  }).catch(() => {});

  created(res, { field_result: result, detection_status: newStatus });
}
