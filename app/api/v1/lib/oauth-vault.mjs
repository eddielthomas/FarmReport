// =============================================================================
// lib/oauth-vault.mjs — envelope-encryption wrapper for OAuth tokens
// -----------------------------------------------------------------------------
// Two-layer key model (NIST 800-57):
//   KEK (Key Encryption Key) — owned by a KMS provider (AWS KMS / GCP KMS /
//                              Azure Key Vault). NEVER persisted in plaintext.
//                              Resolved via RWR_KEK_PROVIDER.
//   DEK (Data Encryption Key) — per-tenant 256-bit symmetric key. Stored in
//                               iam.tenant_dek as KEK-wrapped ciphertext;
//                               unwrapped briefly in memory to encrypt or
//                               decrypt individual OAuth token rows.
//
// Token encryption uses AES-256-GCM. The auth tag is appended to the
// ciphertext payload so unwrapping rejects any tamper / wrong-nonce attempt
// with an AEAD authentication failure. Each (token, nonce) pair is freshly
// minted — nonces are NEVER reused under the same key.
//
// KEK providers are pluggable. Phase 1 ships only `local-dev-only` which
// reads a base64-encoded master key from RWR_LOCAL_KEK. The other three
// providers (aws-kms / gcp-kms / azure-kv) throw `kms_provider_not_implemented`
// — adding a real provider is a single-file addition keyed off the switch in
// resolveKekProvider().
//
// Public API:
//   ensureTenantDek(tenantId)                            → void (idempotent)
//   getTenantDek(tenantId)                               → Buffer (32 bytes)
//   wrapTokenForStorage(tenantId, plaintext)             → { ciphertext, nonce }
//   unwrapTokenFromStorage(tenantId, ciphertext, nonce)  → plaintext string
//   rotateTenantDek(tenantId, reason?)                   → { rotated: number }
// =============================================================================

import crypto from 'node:crypto';
import { q } from '../db/pool.mjs';

const DEK_BYTES   = 32;   // AES-256
const NONCE_BYTES = 12;   // GCM standard
const TAG_BYTES   = 16;   // GCM auth tag length

// In-process DEK cache. The plaintext DEK is only held briefly; a cache miss
// re-fetches and re-unwraps. TTL keeps it short so a rotation is observed
// within five minutes even without explicit eviction.
const DEK_TTL_MS = 5 * 60 * 1000;
const dekCache = new Map(); // tenantId -> { dek: Buffer, exp: number }

// ---- KEK provider abstraction ----------------------------------------------
// Provider interface: { alias, wrap(plaintext): Buffer, unwrap(blob): Buffer }
// Providers are responsible for any framing they need (nonces, tags, KMS
// envelope metadata). DEK plaintext is opaque to the provider.

function resolveKekProvider() {
  const which = (process.env.RWR_KEK_PROVIDER ?? 'local-dev-only').toLowerCase();
  switch (which) {
    case 'local-dev-only': return localDevProvider();
    case 'aws-kms':
    case 'gcp-kms':
    case 'azure-kv':
      return {
        alias: which,
        wrap:   () => { throw new Error('kms_provider_not_implemented:' + which); },
        unwrap: () => { throw new Error('kms_provider_not_implemented:' + which); },
      };
    default:
      throw new Error('kms_provider_unknown:' + which);
  }
}

