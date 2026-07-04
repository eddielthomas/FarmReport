#!/usr/bin/env node
// =============================================================================
// qa-rls.mjs — OperationsOS A4 RLS isolation sweep.
// -----------------------------------------------------------------------------
// Proves the tenant Row-Level-Security contract on a representative set of
// tables, exercising the CANONICAL rwr.tenant_id GUC (dual-set with the legacy
// app.tenant_id, exactly as pool.mjs does in production code).
//
// IMPORTANT — why a dedicated test role:
//   The app's normal login role (rwr) is SUPERUSER + BYPASSRLS, so RLS (even
//   FORCE) never filters its rows. To actually exercise the policies we connect
//   as a NON-bypass role. This script creates `rwr_rls_test` idempotently (via
//   the admin/superuser pool), grants it read access, then connects AS that role
//   to run every assertion. Without this, the sweep would be a meaningless
//   false-PASS.
//
// Assertions:
//   (1) Cross-tenant isolation (ALL sweep tables): with GUC=tenantA, every
//       visible row.tenant_id == A AND zero tenantB rows are visible. Symmetric
//       for tenantB. This is the core isolation contract and it must hold for
//       BOTH the converged (rwr.tenant_id) policies AND the clearance-combined
//       policies (which still read app.tenant_id — covered by the dual-set).
//   (2) Deny-by-default (PURE tenant-iso tables only): with NO GUC set, FORCE
//       RLS denies all rows (count == 0). The clearance-combined policies
//       (sales.lead, ops.case) are intentionally fail-open on a FULLY-unset
//       connection (unset clearance == default-allow, per 139_classification /
//       ADR-0021); a real request never reaches them without the GUC set, and
//       they are NOT part of the deny-all set here. They are still fully covered
//       by assertion (1).
//
// Exit non-zero on ANY leak. Pure ESM, single dep (pg, already vendored).
// =============================================================================

import pg from 'pg';

const cfg = {
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};

const TEST_ROLE = 'rwr_rls_test';
const TEST_PASS = process.env.RWR_RLS_TEST_PASSWORD ?? 'rls_test';

// Representative sweep set. `pure` = pure tenant-iso policy (converged to
// rwr.tenant_id, denies-by-default on unset GUC). Non-pure = clearance-combined
// (still on app.tenant_id, covered by the dual-set; isolation-tested only).
const SWEEP = [
  { table: 'sales.lead',     pure: false },
  { table: 'sales.proposal', pure: true  },
  { table: 'ops.case',       pure: false },
  { table: 'reports.report', pure: true  },
  // farm vertical — all pure tenant-iso (rwr.tenant_id policies from 210_farm_rls).
  { table: 'farm.farm_profile', pure: true },
  { table: 'farm.observation',  pure: true },
  { table: 'farm.alert',        pure: true },
  { table: 'farm.supplier',     pure: true },
];

// ANSI helpers.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const red   = (s) => c('31', s);
const dim   = (s) => c('2',  s);
const bold  = (s) => c('1',  s);

