// =============================================================================
// /api/v1/gis — customer-uploaded GIS layers.
// -----------------------------------------------------------------------------
// Customers (and ops admins) upload vector data (GeoJSON / Shapefile / KML)
// and raster overlays (GeoTIFF / PDF / PNG / JPG). Vector files are parsed
// on upload into gis.feature rows; rasters are stored as blobs with optional
// georeferencing metadata.
//
// Endpoints:
//   POST   /api/v1/gis/layers              multipart, fields { name, kind, color?, lead_id? }, file
//   GET    /api/v1/gis/layers              list current tenant's layers
//   GET    /api/v1/gis/layers/:id          one layer (metadata only)
//   GET    /api/v1/gis/layers/:id/features GeoJSON FeatureCollection for map source
//   PATCH  /api/v1/gis/layers/:id          { name?, visible?, color?, opacity? }
//   DELETE /api/v1/gis/layers/:id          remove layer + features + raster + blob
// =============================================================================

import { writeFile, mkdir, unlink, readFile } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { q } from '../db/pool.mjs';
import { ok, created, badReq, notFound, getHeader, readBody } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import shp from 'shpjs';
import JSZip from 'jszip';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';

const MAX_UPLOAD_BYTES = Number(process.env.GIS_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024); // 50 MB
const VALID_KINDS = new Set(['pipes','electrical','architectural','blueprint','topology','assets','other']);

const RASTER_FORMATS = new Set(['geotiff','pdf','png','jpg']);

function uploadDir() {
  return pathResolve(process.env.GIS_UPLOAD_DIR ?? './uploads/gis');
}

// -----------------------------------------------------------------------------
// Inline multipart parser (same pattern as sales/files.mjs).
// -----------------------------------------------------------------------------
async function parseMultipart(req) {
  const ctype = getHeader(req, 'content-type') ?? '';
  const m = ctype.match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) throw new Error('not_multipart');
  const boundary = Buffer.from('--' + m[1]);
  const closing = Buffer.from('--' + m[1] + '--');
  return await new Promise((resolveP, rejectP) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD_BYTES * 1.1) { req.destroy(); return rejectP(new Error('payload_too_large')); }
      chunks.push(c);
    });
    req.on('error', rejectP);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        let cursor = buf.indexOf(boundary);
        if (cursor === -1) return rejectP(new Error('boundary_not_found'));
        cursor += boundary.length + 2;
        const parts = [];
        while (cursor < buf.length) {
          const next = buf.indexOf(boundary, cursor);
          if (next === -1) break;
          const partBuf = buf.slice(cursor, next - 2);
          const headerEnd = partBuf.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
          const body = partBuf.slice(headerEnd + 4);
          const disp = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerStr);
          const ctypeP = /content-type:\s*([^\r\n]+)/i.exec(headerStr);
          if (disp) parts.push({ name: disp[1], filename: disp[2] ?? null, contentType: ctypeP ? ctypeP[1].trim() : null, body });
          if (buf.slice(next, next + closing.length).equals(closing)) break;
          cursor = next + boundary.length + 2;
        }
        const fields = {}; let file = null;
        for (const p of parts) { if (p.filename) file = p; else fields[p.name] = p.body.toString('utf8'); }
        resolveP({ fields, file });
      } catch (e) { rejectP(e); }
    });
  });
}

// -----------------------------------------------------------------------------
// Format detection from filename + content-type.
// -----------------------------------------------------------------------------
function detectFormat(filename = '', contentType = '') {
  const f = filename.toLowerCase();
  if (f.endsWith('.geojson') || f.endsWith('.json')) return 'geojson';
  if (f.endsWith('.kml'))                            return 'kml';
  if (f.endsWith('.kmz'))                            return 'kmz';
  if (f.endsWith('.zip') || f.endsWith('.shp.zip'))  return 'shapefile';
  if (f.endsWith('.tif') || f.endsWith('.tiff'))     return 'geotiff';
  if (f.endsWith('.pdf'))                            return 'pdf';
  if (f.endsWith('.png'))                            return 'png';
  if (f.endsWith('.jpg') || f.endsWith('.jpeg'))     return 'jpg';
  if (/geo\+json/.test(contentType))                  return 'geojson';
  return 'other';
}

