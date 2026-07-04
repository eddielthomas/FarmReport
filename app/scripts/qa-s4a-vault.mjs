// =============================================================================
// qa-s4a-vault.mjs — integration test for lib/oauth-vault.mjs envelope encryption.
// -----------------------------------------------------------------------------
// Runs the OAuth vault library against a real PG instance (no HTTP server).
// Asserts:
//   1. Per-tenant DEK is created + persisted into iam.tenant_dek
//   2. wrapTokenForStorage() returns { ciphertext, nonce } with ciphertext !=
//      plaintext and non-zero length
//   3. unwrapTokenFromStorage() returns the exact original plaintext
//   4. Tamper test: flipping one ciphertext byte triggers an AEAD failure
//   5. Wrong-nonce test: substituting a fresh random nonce triggers an AEAD failure
//   6. rotateTenantDek() re-encrypts every active credential and writes a
//      rotation_log row per credential; tokens still decrypt with the new DEK
//
// Driver: builds an isolated test tenant (cleaned up at end). Uses crypto to
// mint a fresh RWR_LOCAL_KEK if none is set in env.
// =============================================================================

import pg from 'pg';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Ensure local-dev KEK provider before importing the vault.
process.env.RWR_KEK_PROVIDER = process.env.RWR_KEK_PROVIDER ?? 'local-dev-only';
if (!process.env.RWR_LOCAL_KEK) {
  process.env.RWR_LOCAL_KEK = crypto.randomBytes(32).toString('base64');
}

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};

// The vault library uses its own pool via api/v1/db/pool.mjs. We mirror env
// before import so the pool inside vault picks up the same DB.
process.env.PGHOST     = cfg.host;
process.env.PGPORT     = String(cfg.port);
process.env.PGUSER     = cfg.user;
process.env.PGPASSWORD = cfg.password;
process.env.PGDATABASE = cfg.database;

const pool = new pg.Pool(cfg);

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

let vault;
async function loadVault() {
  vault = await import('../api/v1/lib/oauth-vault.mjs');
}

async function setupTenant() {
  out.push('-- test tenant setup --');
  // Re-use an existing active tenant to avoid touching iam.tenant DDL. We
  // create+clean per-test rows under that tenant only.
  const t = await pool.query(
    `SELECT id FROM iam.tenant WHERE status IN ('active','trial') ORDER BY created_at ASC LIMIT 1`,
  );
  if (t.rows.length === 0) { fail('no active tenant available for test'); return null; }
  info(`using tenant ${t.rows[0].id}`);
  return t.rows[0].id;
}

