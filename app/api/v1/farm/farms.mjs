// =============================================================================
// /api/v1/farm/farms — FarmProfile CRUD + parcels + zones (Wave-2 Lane 2).
// -----------------------------------------------------------------------------
// The functional farm-domain substrate over farm.farm_profile / farm.parcel /
// farm.zone. Geometry is validated on write with PostGIS (ST_IsValid): a self-
// intersecting or wrong-typed polygon is rejected with 422 {error:'invalid_
// geometry'}. Areas are computed server-side via ST_Area(geography)/10000 so the
// client can never spoof hectares. Every query runs inside withTenantConn so RLS
// (210_farm_rls.sql) isolates rows to the caller's tenant.
//
// Routes (dispatched from api/v1/index.mjs):
//   GET/POST                 /farm/farms
//   GET/PUT/DELETE           /farm/farms/:id
//   GET/POST                 /farm/farms/:id/parcels
//   GET/POST                 /farm/farms/:id/zones
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { farmGate, UUID_RE } from './gate.mjs';

// Scalar farm_profile columns + boundaries rendered back as GeoJSON, the owning
// supplier's name, and the latest rollup risk (if the worker has computed any).
const FARM_SELECT = `
  fp.id, fp.tenant_id, fp.name, fp.timezone, fp.language, fp.currency,
  fp.farm_types, fp.crops, fp.total_area_ha, fp.signal_source,
  fp.aoi_west, fp.aoi_south, fp.aoi_east, fp.aoi_north,
  fp.status, fp.supplier_id, fp.profiles, fp.custom_context,
  fp.created_at, fp.updated_at,
  ST_AsGeoJSON(fp.boundaries)::json AS boundaries,
  s.name AS supplier_name,
  flr.score AS latest_risk_score, flr.band AS latest_risk_band, flr.bucket_date AS latest_risk_date`;

const FARM_FROM = `
  FROM farm.farm_profile fp
  LEFT JOIN farm.supplier s ON s.id = fp.supplier_id
  LEFT JOIN farm.v_farm_latest_risk flr
    ON flr.farm_id = fp.id AND flr.tenant_id = fp.tenant_id`;

const PARCEL_SELECT = `
  id, tenant_id, farm_id, name, area_ha, tags, created_at,
  ST_AsGeoJSON(geom)::json AS geom`;

const ZONE_SELECT = `
  id, tenant_id, farm_id, parcel_id, name, type, intent, tags, created_by, created_at,
  ST_AsGeoJSON(geom)::json AS geom`;

// Postgres raises SQLSTATE 22023 (invalid_parameter_value) / XX000 for malformed
// GeoJSON, and 22023 for a geometry-vs-column type mismatch. Any of these means
// the client sent bad geometry → 422, never a 500.
const GEOM_ERRCODES = new Set(['22023', 'XX000', '2203F', '54000']);
function isGeomError(err) {
  if (err && GEOM_ERRCODES.has(err.code)) return true;
  const m = String(err?.message ?? '').toLowerCase();
  return m.includes('geojson') || m.includes('geometry') || m.includes('invalid');
}

function strOrNull(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, max) : null;
}
function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.length).map((x) => x.slice(0, 120));
}

