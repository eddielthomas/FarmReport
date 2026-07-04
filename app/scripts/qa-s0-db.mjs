// S0 DB-side QA checks. Uses the existing pg pool.
import pg from 'pg';

const cfg = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);

const out = [];

async function check5_rls() {
  const r = await pool.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relname IN ('user_profile','invite','tenant')
      AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='iam')
    ORDER BY relname
  `);
  out.push(`-- pg_class RLS flags --`);
  for (const row of r.rows) out.push(`  iam.${row.relname} rls=${row.relrowsecurity}`);
  const polr = await pool.query(`
    SELECT polname, polrelid::regclass::text AS tbl
    FROM pg_policy
    WHERE polrelid::regclass::text IN ('iam.user_profile','iam.invite')
    ORDER BY tbl, polname
  `);
  out.push(`-- pg_policy --`);
  for (const row of polr.rows) out.push(`  ${row.tbl}: ${row.polname}`);
}

async function check6_immutable() {
  out.push(`-- iam.audit_event immutability --`);
  // ensure at least one row
  const cnt = await pool.query(`SELECT count(*)::int AS n FROM iam.audit_event`);
  out.push(`  existing rows: ${cnt.rows[0].n}`);
  if (cnt.rows[0].n === 0) {
    out.push(`  WARN: no rows; inserting dummy to exercise trigger`);
    await pool.query(`INSERT INTO iam.audit_event (tenant_id, actor_id, action, resource, resource_id, payload) VALUES ((SELECT id FROM iam.tenant LIMIT 1), NULL, 'qa.test', 'qa', gen_random_uuid(), '{}'::jsonb)`);
  }
  const id = (await pool.query(`SELECT id FROM iam.audit_event LIMIT 1`)).rows[0].id;
  // UPDATE attempt
  try {
    await pool.query(`UPDATE iam.audit_event SET action='tampered' WHERE id=$1`, [id]);
    out.push(`  UPDATE: NO ERROR (UNEXPECTED — FAIL)`);
  } catch (e) {
    out.push(`  UPDATE blocked: ${e.message}`);
  }
  // DELETE attempt
  try {
    await pool.query(`DELETE FROM iam.audit_event WHERE id=$1`, [id]);
    out.push(`  DELETE: NO ERROR (UNEXPECTED — FAIL)`);
  } catch (e) {
    out.push(`  DELETE blocked: ${e.message}`);
  }
}

async function check_migrations_applied() {
  const r = await pool.query(`SELECT filename FROM iam._migration ORDER BY filename DESC LIMIT 5`).catch(() => null);
  if (r) {
    out.push(`-- recent migrations --`);
    for (const row of r.rows) out.push(`  ${row.filename}`);
  } else {
    out.push(`-- migrations table not found (expected if first boot)`);
  }
  // check 112 specifically
  const trig = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='iam.audit_event'::regclass`);
  out.push(`-- triggers on iam.audit_event --`);
  for (const row of trig.rows) out.push(`  ${row.tgname}`);
}

async function check_iam_invite_exists() {
  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='iam' AND table_name='invite'
    ORDER BY ordinal_position
  `);
  out.push(`-- iam.invite columns --`);
  for (const c of cols.rows) out.push(`  ${c.column_name} ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
}

try {
  await check_migrations_applied();
  await check_iam_invite_exists();
  await check5_rls();
  await check6_immutable();
} catch (e) {
  out.push(`FATAL: ${e.message}`);
}

import { writeFileSync } from 'node:fs';
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s0-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
