// =============================================================================
// Tiny request/response helpers shared across /api/v1 handlers.
// Keeps the existing vanilla-http style (no express) so the v1 router slots
// into api/server.mjs with zero extra dependencies.
// =============================================================================

import { randomUUID } from 'node:crypto';

const ORIGIN = process.env.CORS_ORIGIN ?? '*';

export function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-tenant-id',
    'access-control-expose-headers': 'x-request-id',
    'x-request-id': res.req?.requestId ?? randomUUID(),
  });
  res.end(payload);
}

export const ok    = (res, data)        => send(res, 200, { success: true,  data });
export const created = (res, data)      => send(res, 201, { success: true,  data });
export const noContent = (res)          => send(res, 204, { success: true,  data: null });
export const badReq = (res, error)      => send(res, 400, { success: false, error });
export const unauth = (res, error='unauthorized') => send(res, 401, { success: false, error });
export const forbid = (res, error='forbidden')    => send(res, 403, { success: false, error });
export const notFound = (res, error='not_found') => send(res, 404, { success: false, error });
export const serverErr = (res, err) => {
  console.error('[api/v1] error:', err);
  send(res, 500, { success: false, error: 'internal_error', detail: String(err?.message ?? err) });
};

const TEXT_TYPES = /^(application\/json|application\/x-www-form-urlencoded|text\/)/i;

export function readBody(req, opts = {}) {
  const limit = opts.limit ?? 5 * 1024 * 1024; // 5 MB default
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      const ctype = (req.headers['content-type'] ?? '').toLowerCase();
      if (ctype.startsWith('application/json')) {
        try { resolve(JSON.parse(buf.toString('utf8'))); }
        catch (e) { reject(new Error('invalid_json')); }
        return;
      }
      if (TEXT_TYPES.test(ctype)) { resolve(buf.toString('utf8')); return; }
      resolve(buf); // raw buffer for multipart / octet-stream
    });
    req.on('error', reject);
  });
}

export function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function parseQuery(url) {
  return Object.fromEntries(new URL(url, 'http://x').searchParams.entries());
}