// --- LIST -------------------------------------------------------------------
export async function list(req, res) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${FARM_SELECT} ${FARM_FROM}
        WHERE fp.tenant_id = $1
        ORDER BY fp.created_at DESC
        LIMIT 500`,
      [req.tenant.id]);
    return r.rows;
  });
  ok(res, rows);
}

// --- GET ONE ----------------------------------------------------------------
export async function get(req, res, id) {
  if (!farmGate(req, res, 'farm.profile.read', 'farm:view')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_farm_id');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${FARM_SELECT} ${FARM_FROM} WHERE fp.id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  ok(res, row);
}

// --- CREATE -----------------------------------------------------------------
// {name, farmTypes[], crops[], boundaries GeoJSON MultiPolygon, timezone?, supplier_id?}
export async function create(req, res) {
  if (!farmGate(req, res, 'farm.profile.write', 'farm:onboard')) return;
  const body = (await readBody(req)) || {};
  const name = strOrNull(body.name);
  if (!name) return badReq(res, 'name_required');

  const farmTypes = strArray(body.farmTypes ?? body.farm_types);
  const crops     = strArray(body.crops);
  const timezone  = strOrNull(body.timezone, 64) ?? 'UTC';
  const supplierId = UUID_RE.test(String(body.supplier_id ?? '')) ? body.supplier_id : null;

  // boundaries: GeoJSON MultiPolygon (a lone Polygon is accepted and promoted).
  const boundaries = body.boundaries ?? null;
  const hasGeom = boundaries && typeof boundaries === 'object';
  const geomJson = hasGeom ? JSON.stringify(boundaries) : null;

  try {
    const row = await withTenantConn(req, async (client) => {
      // Validate + insert in one statement. When boundaries are supplied, the
      // WHERE ST_IsValid guard yields zero rows for a self-intersecting polygon,
      // which we surface as 422 below.
      if (hasGeom) {
        const r = await client.query(
          `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($6), 4326) AS geom)
           INSERT INTO farm.farm_profile
             (tenant_id, name, timezone, farm_types, crops, supplier_id,
              boundaries, total_area_ha,
              aoi_west, aoi_south, aoi_east, aoi_north)
           SELECT $1, $2, $3, $4::text[], $5::text[], $7,
                  ST_Multi(g.geom)::geography,
                  ST_Area(ST_Multi(g.geom)::geography) / 10000.0,
                  ST_XMin(g.geom), ST_YMin(g.geom), ST_XMax(g.geom), ST_YMax(g.geom)
             FROM g
            WHERE ST_IsValid(g.geom)
              AND GeometryType(g.geom) IN ('POLYGON', 'MULTIPOLYGON')
           RETURNING id`,
          [req.tenant.id, name, timezone, farmTypes, crops, geomJson, supplierId]);
        if (r.rows.length === 0) return { invalid: true };
        return { id: r.rows[0].id };
      }
      const r = await client.query(
        `INSERT INTO farm.farm_profile
           (tenant_id, name, timezone, farm_types, crops, supplier_id)
         VALUES ($1, $2, $3, $4::text[], $5::text[], $6)
         RETURNING id`,
        [req.tenant.id, name, timezone, farmTypes, crops, supplierId]);
      return { id: r.rows[0].id };
    });

    if (row.invalid) return send(res, 422, { success: false, error: 'invalid_geometry' });

    const full = await withTenantConn(req, async (client) => {
      const r = await client.query(
        `SELECT ${FARM_SELECT} ${FARM_FROM} WHERE fp.id = $1`, [row.id]);
      return r.rows[0];
    });
    recordAudit({ req, action: 'farm.profile.create', resource: 'farm.farm_profile',
      resourceId: full.id, payload: { after: { name: full.name, farm_types: full.farm_types } } });
    return created(res, full);
  } catch (err) {
    if (isGeomError(err)) return send(res, 422, { success: false, error: 'invalid_geometry' });
    throw err;
  }
}

// --- UPDATE -----------------------------------------------------------------
export async function update(req, res, id) {
  if (!farmGate(req, res, 'farm.profile.write', 'farm:onboard')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_farm_id');
  const body = (await readBody(req)) || {};

  try {
    const outcome = await withTenantConn(req, async (client) => {
      const before = await client.query(
        `SELECT id FROM farm.farm_profile WHERE id = $1`, [id]);
      if (before.rows.length === 0) return { kind: 'not_found' };

      const fields = []; const params = [id]; let i = 2;
      if ('name' in body) {
        const n = strOrNull(body.name);
        if (!n) return { kind: 'invalid', field: 'name' };
        fields.push(`name = $${i++}`); params.push(n);
      }
      if ('timezone' in body)  { fields.push(`timezone = $${i++}`);  params.push(strOrNull(body.timezone, 64) ?? 'UTC'); }
      if ('farmTypes' in body || 'farm_types' in body) {
        fields.push(`farm_types = $${i++}::text[]`); params.push(strArray(body.farmTypes ?? body.farm_types));
      }
      if ('crops' in body) { fields.push(`crops = $${i++}::text[]`); params.push(strArray(body.crops)); }
      if ('status' in body) { fields.push(`status = $${i++}`); params.push(strOrNull(body.status, 32) ?? 'active'); }
      if ('supplier_id' in body) {
        fields.push(`supplier_id = $${i++}`);
        params.push(UUID_RE.test(String(body.supplier_id ?? '')) ? body.supplier_id : null);
      }
      if ('boundaries' in body && body.boundaries && typeof body.boundaries === 'object') {
        // Re-validate + recompute area/AOI from the new geometry in place.
        const gjson = JSON.stringify(body.boundaries);
        const chk = await client.query(
          `SELECT ST_IsValid(g.geom) AS valid,
                  GeometryType(g.geom) AS gtype
             FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom) g`, [gjson]);
        const c = chk.rows[0];
        if (!c?.valid || !['POLYGON', 'MULTIPOLYGON'].includes(c.gtype)) return { kind: 'bad_geom' };
        fields.push(`boundaries = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))::geography`);
        fields.push(`total_area_ha = ST_Area(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))::geography) / 10000.0`);
        fields.push(`aoi_west  = ST_XMin(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))`);
        fields.push(`aoi_south = ST_YMin(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))`);
        fields.push(`aoi_east  = ST_XMax(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))`);
        fields.push(`aoi_north = ST_YMax(ST_SetSRID(ST_GeomFromGeoJSON($${i}), 4326))`);
        params.push(gjson); i++;
      }
      if (fields.length === 0) return { kind: 'no_fields' };
      fields.push('updated_at = now()');
      await client.query(
        `UPDATE farm.farm_profile SET ${fields.join(', ')} WHERE id = $1`, params);
      const r = await client.query(
        `SELECT ${FARM_SELECT} ${FARM_FROM} WHERE fp.id = $1`, [id]);
      return { kind: 'ok', after: r.rows[0] };
    });

    if (outcome.kind === 'not_found') return notFound(res);
    if (outcome.kind === 'bad_geom')  return send(res, 422, { success: false, error: 'invalid_geometry' });
    if (outcome.kind === 'invalid')   return badReq(res, 'invalid_' + outcome.field);
    if (outcome.kind === 'no_fields') return badReq(res, 'no_fields_to_update');

    recordAudit({ req, action: 'farm.profile.update', resource: 'farm.farm_profile',
      resourceId: id, payload: { after: { name: outcome.after.name } } });
    return ok(res, outcome.after);
  } catch (err) {
    if (isGeomError(err)) return send(res, 422, { success: false, error: 'invalid_geometry' });
    throw err;
  }
}

// --- DELETE -----------------------------------------------------------------
export async function remove(req, res, id) {
  if (!farmGate(req, res, 'farm.profile.write', 'farm:onboard')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_farm_id');
  const deleted = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `DELETE FROM farm.farm_profile WHERE id = $1 RETURNING id`, [id]);
    return r.rows[0] ?? null;
  });
  if (!deleted) return notFound(res);
  recordAudit({ req, action: 'farm.profile.delete', resource: 'farm.farm_profile',
    resourceId: id, payload: {} });
  ok(res, { id, deleted: true });
}

// --- ensure the farm exists in the caller's tenant (RLS-scoped) --------------
async function farmExists(req, farmId) {
  return withTenantConn(req, async (client) => {
    const r = await client.query(`SELECT id FROM farm.farm_profile WHERE id = $1`, [farmId]);
    return r.rows.length > 0;
  });
}

// --- PARCELS ----------------------------------------------------------------
export async function listParcels(req, res, farmId) {
  if (!farmGate(req, res, 'farm.zone.read', 'farm:view')) return;
  if (!UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${PARCEL_SELECT} FROM farm.parcel
        WHERE farm_id = $1 ORDER BY created_at DESC LIMIT 1000`, [farmId]);
    return r.rows;
  });
  ok(res, rows);
}