function localDevProvider() {
  // Master key from env (base64). Generate if missing AND we are clearly in
  // dev (NODE_ENV != production). In prod, refuse to start — surface ops error.
  let b64 = process.env.RWR_LOCAL_KEK;
  if (!b64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RWR_LOCAL_KEK_missing_in_production');
    }
    const fresh = crypto.randomBytes(DEK_BYTES);
    b64 = fresh.toString('base64');
    process.env.RWR_LOCAL_KEK = b64;
    console.warn('[oauth-vault] generated ephemeral RWR_LOCAL_KEK for dev (set in env to persist across restarts)');
  }
  const master = Buffer.from(b64, 'base64');
  if (master.length !== DEK_BYTES) {
    throw new Error(`RWR_LOCAL_KEK_must_be_${DEK_BYTES}_bytes_base64`);
  }
  return {
    alias: 'local-dev-only',
    wrap(plaintext) {
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', master, nonce);
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Frame: nonce || tag || ciphertext. Self-describing so unwrap needs no metadata.
      return Buffer.concat([nonce, tag, ct]);
    },
    unwrap(blob) {
      if (blob.length < NONCE_BYTES + TAG_BYTES) {
        throw new Error('kek_ciphertext_truncated');
      }
      const nonce = blob.subarray(0, NONCE_BYTES);
      const tag   = blob.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ct    = blob.subarray(NONCE_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', master, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    },
  };
}

// ---- Public API ------------------------------------------------------------

// Idempotently provision a fresh DEK for the tenant.
export async function ensureTenantDek(tenantId) {
  if (!tenantId) throw new Error('tenantId_required');
  const existing = await q(
    `SELECT 1 FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (existing.rows.length) return;
  const provider = resolveKekProvider();
  const dek = crypto.randomBytes(DEK_BYTES);
  const wrapped = provider.wrap(dek);
  await q(
    `INSERT INTO iam.tenant_dek (tenant_id, dek_ciphertext, kek_alias)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, wrapped, provider.alias],
  );
}

