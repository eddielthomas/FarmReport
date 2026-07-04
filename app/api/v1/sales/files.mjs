// =============================================================================
// /api/v1/sales/files — multipart file upload (lead attachment).
// -----------------------------------------------------------------------------
// We avoid pulling express+multer into this vanilla-http server. Instead a
// tiny inline RFC-2046 multipart parser handles one file per request, which
// matches the Figma Make CRM upload flow.
//
// Storage strategy:
//   - UPLOAD_DIR env (default: ./uploads/files) on local FS
//   - signed_url = a /api/v1/sales/files/:id/download URL (added later)
//     for now we return the storage_path as signed_url placeholder.
// =============================================================================

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { q } from '../db/pool.mjs';
import { ok, created, badReq, notFound, getHeader } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const MAX_FILE_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024); // 10MB

function uploadDir() {
  return pathResolve(process.env.UPLOAD_DIR ?? './uploads/files');
}

// Inline single-file multipart/form-data parser. Returns { fields, file }.
// Streams to disk so 10MB uploads don't keep the whole buffer in heap.
async function parseMultipart(req) {
  const ctype = getHeader(req, 'content-type') ?? '';
  const m = ctype.match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) throw new Error('not_multipart');
  const boundary = Buffer.from('--' + m[1]);
  const closing = Buffer.from('--' + m[1] + '--');

  // collect whole body (bounded by MAX_FILE_BYTES * 1.1)
  return await new Promise((resolveP, rejectP) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_FILE_BYTES * 1.1) { req.destroy(); return rejectP(new Error('payload_too_large')); }
      chunks.push(c);
    });
    req.on('error', rejectP);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = [];
        let cursor = buf.indexOf(boundary);
        if (cursor === -1) return rejectP(new Error('boundary_not_found'));
        cursor += boundary.length + 2; // skip CRLF
        while (cursor < buf.length) {
          // find next boundary
          const next = buf.indexOf(boundary, cursor);
          if (next === -1) break;
          const partBuf = buf.slice(cursor, next - 2); // strip trailing CRLF
          // split header / body at CRLFCRLF
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
        const fields = {};
        let file = null;
        for (const p of parts) {
          if (p.filename) file = p;
          else fields[p.name] = p.body.toString('utf8');
        }
        resolveP({ fields, file });
      } catch (e) { rejectP(e); }
    });
  });
}

export async function upload(req, res) {
  let parsed;
  try { parsed = await parseMultipart(req); }
  catch (err) {
    if (err.message === 'payload_too_large') return badReq(res, 'payload_too_large');
    return badReq(res, err.message ?? 'multipart_parse_failed');
  }
  if (!parsed.file) return badReq(res, 'file_field_required');
  if (parsed.file.body.length > MAX_FILE_BYTES) return badReq(res, 'file_too_large');

  const fileId = randomUUID();
  const safeName = (parsed.file.filename ?? 'upload').replace(/[^\w.\-]/g, '_').slice(0, 200);
  const dir = join(uploadDir(), req.tenant.slug);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${fileId}_${safeName}`);
  await writeFile(storagePath, parsed.file.body);

  const leadId = parsed.fields.lead_id ?? null;

  const { rows } = await q(
    `INSERT INTO sales.file (id, tenant_id, lead_id, file_name, file_size, file_type, storage_path, signed_url, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, lead_id, file_name, file_size, file_type, storage_path, signed_url, uploaded_at`,
    [
      fileId,
      req.tenant.id,
      leadId,
      safeName,
      parsed.file.body.length,
      parsed.file.contentType ?? null,
      storagePath,
      `/api/v1/sales/files/${fileId}/download`,
      req.user?.sub ?? null,
    ],
  );
  recordAudit({
    req,
    action: 'create',
    resource: 'sales.file',
    resourceId: rows[0].id,
    payload: {
      after: {
        id: rows[0].id, lead_id: rows[0].lead_id, file_name: rows[0].file_name,
        file_size: rows[0].file_size, file_type: rows[0].file_type,
      },
    },
  });
  created(res, rows[0]);
}

export async function listForLead(req, res, leadId) {
  const { rows } = await q(
    `SELECT id, lead_id, file_name, file_size, file_type, storage_path, signed_url, uploaded_at
       FROM sales.file
      WHERE tenant_id = $1 AND lead_id = $2
      ORDER BY uploaded_at DESC`,
    [req.tenant.id, leadId],
  );
  ok(res, rows);
}

export async function remove(req, res, id) {
  const beforeRes = await q(
    `SELECT id, lead_id, file_name, file_size, file_type, storage_path
       FROM sales.file WHERE tenant_id = $1 AND id = $2`,
    [req.tenant.id, id],
  );
  const before = beforeRes.rows[0] ?? null;
  const { rows } = await q(
    `DELETE FROM sales.file WHERE tenant_id = $1 AND id = $2
     RETURNING storage_path`,
    [req.tenant.id, id],
  );
  if (rows.length === 0) return notFound(res);
  await unlink(rows[0].storage_path).catch(() => {});
  recordAudit({
    req,
    action: 'delete',
    resource: 'sales.file',
    resourceId: id,
    payload: before ? {
      before: {
        id: before.id, lead_id: before.lead_id, file_name: before.file_name,
        file_size: before.file_size, file_type: before.file_type,
      },
    } : null,
  });
  ok(res, { id });
}
