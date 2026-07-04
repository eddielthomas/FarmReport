// =============================================================================
// /api/v1/field/jobs/:id/uploads — multimedia upload pipeline (S9A).
// -----------------------------------------------------------------------------
// POST /field/jobs/:id/uploads  multipart/form-data + ?lat=&lon=&accuracy_m=&captured_at=
//   - Streams the file to MinIO bucket rwr-field-uploads.
//   - Generates sha256 in-stream.
//   - Computes gps_distance_from_job_m via ST_Distance.
//   - Mode resolution:
//       strict  ← field.geofence_strict_upload tenant flag is true OR
//                 query param strict=true
//       lenient ← default (flag false / unset)
//       none    ← no capture coords supplied (or job has no location)
//   - Strict mode: distance > radius rejects with 422.
//   - Lenient mode: row created with gps_verified false + flag for review.
//   - Spoofing check: capture point vs tech's last-known position. >500m
//     drift triggers field.geofence_event 'spoofing_suspected' + envelope.
//
// GET /field/jobs/:id/uploads → list with 1-hour MinIO signed URLs
// GET /field/uploads/:id/signed → fresh signed URL for a single upload
//
// AuthZ:
//   POST  → field.upload.write
//   GET   → field.upload.read
// =============================================================================

import { createHash } from 'node:crypto';
import { withTenantConn } from '../db/pool.mjs';
import { ok, created, badReq, notFound, send, parseQuery, getHeader } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { publishFieldEvent } from '../lib/field-relay.mjs';
import { validCoord, distanceMeters } from '../lib/geo.mjs';
import { putFieldObject, signedGetUrl, getFieldBucketName } from '../lib/minio.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = Number(process.env.FIELD_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024); // 50MB
const SPOOFING_DRIFT_M = Number(process.env.FIELD_SPOOFING_DRIFT_M ?? 500);

function readStrictUploadFlag(req) {
  const raw = req.tenant?.flags?.['field.geofence_strict_upload'];
  if (raw === true || raw === 'true' || raw === 1) return true;
  return false;
}

async function readBodyBuffer(req) {
  return await new Promise((resolveP, rejectP) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_FILE_BYTES * 1.1) {
        req.destroy();
        return rejectP(new Error('payload_too_large'));
      }
      chunks.push(c);
    });
    req.on('error', rejectP);
    req.on('end', () => resolveP(Buffer.concat(chunks)));
  });
}

function parseMultipart(buf, contentType) {
  const m = (contentType ?? '').match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1]);
  const closing = Buffer.from('--' + m[1] + '--');
  const parts = [];
  let cursor = buf.indexOf(boundary);
  if (cursor === -1) return null;
  cursor += boundary.length + 2; // skip CRLF
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
    if (disp) {
      parts.push({
        name: disp[1],
        filename: disp[2] ?? null,
        contentType: ctypeP ? ctypeP[1].trim() : null,
        body,
      });
    }
    if (buf.slice(next, next + closing.length).equals(closing)) break;
    cursor = next + boundary.length + 2;
  }
  const fields = {}; let file = null;
  for (const p of parts) {
    if (p.filename) file = p;
    else fields[p.name] = p.body.toString('utf8');
  }
  return { fields, file };
}

