// =============================================================================
// /api/v1/crm/projects/:id/scans — scan request + result ingestion (P1/P2).
// -----------------------------------------------------------------------------
// A "scan" is a request to (re)survey a project's AOI for leak indicators. This
// module makes the request → process → persist → attribute loop real:
//
//   POST   /crm/projects/:id/scans     request a scan (perm: crm.project.scan)
//   GET    /crm/projects/:id/scans     list scans for a project
//   GET    /crm/projects/:id/scans/:sid one scan
//   GET    /crm/projects/:id/detections persisted detections for a project
//
// On request, we snapshot the project AOI, create a crm.scan row, pull the
// current indicators for that AOI from the configured source (gateway →
// AlphaGeoCore via the existing /api/leaks/by-bbox relay), upsert them into
// crm.detection attributed to the project + scan, and complete the scan with a
// result summary. The synchronous gateway pull is the first increment; a future
// async AlphaGeoStudio job can replace the fetch while keeping this contract.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { ok, created, badReq, notFound, send } from '../http.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { recordAudit } from '../audit.mjs';
import { emitActivity } from '../lib/activity.mjs';
import { fetchGatewayLeaks, upsertDetections } from './ingest-core.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCAN_COLS = `id, tenant_id, classification, project_id, source, status,
                   aoi_west, aoi_south, aoi_east, aoi_north, sub_project_id,
                   gateway_job_id, result_summary, error,
                   requested_by, requested_at, started_at, completed_at,
                   created_at, updated_at`;

const DETECTION_COLS = `id, tenant_id, classification, scan_id, project_id, external_id,
                        verification_result, leak_type, severity, status,
                        score, era_score, risk_score, investigation_priority,
                        lat, lon, integrity_mode, is_reference, dispatchable, tier,
                        integrity_note, props, detected_at, created_at, updated_at`;

// ---- helpers ---------------------------------------------------------------
async function loadProject(req, id) {
  return withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, leak_source, sub_project_id,
              aoi_west, aoi_south, aoi_east, aoi_north
         FROM crm.project WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  });
}

// ---- LIST -------------------------------------------------------------------
export async function list(req, res, projectId) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${SCAN_COLS} FROM crm.scan WHERE project_id = $1
        ORDER BY requested_at DESC LIMIT 100`, [projectId]);
    return r.rows;
  });
  ok(res, rows);
}

// ---- GET ONE ----------------------------------------------------------------
export async function get(req, res, projectId, scanId) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(projectId) || !UUID_RE.test(scanId)) return badReq(res, 'invalid_id');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${SCAN_COLS} FROM crm.scan WHERE id = $1 AND project_id = $2`,
      [scanId, projectId]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

// ---- LIST DETECTIONS --------------------------------------------------------
export async function listDetections(req, res, projectId) {
  if (!requirePermission(req, res, 'crm.project.read')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${DETECTION_COLS} FROM crm.detection WHERE project_id = $1
        ORDER BY investigation_priority DESC NULLS LAST, score DESC NULLS LAST
        LIMIT 5000`, [projectId]);
    return r.rows;
  });
  ok(res, rows);
}

// ---- CREATE (request a scan) ------------------------------------------------
export async function create(req, res, projectId) {
  if (!requirePermission(req, res, 'crm.project.scan')) return;
  if (!UUID_RE.test(projectId)) return badReq(res, 'invalid_project_id');

  const project = await loadProject(req, projectId);
  if (!project) return notFound(res);
  if (project.aoi_west == null || project.aoi_north == null) {
    return send(res, 422, { success: false, error: 'no_aoi',
      detail: 'Project has no AOI; set aoi_west/south/east/north before requesting a scan.' });
  }
  const source = project.leak_source === 'bundled' ? 'bundled' : 'gateway';

  // 1) Open the scan row (running).
  const scan = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO crm.scan
         (tenant_id, project_id, source, status,
          aoi_west, aoi_south, aoi_east, aoi_north, sub_project_id,
          requested_by, started_at)
       VALUES ($1,$2,$3,'running',$4,$5,$6,$7,$8,$9, now())
       RETURNING ${SCAN_COLS}`,
      [req.tenant.id, projectId, source,
       project.aoi_west, project.aoi_south, project.aoi_east, project.aoi_north,
       project.sub_project_id, req.user?.sub && UUID_RE.test(req.user.sub) ? req.user.sub : null]);
    return r.rows[0];
  });

  // 2) Pull + persist indicators. Gateway is the live source today.
  let summary = { detections: 0, confirmed: 0, suspected: 0 };
  let failure = null;
  try {
    if (source === 'gateway') {
      const fc = await fetchGatewayLeaks(project);
      const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
      summary = await withTenantConn(req, (client) =>
        upsertDetections(client, { tenantId: req.tenant.id, scanId: scan.id, projectId, features: feats }));
    } else {
      // Bundled source — persisted detections come from the in-repo dataset; the
      // dashboard already serves these. Mark complete with 0 new gateway rows.
      summary = { detections: 0, confirmed: 0, suspected: 0, note: 'bundled source' };
    }
  } catch (e) {
    failure = String(e?.message ?? e);
  }

  // 3) Close out the scan.
  const finished = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `UPDATE crm.scan SET status = $2, result_summary = $3, error = $4,
              completed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING ${SCAN_COLS}`,
      [scan.id, failure ? 'failed' : 'complete', JSON.stringify(summary), failure]);
    return r.rows[0];
  });

  recordAudit({
    req, action: 'crm.scan.request', resource: 'crm.scan', resourceId: scan.id,
    payload: { project_id: projectId, source, summary, error: failure },
  });
  emitActivity({
    tenantId: req.tenant.id, entityKind: 'lead', entityId: projectId,
    kind: 'system', source: 'system',
    actorId: req.user?.sub ?? null, actorLabel: req.user?.email ?? null,
    text: failure ? `Scan failed: ${failure}` : `Scan complete — ${summary.detections} indicators`,
    metadata: { action: 'scan.request', project_id: projectId, scan_id: scan.id },
  }).catch(() => {});

  if (failure) return send(res, 502, { success: false, error: 'scan_failed', detail: failure, data: finished });
  created(res, finished);
}