// -----------------------------------------------------------------------------
// Vector parsers — all return a GeoJSON FeatureCollection.
// -----------------------------------------------------------------------------
async function parseGeoJSON(buf) {
  const text = buf.toString('utf8');
  const data = JSON.parse(text);
  if (data?.type === 'FeatureCollection') return data;
  if (data?.type === 'Feature')           return { type: 'FeatureCollection', features: [data] };
  if (data?.type && data?.coordinates)    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: data, properties: {} }] };
  throw new Error('invalid_geojson');
}

async function parseShapefile(buf) {
  // shpjs accepts a Buffer/ArrayBuffer of a .shp.zip and returns FeatureCollection
  // (or array of them for multi-layer zips — we flatten).
  const result = await shp(buf);
  if (Array.isArray(result)) {
    const features = result.flatMap((fc) => fc.features ?? []);
    return { type: 'FeatureCollection', features };
  }
  return result;
}

async function parseKML(buf) {
  const text = buf.toString('utf8');
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  return kmlToGeoJSON(dom);
}

async function parseKMZ(buf) {
  const zip = await JSZip.loadAsync(buf);
  const kmlEntry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
  if (!kmlEntry) throw new Error('kmz_no_kml');
  const text = await kmlEntry.async('string');
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  return kmlToGeoJSON(dom);
}

