#!/usr/bin/env node
// =============================================================================
// Push the harvested SharePoint deliverable binaries into MinIO bucket
// `rwr-harvest` so the dev stack has a real object-store-backed source.
// -----------------------------------------------------------------------------
// Usage:  npm run seed:minio
// =============================================================================

import { Client } from 'minio';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const HARVEST_LIVE  = join(ROOT, '..', 'harvest');
const SP_DIR_LIVE   = join(HARVEST_LIVE, 'eo-discover', 'sub-projects', '676251', 'binaries', 'sharepoint');
const SP_DIR_LOCAL  = join(ROOT, 'src', 'data', 'harvest', 'sharepoint');

const cfg = {
  endPoint:  process.env.MINIO_ENDPOINT  ?? 'localhost',
  port:      Number(process.env.MINIO_PORT ?? 9000),
  useSSL:    (process.env.MINIO_SSL ?? 'false') === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'rwr-admin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'rwr-admin-secret',
};
const BUCKET = process.env.MINIO_BUCKET ?? 'rwr-harvest';

async function pickDir() {
  for (const p of [SP_DIR_LIVE, SP_DIR_LOCAL]) {
    try { await stat(p); return p; } catch { /* try next */ }
  }
  throw new Error(`No SharePoint binaries found at ${SP_DIR_LIVE} nor ${SP_DIR_LOCAL}`);
}

async function* walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const contentTypeFor = (name) => {
  const e = name.toLowerCase().split('.').pop();
  return ({
    pdf:  'application/pdf',
    json: 'application/json',
    xml:  'application/xml',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    zip:  'application/zip',
    kmz:  'application/vnd.google-earth.kmz',
    kml:  'application/vnd.google-earth.kml+xml',
    png:  'image/png',
    jpg:  'image/jpeg', jpeg: 'image/jpeg',
  })[e] ?? 'application/octet-stream';
};

async function main() {
  const dir = await pickDir();
  const mc  = new Client(cfg);
  console.log(`source: ${dir}`);
  console.log(`target: minio://${cfg.endPoint}:${cfg.port}/${BUCKET}`);

  const exists = await mc.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await mc.makeBucket(BUCKET, cfg.region ?? 'us-east-1');
    console.log(`  + created bucket ${BUCKET}`);
  }

  // S9A — ensure the field-uploads bucket exists so /field/uploads can write
  // immediately on dev startup. We do NOT seed any objects; it's an empty
  // namespace until a technician uploads.
  for (const extra of ['rwr-derived', 'rwr-field-uploads']) {
    const e = await mc.bucketExists(extra).catch(() => false);
    if (!e) {
      await mc.makeBucket(extra, cfg.region ?? 'us-east-1');
      console.log(`  + created bucket ${extra}`);
    }
  }

  const prefix = 'sub-projects/676251/sharepoint';
  let n = 0, bytes = 0;
  for await (const file of walk(dir)) {
    const buf = await readFile(file);
    const rel = relative(dir, file).split(sep).join('/');
    const objectName = `${prefix}/${rel}`;
    await mc.putObject(BUCKET, objectName, buf, buf.length, {
      'Content-Type': contentTypeFor(rel),
    });
    n += 1; bytes += buf.length;
    console.log(`  ↑ ${objectName}  (${buf.length} B)`);
  }
  console.log(`\nuploaded ${n} object(s), ${bytes} bytes total to s3://${BUCKET}/${prefix}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
