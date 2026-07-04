// =============================================================================
// ingest-asterra.mjs — automatic ASTERRA Recover API → crm.detection ingest.
// -----------------------------------------------------------------------------
// Mirror of api/ingest-alphageo.mjs, but the upstream is the ASTERRA Recover
// API instead of the AlphaGeoCore gateway. For every project whose
// leak_source='asterra' (and that carries an asterra_project_id), we log in to
// Recover, iterate the project's POIs (leak polygons), map each to the shared
// gateway-feature shape, and upsert them into crm.detection attributed to a
// system scan row (source='asterra').
//
// DORMANT BY DEFAULT. The scheduler is a no-op unless BOTH:
//   * ASTERRA_AUTO_INGEST=1, AND
//   * ASTERRA_USERNAME + ASTERRA_PASSWORD are set (asterraConfigured()).
// Interval via ASTERRA_INGEST_INTERVAL_MIN (default 60).
//
// Cross-tenant project discovery uses the owner pool (migration role owns crm.*
// and bypasses RLS for the SELECT); each project's upsert runs in its own tx
// with the tenant GUC bound so the WITH CHECK policy is satisfied.
// =============================================================================

import { pool } from './v1/db/pool.mjs';
import { upsertDetections } from './v1/crm/ingest-core.mjs';
import { AsterraClient, asterraConfigured } from './asterra-client.mjs';

const ENABLED  = process.env.ASTERRA_AUTO_INGEST === '1';
const INTERVAL_MS = Math.max(5, Number(process.env.ASTERRA_INGEST_INTERVAL_MIN ?? 60)) * 60_000;
const BOOT_DELAY_MS = 25_000;  // let the HTTP server come up first (after alphageo)

// Coerce a numeric-ish value to a Number or null (handles '', null, strings).
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalise a POI geometry to a MultiPolygon so the detection geom is uniform.
// ASTERRA POIs carry a GeoJSON Polygon or MultiPolygon; a bare Point is passed
// through unchanged (upsertDetections' centroid walker handles any of them).
function toMultiPolygon(geom) {
  if (!geom || !geom.type || !geom.coordinates) return geom ?? null;
  if (geom.type === 'Polygon') {
    return { type: 'MultiPolygon', coordinates: [geom.coordinates] };
  }
  return geom; // MultiPolygon, Point, etc. — leave as-is
}

// Map one ASTERRA POI record → the gateway-feature shape upsertDetections wants:
//   { id, properties:{ verification_result, leak_type, utilis_id, era_score,
//                      risk_score, investigation_priority }, geometry }
// Field sources (see services/.../asterra/models.py PoiItem):
//   investigationResult → verification_result (Leak|Suspected|Quiet|Unverifiable)
//   leakType            → leak_type
//   poiNumber           → utilis_id (stable per-project join key)
//   recoverInsightsLevel/eraScore → era_score (ERA risk band, when present)
// ASTERRA POIs have no numeric risk_score / investigation_priority; we leave
// those null and let severityOf() fall back to the verification_result.
export function mapPoiToFeature(poi) {
  const p = poi || {};
  const id = p.id ?? p.poiNumber ?? p.utilis_id ?? null;
  // ERA score may arrive as a number (eraScore) or as the textual ri/insights
  // level; only forward a finite number.
  const eraScore = numOrNull(p.eraScore ?? p.era_score ?? p.ERA_SCORE);
  return {
    id: id != null ? String(id) : '',
    properties: {
      verification_result: p.investigationResult ?? p.investigation_result ?? p.verified ?? null,
      leak_type: p.leakType ?? p.leak_type ?? null,
      utilis_id: p.poiNumber ?? p.utilis_id ?? (id != null ? String(id) : null),
      era_score: eraScore,
      risk_score: null,
      investigation_priority: null,
      // carry a few ASTERRA-native fields through into props for provenance
      ri_level: p.recoverInsightsLevel ?? p.recover_insights_level ?? null,
      address: p.address ?? null,
      delivery_name: p.deliveryName ?? p.delivery_name ?? null,
      source: 'asterra',
    },
    geometry: toMultiPolygon(p.geometry ?? null),
  };
}