export async function createUpload(req, res, jobId) {
  if (!requirePermission(req, res, 'field.upload.write')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const userId = req.user?.sub;
  if (!userId || !UUID_RE.test(userId)) return badReq(res, 'caller_not_resolved');

  let buf;
  try { buf = await readBodyBuffer(req); }
  catch (err) {
    if (err?.message === 'payload_too_large') return badReq(res, 'payload_too_large');
    return badReq(res, err?.message ?? 'read_failed');
  }
  if (!buf || buf.length === 0) return badReq(res, 'empty_body');
  if (buf.length > MAX_FILE_BYTES) return badReq(res, 'file_too_large');

  const ctype = getHeader(req, 'content-type') ?? '';
  let originalName = 'upload.bin';
  let mimeType = ctype || 'application/octet-stream';
  let fileBody = buf;
  if (/^multipart\//i.test(ctype)) {
    const parsed = parseMultipart(buf, ctype);
    if (!parsed?.file) return badReq(res, 'file_field_required');
    originalName = (parsed.file.filename ?? 'upload.bin').replace(/[^\w.\-]/g, '_').slice(0, 200);
    mimeType = parsed.file.contentType ?? 'application/octet-stream';
    fileBody = parsed.file.body;
  }

  // GPS metadata from query string (PWA convenience) or header.
  const qs = parseQuery(req.url);
  const lat = qs.lat != null ? Number(qs.lat) : null;
  const lon = qs.lon != null ? Number(qs.lon) : null;
  const accuracy = qs.accuracy_m != null && Number.isFinite(Number(qs.accuracy_m))
    ? Number(qs.accuracy_m) : null;
  const captured = qs.captured_at ? new Date(qs.captured_at) : new Date();
  const hasCoords = lat != null && lon != null && validCoord(lat, lon);
  const strict = readStrictUploadFlag(req) || qs.strict === 'true';

  const sha256 = createHash('sha256').update(fileBody).digest('hex');

  // Look up job + tech's last-known position INSIDE withTenantConn so RLS
  // engages. Compute distance + spoofing flag before INSERT.
  const phase1 = await withTenantConn(req, async (client) => {
    const jres = await client.query(
      `SELECT id, geofence_radius_m, classification,
              ST_Y(location::geometry) AS job_lat,
              ST_X(location::geometry) AS job_lon,
              location IS NOT NULL AS has_location
         FROM field.job WHERE id = $1`,
      [jobId],
    );
    if (jres.rows.length === 0) return { kind: 'not_found' };
    const job = jres.rows[0];
    const tres = await client.query(
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon, posted_at
         FROM field.technician_location WHERE user_id = $1`,
      [userId],
    );
    const lastKnown = tres.rows[0] ?? null;
    return { kind: 'ok', job, lastKnown };
  });
  if (phase1.kind === 'not_found') return notFound(res);
  const { job, lastKnown } = phase1;

  // Distance computations (JS Haversine — matches lib/geo). For the strict
  // check we use the same formula the SQL helper uses.
  let distanceFromJob = null;
  if (hasCoords && job.has_location && Number.isFinite(job.job_lat) && Number.isFinite(job.job_lon)) {
    distanceFromJob = distanceMeters(lat, lon, Number(job.job_lat), Number(job.job_lon));
  }
  const inside = distanceFromJob == null
    ? null
    : distanceFromJob <= Number(job.geofence_radius_m);

  let mode = 'none';
  if (hasCoords && job.has_location) {
    mode = strict ? 'strict' : 'lenient';
  }
  let gpsVerified = false;
  if (mode === 'strict') {
    if (inside === true) gpsVerified = true;
    else return send(res, 422, {
      success: false,
      error: 'gps_out_of_geofence',
      detail: {
        distance_m: distanceFromJob,
        radius_m: Number(job.geofence_radius_m),
        strict: true,
      },
    });
  } else if (mode === 'lenient') {
    gpsVerified = inside === true;
  } else {
    gpsVerified = false;
  }

  // Spoofing check vs last-known.
  let spoofingDrift = null;
  if (hasCoords && lastKnown && Number.isFinite(lastKnown.lat) && Number.isFinite(lastKnown.lon)) {
    spoofingDrift = distanceMeters(lat, lon, Number(lastKnown.lat), Number(lastKnown.lon));
  }
  const spoofingSuspected = spoofingDrift != null && spoofingDrift > SPOOFING_DRIFT_M;

  // Upload to MinIO. We use a deterministic key with the sha to dedupe duplicate
  // uploads across retries.
  const bucket = getFieldBucketName();
  const storageKey = `tenant=${req.tenant.id}/job=${jobId}/${sha256}_${originalName}`;
  try {
    await putFieldObject(storageKey, fileBody, mimeType);
  } catch (err) {
    return send(res, 502, { success: false, error: 'object_store_unavailable',
      detail: String(err?.message ?? err) });
  }

  // Insert ledger row + spoofing event (if any), still inside the tenant txn.
  const phase2 = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `INSERT INTO field.upload
         (tenant_id, job_id, user_id,
          original_filename, mime_type, byte_size, sha256,
          storage_bucket, storage_key,
          capture_location,
          capture_accuracy_m, captured_at,
          gps_verified, gps_verification_mode, gps_distance_from_job_m,
          classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $11::double precision IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($10, $11), 4326)::geography END,
               $12, $13, $14, $15, $16, $17)
       RETURNING id, gps_verified, gps_verification_mode, gps_distance_from_job_m, classification, created_at`,
      [
        req.tenant.id, jobId, userId,
        originalName, mimeType, fileBody.length, sha256,
        bucket, storageKey,
        hasCoords ? lon : null, hasCoords ? lat : null,
        accuracy, captured.toISOString(),
        gpsVerified, mode, distanceFromJob,
        job.classification,
      ],
    );
    if (spoofingSuspected) {
      await client.query(
        `INSERT INTO field.geofence_event
           (tenant_id, job_id, user_id, event_kind, location, distance_m, captured_at, posted_at, payload)
         VALUES ($1, $2, $3, 'spoofing_suspected',
                 ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
                 $6, $7, now(), $8::jsonb)`,
        [
          req.tenant.id, jobId, userId, lat, lon, spoofingDrift,
          captured.toISOString(),
          JSON.stringify({
            drift_m: spoofingDrift, last_known: lastKnown,
            upload_id: r.rows[0].id, threshold_m: SPOOFING_DRIFT_M,
          }),
        ],
      );
    }
    return r.rows[0];
  });

  recordAudit({
    req, action: 'field.upload.create', resource: 'field.upload',
    resourceId: phase2.id,
    payload: {
      after: {
        id: phase2.id, job_id: jobId, byte_size: fileBody.length, sha256,
        gps_verified: phase2.gps_verified,
        gps_verification_mode: phase2.gps_verification_mode,
        gps_distance_from_job_m: phase2.gps_distance_from_job_m,
      },
      classification: phase2.classification,
      spoofing_suspected: spoofingSuspected,
    },
  });
  publishFieldEvent(req.io, 'field.upload.created', {
    tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
    upload_id: phase2.id, gps_verified: phase2.gps_verified,
    gps_verification_mode: phase2.gps_verification_mode,
    gps_distance_from_job_m: phase2.gps_distance_from_job_m,
  });
  if (spoofingSuspected) {
    publishFieldEvent(req.io, 'field.spoofing_suspected', {
      tenant_id: req.tenant.id, job_id: jobId, user_id: userId,
      distance_m: spoofingDrift, threshold_m: SPOOFING_DRIFT_M,
      upload_id: phase2.id,
    });
  }
  created(res, {
    id: phase2.id, job_id: jobId,
    byte_size: fileBody.length, sha256,
    gps_verified: phase2.gps_verified,
    gps_verification_mode: phase2.gps_verification_mode,
    gps_distance_from_job_m: phase2.gps_distance_from_job_m,
    spoofing_suspected: spoofingSuspected,
  });
}

export async function listForJob(req, res, jobId) {
  if (!requirePermission(req, res, 'field.upload.read')) return;
  if (!UUID_RE.test(jobId)) return badReq(res, 'invalid_job_id');
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, job_id, user_id, original_filename, mime_type, byte_size, sha256,
              storage_bucket, storage_key,
              ST_Y(capture_location::geometry) AS capture_lat,
              ST_X(capture_location::geometry) AS capture_lon,
              capture_accuracy_m, captured_at,
              gps_verified, gps_verification_mode, gps_distance_from_job_m,
              classification, created_at
         FROM field.upload
        WHERE job_id = $1
        ORDER BY created_at DESC
        LIMIT 500`, [jobId]);
    return r.rows;
  });
  // Attach short-lived signed URLs (1h). Errors degrade gracefully — the
  // listing still returns the metadata even if signed-URL minting fails.
  const augmented = await Promise.all(rows.map(async (r) => {
    let signed_url = null;
    try { signed_url = await signedGetUrl(r.storage_bucket, r.storage_key, 3600); }
    catch (_e) { signed_url = null; }
    return { ...r, signed_url };
  }));
  ok(res, augmented);
}

export async function signedUrl(req, res, uploadId) {
  if (!requirePermission(req, res, 'field.upload.read')) return;
  if (!UUID_RE.test(uploadId)) return badReq(res, 'invalid_upload_id');
  const row = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, storage_bucket, storage_key
         FROM field.upload WHERE id = $1`, [uploadId]);
    return r.rows[0] ?? null;
  });
  if (!row) return notFound(res);
  try {
    const url = await signedGetUrl(row.storage_bucket, row.storage_key, 3600);
    ok(res, { id: row.id, signed_url: url, ttl_seconds: 3600 });
  } catch (err) {
    send(res, 502, { success: false, error: 'object_store_unavailable',
      detail: String(err?.message ?? err) });
  }
}
