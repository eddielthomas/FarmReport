// =============================================================================
// ingest-alphageo.mjs — automatic AlphaGeo (gateway) → crm.detection ingest.
// -----------------------------------------------------------------------------
// Keeps the persisted detection spine fresh without anyone clicking "Request
// scan": on boot (after a short delay) and on an interval, pull the current
// indicators for every gateway-backed project AOI and upsert them into
// crm.detection, attributed to a system scan row.
//
// Enabled with ALPHAGEO_AUTO_INGEST=1 (recommended on prod where the gateway is
// reachable). Interval via ALPHAGEO_INGEST_INTERVAL_MIN (default 30). Off by
// default so local/dev (no gateway egress) doesn't spam failed scans.
//
// Cross-tenant project discovery uses the owner pool connection (the migration
// role owns crm.* and bypasses RLS for the SELECT); each project's upsert runs
// in its own tx with the tenant GUC bound so the WITH CHECK policy is satisfied
// even where RLS is enforced.
// =============================================================================

import { pool } from './v1/db/pool.mjs';
import { fetchGatewayLeaks, upsertDetections } from './v1/crm/ingest-core.mjs';

const ENABLED  = process.env.ALPHAGEO_AUTO_INGEST === '1';
const INTERVAL_MS = Math.max(5, Number(process.env.ALPHAGEO_INGEST_INTERVAL_MIN ?? 30)) * 60_000;
const BOOT_DELAY_MS = 20_000;  // let the HTTP server + relay come up first

async function listGatewayProjects() {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, sub_project_id,
            aoi_west, aoi_south, aoi_east, aoi_north
       FROM crm.project
      WHERE leak_source = 'gateway'
        AND status <> 'archived'
        AND aoi_west IS NOT NULL AND aoi_north IS NOT NULL`);
  return rows;
}

// Ingest one project in its own tenant-bound transaction. Returns a summary.
async function ingestOne(project) {
  const fc = await fetchGatewayLeaks(project);     // may throw (gateway down)
  const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('rwr.tenant_id', $1, true),
              set_config('app.clearance', 'secret', true)`,
      [String(project.tenant_id)]);
    // Open a system scan row, ingest, close it out — same shape as a manual scan.
    const scanRes = await client.query(
      `INSERT INTO crm.scan (tenant_id, project_id, source, status,
                             aoi_west, aoi_south, aoi_east, aoi_north, sub_project_id, started_at)
       VALUES ($1,$2,'gateway','running',$3,$4,$5,$6,$7, now()) RETURNING id`,
      [project.tenant_id, project.id, project.aoi_west, project.aoi_south,
       project.aoi_east, project.aoi_north, project.sub_project_id]);
    const scanId = scanRes.rows[0].id;
    const summary = await upsertDetections(client, {
      tenantId: project.tenant_id, scanId, projectId: project.id, features: feats });
    await client.query(
      `UPDATE crm.scan SET status='complete', result_summary=$2, completed_at=now(), updated_at=now()
        WHERE id=$1`, [scanId, JSON.stringify({ ...summary, auto: true })]);
    await client.query('COMMIT');
    return summary;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

let running = false;
export async function runAlphaGeoIngest() {
  if (running) return { skipped: 'already_running' };
  running = true;
  const started = Date.now();
  let projects = [];
  try { projects = await listGatewayProjects(); }
  catch (e) { running = false; console.warn('[alphageo-ingest] project list failed:', e?.message ?? e); return { error: 'list_failed' }; }

  let ok = 0, failed = 0, total = 0;
  for (const p of projects) {
    try { const s = await ingestOne(p); ok++; total += s.detections; }
    catch (e) { failed++; console.warn(`[alphageo-ingest] project ${p.id} failed:`, e?.message ?? e); }
  }
  running = false;
  const out = { projects: projects.length, ok, failed, detections: total, ms: Date.now() - started };
  console.log('[alphageo-ingest] cycle', JSON.stringify(out));
  return out;
}

// Wire the scheduler. No-op unless ALPHAGEO_AUTO_INGEST=1.
export function startAlphaGeoIngest() {
  if (!ENABLED) { console.log('[alphageo-ingest] disabled (set ALPHAGEO_AUTO_INGEST=1 to enable)'); return; }
  console.log(`[alphageo-ingest] enabled — first run in ${BOOT_DELAY_MS / 1000}s, every ${INTERVAL_MS / 60000}min`);
  setTimeout(() => { runAlphaGeoIngest().catch(() => {}); }, BOOT_DELAY_MS);
  setInterval(() => { runAlphaGeoIngest().catch(() => {}); }, INTERVAL_MS);
}
