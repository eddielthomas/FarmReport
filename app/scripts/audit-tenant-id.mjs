// =============================================================================
// audit-tenant-id.mjs — Play A tenant isolation schema audit
// -----------------------------------------------------------------------------
// Scans every SQL migration in mvp/api/v1/db/sql/*.sql and asserts, for each
// non-exempt table:
//   1. tenant_id column exists
//   2. tenant_id is UUID NOT NULL
//   3. tenant_id has FK -> iam.tenant(id) (inline or named constraint)
//   4. there is an index whose first column is tenant_id
//
// Zero deps. Pure ESM. Idempotent. Style mirrors mvp/scripts/smoke-*.mjs.
// =============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SQL_DIR   = resolve(REPO_ROOT, 'api', 'v1', 'db', 'sql');

// Tables that legitimately do not require tenant_id.
const EXEMPT = new Set([
  'iam.tenant',                   // the tenant root itself
  'public._migrations',           // platform-global migration ledger
  'iam.team_member',              // join table; tenancy enforced via team.tenant_id
  'public.contact_submission',    // public marketing inbound, pre-tenant
  'public.newsletter_subscriber', // public marketing inbound, pre-tenant
  'public.contact_rate_limit',    // IP-based rate limit, pre-tenant
  // Sprint 1A — identity expansion. Identity is global (cross-tenant by
  // design). token_revocation is platform-global (tenant_id NULLable for
  // platform.admin tokens). Both are gated at the application layer.
  'iam.identity',
  'iam.token_revocation',
  // Sprint 1B — RBAC. permission/field_policy are platform-wide catalogs.
  // iam.role tenant scoping is column-level (tenant_id NULL = system role)
  // so the leading-tenant_id index requirement does not apply. iam.role_permission
  // is a pure join table (tenancy derives from the role). iam.user_role
  // tenancy derives from user_profile.tenant_id (enforced by RLS) so the row
  // does not carry a tenant_id column itself. iam.scope_grant likewise — the
  // user_id implies the tenant; we elide the redundant column.
  'iam.permission',
  'iam.field_policy',
  'iam.role',
  'iam.role_permission',
  'iam.user_role',
  'iam.scope_grant',
  // Sprint 4B — P-009 vendor pool. permission_template is a platform-wide
  // catalog (no tenant_id). geographic_scope is contract-scoped — tenancy
  // is enforced transitively through vendor_pool.contract.tenant_id, so the
  // table intentionally elides a redundant tenant_id column.
  'iam.permission_template',
  'vendor_pool.geographic_scope',
  // Sprint 10B — access codes. tenant_id is NULLABLE because platform-global
  // codes (tenant_id IS NULL) exist by design (minted by platform.admin for
  // cross-tenant pilot cohorts). Tenant-scoped rows still carry a FK; RLS
  // policy access_code_tenant_iso enforces isolation.
  'iam.access_code',
  // Investigation Typing sprint — ops.investigation_type is a platform-wide
  // catalog of investigation kinds (analogous to iam.permission): seeded once,
  // consumed read-only by every tenant. The case carries the tenant_id; this
  // enumeration intentionally does not.
  'ops.investigation_type',
  // Sprint A5.1 — ADR-0024 org hierarchy. These are the ORG TIER, which lives
  // ABOVE the tenant boundary (mirrors iam.tenant / iam.access_code). They carry
  // org_id, not tenant_id, and are NOT RLS-scoped by design.
  'iam.org',               // the contracting parent (a State) — parent tier above tenants.
  'iam.org_role',          // org-tier role catalog (org_id NULL = global template). Above tenancy.
  'iam.org_user_role',     // user→org-role binding; org-scoped via org_id, not tenant-scoped.
  'iam.org_scope_grant',   // A5.3 drill-down entitlements; its tenant_id is the GRANTED CHILD target, not a scoping column.
  'iam.org_role_permission', // org-role-key → permission bundle; org-agnostic catalog (like iam.role_permission).
  // Sprint A5.2 — ADR-0024 oversight roll-up. Org-tier aggregate store (above
  // tenancy): scoping key is org_id; district_id is a SOURCE reference to the
  // child tenant, NOT a tenant scoping column. No RLS by design.
  'analytics.org_rollup',
]);

// ---- ANSI helpers (no deps) -------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const red   = (s) => c('31', s);
const dim   = (s) => c('2',  s);
const bold  = (s) => c('1',  s);

// ---- SQL preprocessing ------------------------------------------------------
// Strip line comments (-- ...) and block comments (/* ... */) but preserve
// newlines so line-number context stays stable for reporting.
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (!inSingle && !inDouble && ch === '-' && nx === '-') {
      // line comment to end of line
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === '/' && nx === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (!inDouble && ch === "'" && sql[i - 1] !== '\\') inSingle = !inSingle;
    else if (!inSingle && ch === '"' && sql[i - 1] !== '\\') inDouble = !inDouble;
    out += ch;
    i++;
  }
  return out;
}

// ---- Extract CREATE TABLE blocks -------------------------------------------
// Returns array of { schema, table, qualified, body, raw }.
function extractCreateTables(sql) {
  const tables = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const schema = m[1].toLowerCase();
    const table  = m[2].toLowerCase();
    const start  = re.lastIndex; // position just after the opening '('
    // Find the matching closing paren respecting nested parens.
    let depth = 1;
    let j = start;
    while (j < sql.length && depth > 0) {
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) continue; // malformed; skip
    const body = sql.slice(start, j);
    tables.push({
      schema,
      table,
      qualified: `${schema}.${table}`,
      body,
      raw: sql.slice(m.index, j + 1),
    });
  }
  return tables;
}

