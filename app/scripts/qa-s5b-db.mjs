// =============================================================================
// qa-s5b-db.mjs — Sprint 5B (EPIC-010 P-010 Phase 3) DB-side QA checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. iam.user_profile.clearance column exists with CHECK constraint
//   2. 15 business tables carry classification column with CHECK constraint
//   3. iam.fn_clearance_meets exists, IMMUTABLE
//   4. Lattice correctness:
//        confidential >= internal => true
//        internal     >= confidential => false
//        secret       >= secret   => true
//        public       >= public   => true
//        public       >= secret   => false
//   5. RLS policies on business tables reference app.clearance / fn_clearance_meets
// =============================================================================

import pg from 'pg';
import { writeFileSync } from 'node:fs';

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);

const CLASSIFICATION_TABLES = [
  ['sales','lead'],
  ['sales','opportunity'],
  ['sales','contact'],
  ['sales','organization'],
  ['sales','activity'],
  ['sales','revenue_record'],
  ['sales','vendor'],
  ['sales','meeting'],
  ['sales','note'],
  ['sales','message'],
  ['sales','file'],
  ['ops','case'],
  ['ops','case_activity'],
  ['ops','case_attachment'],
  ['gis','layer'],
];

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

async function checkClearanceColumn() {
  out.push('-- iam.user_profile.clearance --');
  const cols = await pool.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='iam' AND table_name='user_profile' AND column_name='clearance'`,
  );
  if (cols.rows.length === 0) { fail('iam.user_profile.clearance missing'); return; }
  pass('iam.user_profile.clearance present');
  if (cols.rows[0].is_nullable === 'NO') pass('clearance is NOT NULL');
  else                                    fail('clearance must be NOT NULL');
  if ((cols.rows[0].column_default || '').includes('internal')) pass("clearance DEFAULT 'internal'");
  else                                                           fail(`clearance default wrong: ${cols.rows[0].column_default}`);
  const chk = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'iam.user_profile'::regclass
        AND conname = 'user_profile_clearance_chk'`,
  );
  if (chk.rows.length === 0) { fail('user_profile_clearance_chk missing'); return; }
  const def = chk.rows[0].def;
  if (/public/.test(def) && /internal/.test(def) && /confidential/.test(def) && /secret/.test(def)) {
    pass(`clearance CHECK present (${def.slice(0,80)})`);
  } else {
    fail(`clearance CHECK incomplete: ${def}`);
  }
}

async function checkClassificationColumns() {
  out.push('-- 15 business tables classification columns --');
  for (const [schema, table] of CLASSIFICATION_TABLES) {
    const cols = await pool.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_name='classification'`,
      [schema, table],
    );
    if (cols.rows.length === 0) { fail(`${schema}.${table}.classification missing`); continue; }
    pass(`${schema}.${table}.classification present`);
    if (cols.rows[0].is_nullable !== 'NO') fail(`${schema}.${table}.classification must be NOT NULL`);
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = ($1::text || '.' || $2::text)::regclass
          AND c.conname = ($2::text || '_classification_chk')`,
      [schema, table],
    );
    if (chk.rows.length === 0) fail(`${schema}.${table}: classification CHECK missing`);
    else if (!/public/.test(chk.rows[0].def) || !/secret/.test(chk.rows[0].def))
      fail(`${schema}.${table} CHECK incomplete: ${chk.rows[0].def}`);
  }
}

async function checkLatticeFunction() {
  out.push('-- iam.fn_clearance_meets --');
  const meta = await pool.query(
    `SELECT p.provolatile, p.prorettype::regtype::text AS rettype
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'iam' AND p.proname = 'fn_clearance_meets'`,
  );
  if (meta.rows.length === 0) { fail('iam.fn_clearance_meets missing'); return; }
  pass('iam.fn_clearance_meets defined');
  if (meta.rows[0].provolatile === 'i') pass('fn_clearance_meets is IMMUTABLE');
  else                                   fail(`fn_clearance_meets volatility=${meta.rows[0].provolatile} (expected i)`);
  if (meta.rows[0].rettype === 'boolean') pass('fn_clearance_meets returns boolean');
  else                                     fail(`fn_clearance_meets returns ${meta.rows[0].rettype}`);

  // Lattice cells
  const cases = [
    ['confidential','internal',true],
    ['internal','confidential',false],
    ['secret','secret',true],
    ['public','public',true],
    ['public','secret',false],
  ];
  for (const [s, r, expect] of cases) {
    const got = (await pool.query(`SELECT iam.fn_clearance_meets($1,$2) AS v`, [s,r])).rows[0].v;
    if (got === expect) pass(`fn_clearance_meets('${s}','${r}')=${got}`);
    else                fail(`fn_clearance_meets('${s}','${r}')=${got} expected ${expect}`);
  }
}

async function checkRlsPolicyExtension() {
  out.push('-- RLS policies reference app.clearance --');
  // Tables with a classification column should have policy text that mentions
  // app.clearance.
  const want = new Set(CLASSIFICATION_TABLES.map(([s,t]) => `${s}.${t}`));
  const r = await pool.query(
    `SELECT schemaname, tablename, policyname, qual
       FROM pg_policies
      WHERE schemaname IN ('sales','ops','gis')`,
  );
  const seen = new Set();
  for (const row of r.rows) {
    const key = `${row.schemaname}.${row.tablename}`;
    if (!want.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.qual && row.qual.includes('app.clearance')) pass(`${key}.${row.policyname} references app.clearance`);
    else                                                 fail(`${key}.${row.policyname} missing app.clearance reference`);
  }
  for (const key of want) {
    if (!seen.has(key)) fail(`${key} has no RLS policy at all`);
  }
}

try {
  await checkClearanceColumn();
  await checkClassificationColumns();
  await checkLatticeFunction();
  await checkRlsPolicyExtension();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s5b-db PASS' : `qa-s5b-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s5b-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