// {name, geom GeoJSON Polygon}
export async function createParcel(req, res, farmId) {
  if (!farmGate(req, res, 'farm.zone.write', 'farm:onboard')) return;
  if (!UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');
  const body = (await readBody(req)) || {};
  const name = strOrNull(body.name);
  if (!name) return badReq(res, 'name_required');
  if (!body.geom || typeof body.geom !== 'object') return badReq(res, 'geom_required');
  if (!(await farmExists(req, farmId))) return notFound(res);

  const geomJson = JSON.stringify(body.geom);
  const tags = strArray(body.tags);
  try {
    const row = await withTenantConn(req, async (client) => {
      const r = await client.query(
        `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($4), 4326) AS geom)
         INSERT INTO farm.parcel (tenant_id, farm_id, name, geom, area_ha, tags)
         SELECT $1, $2, $3, g.geom::geography,
                ST_Area(g.geom::geography) / 10000.0, $5::text[]
           FROM g
          WHERE ST_IsValid(g.geom) AND GeometryType(g.geom) = 'POLYGON'
         RETURNING ${PARCEL_SELECT}`,
        [req.tenant.id, farmId, name, geomJson, tags]);
      return r.rows[0] ?? null;
    });
    if (!row) return send(res, 422, { success: false, error: 'invalid_geometry' });
    recordAudit({ req, action: 'farm.parcel.create', resource: 'farm.parcel',
      resourceId: row.id, payload: { farm_id: farmId, name } });
    return created(res, row);
  } catch (err) {
    if (isGeomError(err)) return send(res, 422, { success: false, error: 'invalid_geometry' });
    throw err;
  }
}

// --- ZONES ------------------------------------------------------------------
export async function listZones(req, res, farmId) {
  if (!farmGate(req, res, 'farm.zone.read', 'farm:view')) return;
  if (!UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT ${ZONE_SELECT} FROM farm.zone
        WHERE farm_id = $1 ORDER BY created_at DESC LIMIT 1000`, [farmId]);
    return r.rows;
  });
  ok(res, rows);
}

// {name, type, intent JSONB, geom GeoJSON Polygon, parcel_id?}
export async function createZone(req, res, farmId) {
  if (!farmGate(req, res, 'farm.zone.write', 'farm:onboard')) return;
  if (!UUID_RE.test(farmId)) return badReq(res, 'invalid_farm_id');
  const body = (await readBody(req)) || {};
  const name = strOrNull(body.name);
  const type = strOrNull(body.type, 64);
  if (!name) return badReq(res, 'name_required');
  if (!type) return badReq(res, 'type_required');
  if (!body.geom || typeof body.geom !== 'object') return badReq(res, 'geom_required');
  if (!(await farmExists(req, farmId))) return notFound(res);

  const parcelId = UUID_RE.test(String(body.parcel_id ?? '')) ? body.parcel_id : null;
  const intent = (body.intent && typeof body.intent === 'object') ? body.intent : {};
  const geomJson = JSON.stringify(body.geom);
  const tags = strArray(body.tags);
  const createdBy = UUID_RE.test(String(req.user?.sub ?? '')) ? req.user.sub : null;

  try {
    const row = await withTenantConn(req, async (client) => {
      const r = await client.query(
        `WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($5), 4326) AS geom)
         INSERT INTO farm.zone
           (tenant_id, farm_id, parcel_id, name, type, intent, geom, tags, created_by)
         SELECT $1, $2, $3, $4, $6, $7::jsonb, g.geom::geography, $8::text[], $9
           FROM g
          WHERE ST_IsValid(g.geom) AND GeometryType(g.geom) = 'POLYGON'
         RETURNING ${ZONE_SELECT}`,
        [req.tenant.id, farmId, parcelId, name, geomJson, type,
         JSON.stringify(intent), tags, createdBy]);
      return r.rows[0] ?? null;
    });
    if (!row) return send(res, 422, { success: false, error: 'invalid_geometry' });
    recordAudit({ req, action: 'farm.zone.create', resource: 'farm.zone',
      resourceId: row.id, payload: { farm_id: farmId, name, type } });
    return created(res, row);
  } catch (err) {
    if (isGeomError(err)) return send(res, 422, { success: false, error: 'invalid_geometry' });
    throw err;
  }
}