// ---- Extract CREATE INDEX statements ---------------------------------------
// Returns array of { schema, table, firstColumn, raw }.
function extractIndexes(sql) {
  const indexes = [];
  // CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON schema.table [USING ...] ( col ... )
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][\w]*\s+ON\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)(?:\s+USING\s+\w+)?\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const schema = m[1].toLowerCase();
    const table  = m[2].toLowerCase();
    const colList = m[3];
    // First column up to comma or whitespace or DESC/ASC.
    const firstRaw = colList.split(',')[0].trim();
    const firstCol = firstRaw.split(/\s+/)[0].replace(/"/g, '').toLowerCase();
    indexes.push({
      schema,
      table,
      qualified: `${schema}.${table}`,
      firstColumn: firstCol,
      raw: m[0],
    });
  }
  return indexes;
}

// ---- Inspect a table body for tenant_id column + FK ------------------------
// Returns { hasColumn, isUuid, isNotNull, hasFk }.
function inspectTenantId(body) {
  const lines = splitTopLevel(body);
  let hasColumn = false;
  let isUuid = false;
  let isNotNull = false;
  let hasFkInline = false;
  let hasFkNamed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();

    // Column definition: starts with `tenant_id` (optionally quoted).
    if (/^"?tenant_id"?\s+/i.test(trimmed)) {
      hasColumn = true;
      if (/\buuid\b/i.test(trimmed)) isUuid = true;
      if (/\bnot\s+null\b/i.test(trimmed)) isNotNull = true;
      if (/references\s+iam\.tenant\s*\(\s*id\s*\)/i.test(trimmed)) {
        hasFkInline = true;
      }
    }

    // Named table-level constraint:
    //   FOREIGN KEY (tenant_id) REFERENCES iam.tenant(id)
    //   CONSTRAINT xxx FOREIGN KEY (tenant_id) REFERENCES iam.tenant(id)
    if (/foreign\s+key\s*\(\s*tenant_id\s*\)\s*references\s+iam\.tenant\s*\(\s*id\s*\)/i.test(lower)) {
      hasFkNamed = true;
    }
  }

  return {
    hasColumn,
    isUuid,
    isNotNull,
    hasFk: hasFkInline || hasFkNamed,
  };
}

// Split a CREATE TABLE body into top-level comma-separated definitions,
// respecting nested parens (e.g. NUMERIC(12,2), ARRAY[...]::TEXT[]).
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// ---- Main -------------------------------------------------------------------
function main() {
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();

  const allTables = []; // { qualified, schema, table, body, file }
  const allIndexes = []; // { qualified, firstColumn, file }

  for (const f of files) {
    const abs = join(SQL_DIR, f);
    const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
    const raw = readFileSync(abs, 'utf8');
    const sql = stripComments(raw);

    for (const t of extractCreateTables(sql)) {
      allTables.push({ ...t, file: rel });
    }
    for (const idx of extractIndexes(sql)) {
      allIndexes.push({ ...idx, file: rel });
    }
  }

  // De-dupe tables by qualified name (a CREATE TABLE IF NOT EXISTS could
  // theoretically appear twice across migrations — keep the first occurrence).
  const seen = new Set();
  const tables = [];
  for (const t of allTables) {
    if (seen.has(t.qualified)) continue;
    seen.add(t.qualified);
    tables.push(t);
  }

  // Audit
  let passed = 0;
  const violations = []; // { qualified, file, reasons:[] }

  for (const t of tables) {
    if (EXEMPT.has(t.qualified)) {
      console.log(`${green('PASS')} ${t.qualified} ${dim('(exempt)')}`);
      passed++;
      continue;
    }

    const tid = inspectTenantId(t.body);
    const idxs = allIndexes.filter(
      (ix) => ix.qualified === t.qualified && ix.firstColumn === 'tenant_id'
    );

    const reasons = [];
    if (!tid.hasColumn) reasons.push('missing tenant_id column');
    if (tid.hasColumn && !tid.isUuid) reasons.push('tenant_id is not UUID');
    if (tid.hasColumn && !tid.isNotNull) reasons.push('tenant_id is missing NOT NULL');
    if (!tid.hasFk) reasons.push('missing tenant_id FK to iam.tenant(id)');
    if (idxs.length === 0) reasons.push('missing index on (tenant_id, ...)');

    if (reasons.length === 0) {
      console.log(`${green('PASS')} ${t.qualified}`);
      passed++;
    } else {
      console.log(`${red('FAIL')} ${t.qualified}`);
      for (const r of reasons) console.log(`  - ${r}`);
      console.log(`  ${dim('located in: ' + t.file)}`);
      violations.push({ qualified: t.qualified, file: t.file, reasons });
    }
  }

  const total = tables.length;
  const failed = violations.length;
  const line = `${total} tables audited \u00b7 ${passed} passed \u00b7 ${failed} violations`;
  console.log('');
  console.log(bold(failed === 0 ? green(line) : red(line)));

  process.exit(failed === 0 ? 0 : 1);
}

main();
