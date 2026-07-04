// =============================================================================
// /api/v1/farm/observations — read the AlphaGeo ingest sink (Wave-2 Lane 2).
// -----------------------------------------------------------------------------
// GET /farm/observations?farm_id&measurement&limit
//
// farm.observation is populated ONLY by a real gateway round-trip (docs/03 §6
// hard invariant); until the P2 ingest lands this list is honestly EMPTY. The
// endpoint therefore always returns a well-formed [] rather than fabricating
// rows, so the frontend can render an honest "monitoring begins with the
// AlphaGeo connection" empty state.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { ok, badReq } from '../http.mjs';
import { farmGate, UUID_RE } from './gate.mjs';

const OBS_SELECT = `
  id, tenant_id, scan_id, farm_id, zone_id, external_id,
  measurement, value, unit, confidence, cloud_pct,
  source_type, provider, collection, scene_id, acquired_at,
  props, version, detected_at,
  ST_AsGeoJSON(geom)::json AS geom`;

export async function list(req, res) {
  if (!farmGate(req, res, 'farm.observation.read', 'farm:view')) return;
  const url = new URL(req.url, 'http://x');
  const qs = url.searchParams;
  const farmId = qs.get('farm_id');
  const measurement = qs.get('measurement');
  const limit = Math.min(Math.max(Number(qs.get('limit') ?? 200) || 200, 1), 5000);

  if (farmId && !UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');

  const params = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (farmId)      { params.push(farmId);      where += ` AND farm_id = $${params.length}`; }
  if (measurement) { params.push(measurement); where += ` AND measurement = $${params.length}`; }

  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${OBS_SELECT} FROM farm.observation
        WHERE ${where}
        ORDER BY acquired_at DESC NULLS LAST, detected_at DESC
        LIMIT ${limit}`, params);
    return r.rows;
  });
  ok(res, rows);
}