// Discover ASTERRA-backed projects across all tenants (owner pool bypasses RLS).
async function listAsterraProjects() {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, asterra_project_id, sub_project_id,
            aoi_west, aoi_south, aoi_east, aoi_north
       FROM crm.project
      WHERE leak_source = 'asterra'
        AND asterra_project_id IS NOT NULL
        AND status <> 'archived'`);
  return rows;
}

// Ingest one project in its own tenant-bound transaction. Returns a summary.
// `client` (AsterraClient) is shared across projects so the bearer token is
// reused; login() is lazy inside iterPois via _ensureToken.
async function ingestOne(project, asterra) {
  // Pull every POI for the upstream project, mapping to gateway features.
  const feats = [];
  for await (const poi of asterra.iterPois(project.asterra_project_id)) {
    feats.push(mapPoiToFeature(poi));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('rwr.tenant_id', $1, true),
              set_config('app.clearance', 'secret', true)`,
      [String(project.tenant_id)]);
    const scanRes = await client.query(
      `INSERT INTO crm.scan (tenant_id, project_id, source, status,
                             aoi_west, aoi_south, aoi_east, aoi_north, sub_project_id, started_at)
       VALUES ($1,$2,'asterra','running',$3,$4,$5,$6,$7, now()) RETURNING id`,
      [project.tenant_id, project.id, project.aoi_west, project.aoi_south,
       project.aoi_east, project.aoi_north, project.asterra_project_id]);
    const scanId = scanRes.rows[0].id;
    const summary = await upsertDetections(client, {
      tenantId: project.tenant_id, scanId, projectId: project.id, features: feats });
    await client.query(
      `UPDATE crm.scan SET status='complete', result_summary=$2, completed_at=now(), updated_at=now()
        WHERE id=$1`,
      [scanId, JSON.stringify({ ...summary, source: 'asterra', auto: true })]);
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
export async function runAsterraIngest() {
  if (running) return { skipped: 'already_running' };
  if (!asterraConfigured()) return { skipped: 'not_configured' };
  running = true;
  const started = Date.now();
  let projects = [];
  try { projects = await listAsterraProjects(); }
  catch (e) { running = false; console.warn('[asterra-ingest] project list failed:', e?.message ?? e); return { error: 'list_failed' }; }

  const asterra = new AsterraClient();
  let ok = 0, failed = 0, total = 0;
  for (const p of projects) {
    try { const s = await ingestOne(p, asterra); ok++; total += s.detections; }
    catch (e) { failed++; console.warn(`[asterra-ingest] project ${p.id} failed:`, e?.message ?? e); }
  }
  running = false;
  const out = { projects: projects.length, ok, failed, detections: total, ms: Date.now() - started };
  console.log('[asterra-ingest] cycle', JSON.stringify(out));
  return out;
}

// Wire the scheduler. No-op unless ASTERRA_AUTO_INGEST=1 AND creds are present.
export function startAsterraIngest() {
  if (!ENABLED) { console.log('[asterra-ingest] disabled (set ASTERRA_AUTO_INGEST=1 to enable)'); return; }
  if (!asterraConfigured()) {
    console.log('[asterra-ingest] disabled — credentials missing (set ASTERRA_USERNAME + ASTERRA_PASSWORD)');
    return;
  }
  console.log(`[asterra-ingest] enabled — first run in ${BOOT_DELAY_MS / 1000}s, every ${INTERVAL_MS / 60000}min`);
  setTimeout(() => { runAsterraIngest().catch(() => {}); }, BOOT_DELAY_MS);
  setInterval(() => { runAsterraIngest().catch(() => {}); }, INTERVAL_MS);
}