// Resolve the live plaintext DEK for a tenant. Caches for DEK_TTL_MS.
export async function getTenantDek(tenantId) {
  if (!tenantId) throw new Error('tenantId_required');
  const now = Date.now();
  const hit = dekCache.get(tenantId);
  if (hit && hit.exp > now) return hit.dek;

  const { rows } = await q(
    `SELECT dek_ciphertext, kek_alias FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (rows.length === 0) throw new Error('tenant_dek_missing:' + tenantId);
  const provider = resolveKekProvider();
  if (provider.alias !== rows[0].kek_alias) {
    // If the env switches providers mid-flight, refuse rather than risk a
    // wrong-unwrap attempt. Ops must run a real rotation to migrate aliases.
    throw new Error(`kek_alias_mismatch:expected=${rows[0].kek_alias},current=${provider.alias}`);
  }
  const dek = provider.unwrap(rows[0].dek_ciphertext);
  dekCache.set(tenantId, { dek, exp: now + DEK_TTL_MS });
  return dek;
}

// Encrypt a plaintext token for storage. Returns Buffers — the caller persists
// them into BYTEA columns. Each call mints a FRESH nonce; never reuse one.
export async function wrapTokenForStorage(tenantId, plaintext) {
  if (plaintext == null) throw new Error('plaintext_required');
  const dek = await getTenantDek(tenantId);
  return aesGcmEncrypt(dek, plaintext);
}

// Inverse of wrapTokenForStorage. Throws on AEAD auth failure (tamper, wrong
// nonce, wrong DEK).
export async function unwrapTokenFromStorage(tenantId, ciphertext, nonce) {
  const dek = await getTenantDek(tenantId);
  const buf = aesGcmDecrypt(dek, ciphertext, nonce);
  return buf.toString('utf8');
}

// Rotate the per-tenant DEK. Decrypts every active credential with the old
// DEK, re-encrypts with the new DEK + FRESH nonces, writes a rotation_log row
// per credential, then replaces the tenant_dek row. Returns count rotated.
//
// Note: access_token and refresh_token live in the same row. They share the
// `nonce` column but were encrypted under DIFFERENT nonces at write time —
// the access nonce is the row's `nonce` column; the refresh nonce is derived
// by combining the row's nonce with a per-column salt. To keep the schema
// simple in Phase 1 we encrypt access + refresh as a single bundled JSON blob
// using the row's nonce, and store the resulting ciphertext in
// access_token_ciphertext while leaving refresh_token_ciphertext NULL when
// the bundling is in use. Phase 2 (when real OAuth tokens land) re-models
// this to per-column nonces once we add a refresh_nonce column.
//
// For rotation we treat each existing credential as opaque: decrypt whatever
// access_token_ciphertext + refresh_token_ciphertext are present using the
// SAME stored nonce (because rotation always re-uses nonces only across DEK
// changes — not within a single DEK). We then re-encrypt each ciphertext with
// a FRESH per-token nonce. We store both nonces concatenated in the `nonce`
// column when both tokens are present: [access_nonce(12) || refresh_nonce(12)].
export async function rotateTenantDek(tenantId, reason = 'manual_rotation') {
  if (!tenantId) throw new Error('tenantId_required');

  // 1. Load existing DEK to decrypt active credentials.
  const oldDek = await getTenantDek(tenantId);
  const { rows: oldMeta } = await q(
    `SELECT kek_alias FROM iam.tenant_dek WHERE tenant_id = $1`,
    [tenantId],
  );
  if (oldMeta.length === 0) throw new Error('tenant_dek_missing:' + tenantId);
  const oldAlias = oldMeta[0].kek_alias;

  // 2. Mint a fresh DEK and wrap with the active KEK provider.
  const provider = resolveKekProvider();
  const newDek = crypto.randomBytes(DEK_BYTES);
  const newWrapped = provider.wrap(newDek);

  // 3. Re-encrypt every live credential with the new DEK.
  const { rows: creds } = await q(
    `SELECT id, access_token_ciphertext, refresh_token_ciphertext, nonce
       FROM iam.oauth_credential
      WHERE tenant_id = $1 AND revoked_at IS NULL`,
    [tenantId],
  );
  const reEncrypted = [];
  for (const c of creds) {
    const accessNonce = c.nonce ? c.nonce.subarray(0, NONCE_BYTES) : null;
    const refreshNonce = c.nonce && c.nonce.length >= NONCE_BYTES * 2
      ? c.nonce.subarray(NONCE_BYTES, NONCE_BYTES * 2)
      : null;

    let newAccess = null, newRefresh = null;
    let newNonceBuf = Buffer.alloc(0);

    if (c.access_token_ciphertext && accessNonce) {
      const accessPlain = aesGcmDecrypt(oldDek, c.access_token_ciphertext, accessNonce);
      const enc = aesGcmEncrypt(newDek, accessPlain);
      newAccess = enc.ciphertext;
      newNonceBuf = Buffer.concat([newNonceBuf, enc.nonce]);
    }
    if (c.refresh_token_ciphertext && refreshNonce) {
      const refreshPlain = aesGcmDecrypt(oldDek, c.refresh_token_ciphertext, refreshNonce);
      const enc = aesGcmEncrypt(newDek, refreshPlain);
      newRefresh = enc.ciphertext;
      newNonceBuf = Buffer.concat([newNonceBuf, enc.nonce]);
    }

    reEncrypted.push({
      id: c.id,
      access: newAccess,
      refresh: newRefresh,
      nonce: newNonceBuf.length > 0 ? newNonceBuf : null,
    });
  }

  // 4. Apply all updates in a transaction so a rotation either fully lands or
  //    rolls back. Cache is cleared on success so subsequent reads fetch the
  //    new DEK.
  await q('BEGIN');
  try {
    await q(
      `UPDATE iam.tenant_dek
          SET dek_ciphertext = $1, kek_alias = $2, rotated_at = now()
        WHERE tenant_id = $3`,
      [newWrapped, provider.alias, tenantId],
    );
    for (const r of reEncrypted) {
      await q(
        `UPDATE iam.oauth_credential
            SET access_token_ciphertext  = $1,
                refresh_token_ciphertext = $2,
                nonce                    = $3,
                updated_at               = now()
          WHERE id = $4`,
        [r.access, r.refresh, r.nonce, r.id],
      );
      await q(
        `INSERT INTO iam.oauth_credential_rotation_log
           (tenant_id, credential_id, reason, kek_alias_from, kek_alias_to)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, r.id, reason, oldAlias, provider.alias],
      );
    }
    await q('COMMIT');
  } catch (err) {
    await q('ROLLBACK').catch(() => {});
    throw err;
  }

  dekCache.delete(tenantId);
  return { rotated: reEncrypted.length };
}

// ---- Low-level AES-GCM helpers ---------------------------------------------

function aesGcmEncrypt(dek, plaintext) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([ct, tag]), nonce };
}

function aesGcmDecrypt(dek, ciphertext, nonce) {
  if (!Buffer.isBuffer(ciphertext)) ciphertext = Buffer.from(ciphertext);
  if (!Buffer.isBuffer(nonce))      nonce      = Buffer.from(nonce);
  if (ciphertext.length < TAG_BYTES) throw new Error('ciphertext_truncated');
  const ct  = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Test seam — clears the in-process DEK cache. Used by qa-s4a-vault.mjs to
// force a re-fetch after rotation.
export function _clearDekCache() {
  dekCache.clear();
}
