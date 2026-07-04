// =============================================================================
// lib/minio.mjs — single MinIO client + helpers used by field uploads (S9A).
// -----------------------------------------------------------------------------
// The MinIO npm package (already in dependencies for seed-minio.mjs) supports
// both putObject + presignedGetObject. We reuse that to keep the dep surface
// tight (no @aws-sdk addition) and match the existing seed script style.
//
// Env defaults match the ecosystem/docker-compose:
//   MINIO_ENDPOINT=localhost  MINIO_PORT=39000  MINIO_SSL=false
//   MINIO_ACCESS_KEY=rwr-admin  MINIO_SECRET_KEY=rwr-admin-secret
//
// Module is lazy: client + bucket creation only happen on first use so tests
// that never hit the upload path don't need MinIO running.
// =============================================================================

let _mc = null;
let _bucketReady = false;

const FIELD_BUCKET = process.env.MINIO_FIELD_BUCKET ?? 'rwr-field-uploads';

async function getClient() {
  if (_mc) return _mc;
  const mod = await import('minio');
  const { Client } = mod;
  _mc = new Client({
    endPoint:  process.env.MINIO_ENDPOINT  ?? 'localhost',
    // Default 9000 matches infra/docker-compose.yml; the orchestrator brief
    // mentions 39000 — both honoured via MINIO_PORT env override.
    port:      Number(process.env.MINIO_PORT ?? 9000),
    useSSL:    (process.env.MINIO_SSL ?? 'false') === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'rwr-admin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'rwr-admin-secret',
  });
  return _mc;
}

export async function ensureFieldBucket() {
  if (_bucketReady) return FIELD_BUCKET;
  const mc = await getClient();
  const exists = await mc.bucketExists(FIELD_BUCKET).catch(() => false);
  if (!exists) {
    await mc.makeBucket(FIELD_BUCKET, process.env.MINIO_REGION ?? 'us-east-1');
  }
  _bucketReady = true;
  return FIELD_BUCKET;
}

export async function putFieldObject(objectKey, buffer, contentType) {
  const mc = await getClient();
  const bucket = await ensureFieldBucket();
  await mc.putObject(bucket, objectKey, buffer, buffer.length, {
    'Content-Type': contentType ?? 'application/octet-stream',
  });
  return { bucket, key: objectKey };
}

export async function signedGetUrl(bucket, key, ttlSeconds = 3600) {
  const mc = await getClient();
  return await mc.presignedGetObject(bucket, key, ttlSeconds);
}

export function getFieldBucketName() { return FIELD_BUCKET; }
