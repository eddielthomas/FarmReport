#!/usr/bin/env node
// =============================================================================
// MVP /api/v1 — idempotent SQL migration runner.
// -----------------------------------------------------------------------------
// Reads every *.sql file in ./sql/, sorted lexicographically, and applies each
// inside a single transaction. Successfully-applied filenames are recorded in
// public._migrations so re-runs are no-ops.
//
// Standalone usage:
//   node api/v1/db/migrate.mjs
//
// Library usage (server.mjs boot):
//   import { runMigrations } from './v1/db/migrate.mjs';
//   await runMigrations(pool);
// =============================================================================

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, 'sql');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadApplied(client) {
  const { rows } = await client.query('SELECT filename FROM public._migrations');
  return new Set(rows.map((r) => r.filename));
}

export async function runMigrations(pool, opts = {}) {
  const log = opts.log ?? ((...args) => console.log('[migrate]', ...args));
  const files = (await readdir(SQL_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await loadApplied(client);

    for (const file of files) {
      if (applied.has(file)) { log('skip', file); continue; }
      const sql = await readFile(join(SQL_DIR, file), 'utf8');
      log('applying', file);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public._migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log('applied', file);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        log('FAILED', file, err?.message ?? err);
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// CLI entrypoint
const argv1 = (process.argv[1] ?? '').replace(/\\/g, '/');
if (argv1 && (import.meta.url === `file://${argv1}` || import.meta.url.endsWith(argv1))) {
  const cfg = {
    host:     process.env.PGHOST     ?? 'localhost',
    port:     Number(process.env.PGPORT ?? 5433),
    user:     process.env.PGUSER     ?? 'rwr',
    password: process.env.PGPASSWORD ?? 'rwr',
    database: process.env.PGDATABASE ?? 'rwr',
  };
  const pool = new pg.Pool(cfg);
  try {
    await runMigrations(pool);
    console.log('[migrate] done');
  } catch (err) {
    console.error('[migrate] failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