// -----------------------------------------------------------------------------
// BBox helper — collapses a FeatureCollection to a min/max envelope.
// -----------------------------------------------------------------------------
function bboxFromFeatureCollection(fc) {
  let minX = +Infinity, minY = +Infinity, maxX = -Infinity, maxY = -Infinity;
  function visit(coords) {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    } else {
      for (const c of coords) visit(c);
    }
  }
  for (const f of (fc.features ?? [])) {
    if (f?.geometry?.coordinates) visit(f.geometry.coordinates);
  }
  if (!isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function bboxToWKT([minX, minY, maxX, maxY]) {
  return `POLYGON((${minX} ${minY},${maxX} ${minY},${maxX} ${maxY},${minX} ${maxY},${minX} ${minY}))`;
}

// -----------------------------------------------------------------------------
// POST /gis/layers — upload + parse + persist.
// -----------------------------------------------------------------------------
export async function upload(req, res) {
  let parsed;
  try { parsed = await parseMultipart(req); }
  catch (err) {
    if (err.message === 'payload_too_large') return badReq(res, 'payload_too_large');
    return badReq(res, err.message ?? 'multipart_parse_failed');
  }
  if (!parsed.file) return badReq(res, 'file_field_required');
  if (parsed.file.body.length > MAX_UPLOAD_BYTES) return badReq(res, 'file_too_large');

  const name    = (parsed.fields.name    ?? parsed.file.filename ?? 'Untitled layer').slice(0, 200);
  const kind    = (parsed.fields.kind    ?? 'other').toLowerCase();
  const color   = (parsed.fields.color   ?? '#00d4ff').slice(0, 16);
  const leadId  = parsed.fields.lead_id  || null;
  if (!VALID_KINDS.has(kind)) return badReq(res, 'invalid_kind');

  const format = detectFormat(parsed.file.filename, parsed.file.contentType);
  const layerId = randomUUID();

  // Persist blob to disk first.
  const safeName = (parsed.file.filename ?? 'upload').replace(/[^\w.\-]/g, '_').slice(0, 200);
  const dir = join(uploadDir(), req.tenant.slug);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${layerId}_${safeName}`);
  await writeFile(storagePath, parsed.file.body);

  // Record file in sales.file (existing blob registry) for audit + reuse.
  const fileId = randomUUID();
  await q(
    `INSERT INTO sales.file (id, tenant_id, lead_id, file_name, file_size, file_type, storage_path, signed_url, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [fileId, req.tenant.id, leadId, safeName, parsed.file.body.length, parsed.file.contentType ?? null,
     storagePath, `/api/v1/gis/layers/${layerId}/download`, req.user?.sub ?? null],
  );

  // Insert layer row with parsing status.
  await q(
    `INSERT INTO gis.layer (id, tenant_id, lead_id, uploader_id, name, kind, source_format, status, file_id, color, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'parsing',$8,$9,$10::jsonb)`,
    [layerId, req.tenant.id, leadId, req.user?.sub ?? null, name, kind, format, fileId, color,
     JSON.stringify({ original_filename: parsed.file.filename })],
  );

  // Parse if vector, or register raster.
  try {
    if (RASTER_FORMATS.has(format)) {
      await q(
        `INSERT INTO gis.raster (id, layer_id, tenant_id, file_id) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [layerId, req.tenant.id, fileId],
      );
      await q(
        `UPDATE gis.layer SET status='ready', updated_at=now() WHERE id=$1`,
        [layerId],
      );
    } else {
      let fc;
      if      (format === 'geojson')   fc = await parseGeoJSON(parsed.file.body);
      else if (format === 'shapefile') fc = await parseShapefile(parsed.file.body);
      else if (format === 'kml')       fc = await parseKML(parsed.file.body);
      else if (format === 'kmz')       fc = await parseKMZ(parsed.file.body);
      else throw new Error('unsupported_format');

      // Bulk-insert features.
      const features = fc.features ?? [];
      for (const feat of features) {
        if (!feat?.geometry) continue;
        await q(
          `INSERT INTO gis.feature (layer_id, tenant_id, geom, geom_type, properties)
             VALUES ($1, $2, ST_GeomFromGeoJSON($3::text)::geography, $4, $5::jsonb)`,
          [layerId, req.tenant.id, JSON.stringify(feat.geometry), feat.geometry.type, JSON.stringify(feat.properties ?? {})],
        );
      }

      const bbox = bboxFromFeatureCollection(fc);
      await q(
        `UPDATE gis.layer SET
           status='ready',
           feature_count=$2,
           bbox=${bbox ? `ST_GeogFromText('SRID=4326;${bboxToWKT(bbox)}')` : 'NULL'},
           updated_at=now()
         WHERE id=$1`,
        [layerId, features.length],
      );
    }

    recordAudit({ req, action: 'create', resource: 'gis.layer', resourceId: layerId, payload: { name, kind, format } });

    const { rows } = await q(`SELECT * FROM gis.layer WHERE id=$1`, [layerId]);
    return created(res, rows[0]);
  } catch (err) {
    console.error('[gis] parse_failed', err);
    await q(
      `UPDATE gis.layer SET status='failed', parse_error=$2, updated_at=now() WHERE id=$1`,
      [layerId, err?.message ?? 'unknown'],
    );
    return badReq(res, `parse_failed: ${err?.message ?? 'unknown'}`);
  }
}

// -----------------------------------------------------------------------------
// GET /gis/layers — list current tenant's layers.
// -----------------------------------------------------------------------------
export async function list(req, res) {
  const leadId = req.url.includes('lead_id=')
    ? new URL(req.url, 'http://x').searchParams.get('lead_id')
    : null;
  const args = [req.tenant.id];
  let where = 'tenant_id = $1';
  if (leadId) { args.push(leadId); where += ' AND lead_id = $2'; }
  const { rows } = await q(
    `SELECT id, lead_id, name, kind, source_format, status, parse_error, file_id,
            feature_count, visible, color, opacity, metadata, created_at, updated_at,
            CASE WHEN bbox IS NOT NULL
                 THEN ST_AsGeoJSON(bbox::geometry)::jsonb
                 ELSE NULL END AS bbox
       FROM gis.layer
      WHERE ${where}
      ORDER BY created_at DESC`,
    args,
  );
  ok(res, rows);
}

// -----------------------------------------------------------------------------
// GET /gis/layers/:id — one layer metadata.
// -----------------------------------------------------------------------------
export async function getOne(req, res, id) {
  const { rows } = await q(
    `SELECT id, lead_id, name, kind, source_format, status, parse_error,
            feature_count, visible, color, opacity, metadata, created_at, updated_at,
            CASE WHEN bbox IS NOT NULL THEN ST_AsGeoJSON(bbox::geometry)::jsonb ELSE NULL END AS bbox
       FROM gis.layer
      WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

// -----------------------------------------------------------------------------
// GET /gis/layers/:id/features — features as GeoJSON FeatureCollection.
// -----------------------------------------------------------------------------
export async function features(req, res, id) {
  // First verify ownership.
  const { rows: lr } = await q(
    `SELECT id, source_format FROM gis.layer WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  if (lr.length === 0) return notFound(res);

  const { rows } = await q(
    `SELECT ST_AsGeoJSON(geom::geometry)::jsonb AS geometry, properties
       FROM gis.feature
      WHERE tenant_id = $1 AND layer_id = $2
      LIMIT 50000`,
    [req.tenant.id, id],
  );
  ok(res, {
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: r.geometry, properties: r.properties ?? {} })),
  });
}

// -----------------------------------------------------------------------------
// PATCH /gis/layers/:id — toggle visible / rename / recolor.
// -----------------------------------------------------------------------------
export async function patch(req, res, id) {
  const body = (await readBody(req)) || {};
  const sets = [];
  const args = [req.tenant.id, id];
  let p = 3;
  if (typeof body.name    === 'string')  { sets.push(`name = $${p}`);   args.push(body.name.slice(0,200)); p++; }
  if (typeof body.visible === 'boolean') { sets.push(`visible = $${p}`); args.push(body.visible); p++; }
  if (typeof body.color   === 'string')  { sets.push(`color = $${p}`);  args.push(body.color.slice(0,16)); p++; }
  if (typeof body.opacity === 'number' && body.opacity >= 0 && body.opacity <= 1) {
    sets.push(`opacity = $${p}`); args.push(body.opacity); p++;
  }
  if (sets.length === 0) return badReq(res, 'no_fields');
  sets.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE gis.layer SET ${sets.join(',')} WHERE tenant_id = $1 AND id = $2
     RETURNING id, name, kind, visible, color, opacity`,
    args,
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'update', resource: 'gis.layer', resourceId: id, payload: { fields: Object.keys(body) } });
  ok(res, rows[0]);
}

// -----------------------------------------------------------------------------
// DELETE /gis/layers/:id — full removal.
// -----------------------------------------------------------------------------
export async function remove(req, res, id) {
  const { rows } = await q(
    `SELECT l.id, l.file_id, f.storage_path
       FROM gis.layer l
       LEFT JOIN sales.file f ON f.id = l.file_id
      WHERE l.tenant_id = $1 AND l.id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  await q(`DELETE FROM gis.layer WHERE tenant_id = $1 AND id = $2`, [req.tenant.id, id]);
  if (rows[0].storage_path) await unlink(rows[0].storage_path).catch(() => {});
  if (rows[0].file_id) await q(`DELETE FROM sales.file WHERE id = $1`, [rows[0].file_id]).catch(() => {});
  recordAudit({ req, action: 'delete', resource: 'gis.layer', resourceId: id });
  ok(res, { id });
}

// -----------------------------------------------------------------------------
// GET /gis/layers/:id/download — original blob.
// -----------------------------------------------------------------------------
export async function download(req, res, id) {
  const { rows } = await q(
    `SELECT f.storage_path, f.file_name, f.file_type
       FROM gis.layer l
       JOIN sales.file f ON f.id = l.file_id
      WHERE l.tenant_id = $1 AND l.id = $2`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  try {
    const buf = await readFile(rows[0].storage_path);
    res.statusCode = 200;
    res.setHeader('content-type', rows[0].file_type ?? 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${rows[0].file_name}"`);
    res.end(buf);
  } catch {
    notFound(res);
  }
}