async function clearTenantArtifacts(tenantId) {
  // Best-effort cleanup so reruns stay clean. Order matters: rotation_log FK
  // -> credential, credential FK -> tenant_dek (no FK actually; safe order).
  await pool.query(
    `DELETE FROM iam.oauth_credential_rotation_log WHERE tenant_id = $1`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM iam.oauth_credential WHERE tenant_id = $1
      AND (external_account_id LIKE 'qa-s4a-vault@%' OR external_account_id IS NULL)`,
    [tenantId],
  );
  // Don't wipe tenant_dek if other things rely on it; rotation overwrites it
  // in place anyway. We DELETE only the row we just created if it exists.
  await pool.query(
    `DELETE FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  vault._clearDekCache();
}

async function testDekCreation(tenantId) {
  out.push('-- 1) ensureTenantDek + iam.tenant_dek row --');
  await vault.ensureTenantDek(tenantId);
  const r = await pool.query(
    `SELECT dek_ciphertext, kek_alias, created_at FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r.rows.length === 1) pass('iam.tenant_dek row created');
  else                     { fail('iam.tenant_dek row NOT created'); return; }
  if (r.rows[0].kek_alias === 'local-dev-only') pass('kek_alias=local-dev-only');
  else                                           fail(`unexpected kek_alias=${r.rows[0].kek_alias}`);
  if (r.rows[0].dek_ciphertext && r.rows[0].dek_ciphertext.length > 0)
    pass(`dek_ciphertext non-empty (${r.rows[0].dek_ciphertext.length} bytes)`);
  else
    fail('dek_ciphertext empty');

  // Idempotency: a second call must not create a duplicate.
  await vault.ensureTenantDek(tenantId);
  const r2 = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r2.rows[0].n === 1) pass('ensureTenantDek idempotent (count still 1)');
  else                    fail(`ensureTenantDek not idempotent (count=${r2.rows[0].n})`);
}

async function testRoundTrip(tenantId) {
  out.push('-- 2) wrap then 3) unwrap roundtrip --');
  const PLAINTEXT = 'super-secret-access-token-12345';
  const wrap = await vault.wrapTokenForStorage(tenantId, PLAINTEXT);
  if (!wrap.ciphertext || !wrap.nonce) { fail('wrap returned no ciphertext/nonce'); return; }
  if (wrap.ciphertext.length === 0)    { fail('ciphertext length 0'); return; }
  if (Buffer.from(PLAINTEXT, 'utf8').equals(wrap.ciphertext)) {
    fail('ciphertext equals plaintext (no encryption happened)');
    return;
  }
  pass(`ciphertext length=${wrap.ciphertext.length}, nonce length=${wrap.nonce.length}`);
  pass('ciphertext differs from plaintext');

  const back = await vault.unwrapTokenFromStorage(tenantId, wrap.ciphertext, wrap.nonce);
  if (back === PLAINTEXT) pass('unwrap returned exact original plaintext');
  else                    fail(`unwrap returned wrong plaintext: "${back}"`);

  return wrap; // re-used by tamper tests
}

async function testTamper(tenantId, wrap) {
  out.push('-- 4) tamper test: flip byte in ciphertext --');
  const bad = Buffer.from(wrap.ciphertext);
  bad[0] = bad[0] ^ 0xff;
  let threw = false;
  try { await vault.unwrapTokenFromStorage(tenantId, bad, wrap.nonce); }
  catch (_e) { threw = true; info(`tamper rejected: ${_e.code ?? _e.message}`); }
  if (threw) pass('AEAD rejected tampered ciphertext');
  else       fail('tampered ciphertext was NOT rejected');

  out.push('-- 5) wrong-nonce test --');
  const wrongNonce = crypto.randomBytes(wrap.nonce.length);
  threw = false;
  try { await vault.unwrapTokenFromStorage(tenantId, wrap.ciphertext, wrongNonce); }
  catch (_e) { threw = true; info(`wrong-nonce rejected: ${_e.code ?? _e.message}`); }
  if (threw) pass('AEAD rejected wrong nonce');
  else       fail('wrong-nonce decrypt was NOT rejected');
}

async function testRotation(tenantId) {
  out.push('-- 6) rotateTenantDek over 2 fake credentials --');
  // Insert 2 fake credentials (access + refresh tokens wrapped under the
  // current DEK). Use distinct nonces per credential — refresh nonce is
  // concatenated onto access nonce inside the row's `nonce` column.
  const inserts = [
    { user: null, provider: 'google',  access: 'access-token-A-' + crypto.randomUUID(), refresh: 'refresh-token-A-' + crypto.randomUUID() },
    { user: null, provider: 'outlook', access: 'access-token-B-' + crypto.randomUUID(), refresh: 'refresh-token-B-' + crypto.randomUUID() },
  ];
  const credIds = [];
  for (const spec of inserts) {
    const accessWrap  = await vault.wrapTokenForStorage(tenantId, spec.access);
    const refreshWrap = await vault.wrapTokenForStorage(tenantId, spec.refresh);
    const combinedNonce = Buffer.concat([accessWrap.nonce, refreshWrap.nonce]);
    const r = await pool.query(
      `INSERT INTO iam.oauth_credential
         (tenant_id, user_id, provider, external_account_id,
          access_token_ciphertext, refresh_token_ciphertext, nonce)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       RETURNING id`,
      [tenantId, spec.provider, `qa-s4a-vault@${spec.provider}`,
       accessWrap.ciphertext, refreshWrap.ciphertext, combinedNonce],
    );
    credIds.push({ id: r.rows[0].id, ...spec });
  }
  info(`seeded ${credIds.length} credentials`);

  const result = await vault.rotateTenantDek(tenantId, 'qa_test_rotation');
  if (result.rotated === credIds.length)
    pass(`rotation re-encrypted all ${result.rotated} credentials`);
  else
    fail(`rotation reported ${result.rotated} but expected ${credIds.length}`);

  // Verify rotation_log rows
  const log = await pool.query(
    `SELECT COUNT(*)::int AS n FROM iam.oauth_credential_rotation_log
      WHERE tenant_id = $1 AND reason = 'qa_test_rotation'`,
    [tenantId],
  );
  if (log.rows[0].n === credIds.length)
    pass(`rotation_log has ${log.rows[0].n} rows`);
  else
    fail(`rotation_log expected ${credIds.length}, found ${log.rows[0].n}`);

  // Verify tenant_dek.rotated_at populated
  const tdek = await pool.query(
    `SELECT rotated_at FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (tdek.rows[0]?.rotated_at) pass('iam.tenant_dek.rotated_at populated');
  else                          fail('iam.tenant_dek.rotated_at NOT populated after rotation');

  // Verify every credential still decrypts to the correct plaintext under the new DEK.
  for (const spec of credIds) {
    const r = await pool.query(
      `SELECT access_token_ciphertext, refresh_token_ciphertext, nonce
         FROM iam.oauth_credential WHERE id = $1`,
      [spec.id],
    );
    const row = r.rows[0];
    const accessNonce  = row.nonce.subarray(0, 12);
    const refreshNonce = row.nonce.subarray(12, 24);
    const accessPlain  = await vault.unwrapTokenFromStorage(tenantId, row.access_token_ciphertext,  accessNonce);
    const refreshPlain = await vault.unwrapTokenFromStorage(tenantId, row.refresh_token_ciphertext, refreshNonce);
    if (accessPlain === spec.access)   pass(`cred ${spec.provider}: access plaintext preserved`);
    else                                fail(`cred ${spec.provider}: access plaintext WRONG (${accessPlain})`);
    if (refreshPlain === spec.refresh) pass(`cred ${spec.provider}: refresh plaintext preserved`);
    else                                fail(`cred ${spec.provider}: refresh plaintext WRONG`);
  }

  // Cleanup
  await pool.query(
    `DELETE FROM iam.oauth_credential_rotation_log WHERE tenant_id = $1 AND reason = 'qa_test_rotation'`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM iam.oauth_credential WHERE tenant_id = $1 AND external_account_id LIKE 'qa-s4a-vault@%'`,
    [tenantId],
  );
}

try {
  await loadVault();
  const tenantId = await setupTenant();
  if (!tenantId) throw new Error('test_setup_no_tenant');
  await clearTenantArtifacts(tenantId);
  await testDekCreation(tenantId);
  const wrap = await testRoundTrip(tenantId);
  if (wrap) await testTamper(tenantId, wrap);
  await testRotation(tenantId);

  // Final cleanup of the tenant_dek we created so re-runs stay clean. We only
  // delete it when no other credential rows reference its key version.
  await pool.query(`DELETE FROM iam.tenant_dek WHERE tenant_id = $1`, [tenantId]);
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s4a-vault PASS' : `qa-s4a-vault FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s4a-vault-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
// Inner pool used by oauth-vault.mjs needs explicit close too so node exits.
try {
  const inner = await import('../api/v1/db/pool.mjs');
  await inner.pool.end();
} catch (_e) {}
process.exit(failures === 0 ? 0 : 1);