const failures = [];
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ${green('PASS')} ${label}${detail ? dim(' — ' + detail) : ''}`);
  } else {
    console.log(`  ${red('FAIL')} ${label}${detail ? ' — ' + detail : ''}`);
    failures.push(label + (detail ? ' — ' + detail : ''));
  }
}

async function withScoped(testPool, tid, fn) {
  const client = await testPool.connect();
  try {
    await client.query('BEGIN');
    if (tid) {
      // Same dual-set batch pool.mjs uses (canonical rwr.tenant_id + legacy
      // app.tenant_id alias). clearance left unset (default-allow).
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('rwr.tenant_id', $1, true)`,
        [tid],
      );
    }
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const admin = new pg.Pool(cfg);

  // ---- discover tenants ----------------------------------------------------
  const { rows: tenants } = await admin.query(
    `SELECT id, slug FROM iam.tenant
      WHERE deleted_at IS NULL
      ORDER BY created_at
      LIMIT 2`,
  );
  if (tenants.length < 2) {
    console.error(red('FAIL'), `need >=2 tenants for an isolation sweep; found ${tenants.length}`);
    await admin.end();
    process.exit(1);
  }
  const [A, B] = tenants;
  console.log(bold('RLS isolation sweep'));
  console.log(dim(`  tenant A = ${A.slug} (${A.id})`));
  console.log(dim(`  tenant B = ${B.slug} (${B.id})`));

  // ---- ensure a NON-bypass test role exists --------------------------------
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS',
                     '${TEST_ROLE}', '${TEST_PASS}');
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS',
                     '${TEST_ROLE}', '${TEST_PASS}');
    END IF;
  END $$;`);
  // Read access on the schemas the sweep + RLS policies touch.
  for (const sch of ['sales', 'ops', 'reports', 'iam', 'farm']) {
    await admin.query(`GRANT USAGE ON SCHEMA ${sch} TO ${TEST_ROLE}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${sch} TO ${TEST_ROLE}`);
  }
  // The clearance policies call iam.fn_clearance_meets().
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA iam TO ${TEST_ROLE}`);

  // Sanity: confirm the test role really does NOT bypass RLS.
  const { rows: who } = await admin.query(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = '${TEST_ROLE}'`,
  );
  if (who[0].rolbypassrls || who[0].rolsuper) {
    console.error(red('FAIL'), 'test role unexpectedly bypasses RLS — sweep would be invalid');
    await admin.end();
    process.exit(1);
  }
  await admin.end();

  const testPool = new pg.Pool({ ...cfg, user: TEST_ROLE, password: TEST_PASS, max: 3 });

  // ---- (0) deny-by-default on PRISTINE connections (no GUC EVER set) --------
  // Run this FIRST, each on its own fresh connection. Rationale: once a custom
  // GUC has been SET LOCAL on a backend, current_setting(name, true) returns ''
  // (not NULL) for the rest of that pooled session, and ''::uuid throws. A real
  // request always sets the GUC, so this only matters for the test; we sidestep
  // it by asserting deny-by-default on connections that have never set it.
  console.log(bold('[deny-by-default] pristine connection, no GUC — FORCE RLS must deny pure-iso tables'));
  for (const { table, pure } of SWEEP) {
    if (!pure) {
      console.log(`  ${dim('SKIP')} ${dim(table + ' (clearance-combined: fail-open on fully-unset GUC by design; covered by isolation sweep)')}`);
      continue;
    }
    // Dedicated max:1 pool so the connection is guaranteed pristine.
    const fresh = new pg.Pool({ ...cfg, user: TEST_ROLE, password: TEST_PASS, max: 1 });
    try {
      const guc = (await fresh.query("SELECT current_setting('rwr.tenant_id', true) AS v")).rows[0].v;
      const n = (await fresh.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
      check(n === 0 && (guc === null || guc === ''), `${table}: 0 rows with no GUC`, `count=${n}, guc=${JSON.stringify(guc)}`);
    } finally {
      await fresh.end();
    }
  }

  // ---- (1) cross-tenant isolation, both directions -------------------------
  for (const [self, other, label] of [[A, B, 'A'], [B, A, 'B']]) {
    console.log(bold(`\n[isolation] GUC = tenant ${label} (${self.slug})`));
    await withScoped(testPool, self.id, async (client) => {
      for (const { table } of SWEEP) {
        const total = (await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
        const leaked = (await client.query(
          `SELECT count(*)::int n FROM ${table} WHERE tenant_id = $1`, [other.id],
        )).rows[0].n;
        const wrong = (await client.query(
          `SELECT count(*)::int n FROM ${table} WHERE tenant_id <> $1`, [self.id],
        )).rows[0].n;
        check(
          leaked === 0 && wrong === 0,
          `${table}: only tenant-${label} rows visible`,
          `visible=${total}, other-tenant=${leaked}, foreign=${wrong}`,
        );
      }
    });
  }

  // ---- (2) prove the CANONICAL GUC alone isolates the converged tables ------
  // Set ONLY rwr.tenant_id (no app.tenant_id) and confirm the pure-iso tables
  // still isolate — proves migration 162 actually moved them onto rwr.tenant_id.
  console.log(bold('\n[canonical-only] rwr.tenant_id set, app.tenant_id UNSET — converged tables must isolate'));
  {
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('rwr.tenant_id', $1, true)`, [A.id]);
      for (const { table, pure } of SWEEP) {
        if (!pure) continue;
        const total = (await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
        const leaked = (await client.query(
          `SELECT count(*)::int n FROM ${table} WHERE tenant_id = $1`, [B.id],
        )).rows[0].n;
        check(
          leaked === 0,
          `${table}: isolates on rwr.tenant_id alone`,
          `visible=${total}, other-tenant=${leaked}`,
        );
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  await testPool.end();

  console.log('');
  if (failures.length === 0) {
    console.log(bold(green('qa:rls PASS — no cross-tenant leak; FORCE RLS denies pure-iso tables by default')));
    process.exit(0);
  } else {
    console.log(bold(red(`qa:rls FAIL — ${failures.length} leak(s)/violation(s):`)));
    for (const f of failures) console.log(red('  - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(red('qa:rls ERROR'), err?.message ?? err);
  process.exit(2);
});
