// =============================================================================
// audit.mjs — fire-and-forget audit event emitter.
// -----------------------------------------------------------------------------
// Wraps inserts into iam.audit_event. Never blocks the caller: any DB failure
// is logged to stderr and swallowed so the originating mutation still returns.
// Callers pass the live req so we can stamp tenant, actor, request id, ip, ua.
//
// PII / secret hygiene: payload is run through redactSecrets() before insert.
// Any key matching /(password|token|secret|api_key|jwt|bearer)/i (recursive,
// case-insensitive) is replaced with the sentinel string '[REDACTED]'.
//
// Request correlation:
//   - X-Correlation-Id header wins (so cross-service traces preserve)
//   - falls back to req.requestId (server-assigned UUID)
// =============================================================================

import { q } from './db/pool.mjs';

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

const SECRET_KEY_RE = /(password|token|secret|api[_-]?key|jwt|bearer)/i;

// Recursive redactor. Drops secret-named fields anywhere in the payload tree.
// Arrays preserve order; objects preserve key-set minus redacted keys.
export function redactSecrets(input) {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (SECRET_KEY_RE.test(k)) { out[k] = '[REDACTED]'; continue; }
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return input;
}

function pickCorrelationId(req) {
  const hdr = req?.headers?.['x-correlation-id'];
  if (typeof hdr === 'string' && hdr.length > 0 && hdr.length <= 128) return hdr;
  return req?.requestId ?? null;
}

// Sprint 5B (EPIC-010 P-010 Phase 3) — every audit row now carries a
// `subject_clearance` field (the caller's Bell-LaPadula clearance at the time
// of the mutation, defaulted to 'internal' when unbound) and, when the caller
// supplies it, `resource_classification` (the row's classification). Both are
// merged into the persisted payload JSONB so forensic replay can answer
// "could the actor legally have seen this row at the time?". The classification
// value comes from payload.classification when provided by the caller, or
// payload.after?.classification when the caller hands the post-mutation row in.
export function recordAudit(arg1, action2, resource2, resourceId2, payload2) {
  // Backwards-compatible signature: recordAudit({req, action, resource, ...})
  // OR recordAudit(req, action, resource, resourceId, payload).
  let req, action, resource, resourceId = null, payload = null;
  if (arg1 && typeof arg1 === 'object' && 'action' in arg1) {
    ({ req, action, resource, resourceId = null, payload = null } = arg1);
  } else {
    req = arg1; action = action2; resource = resource2;
    resourceId = resourceId2 ?? null; payload = payload2 ?? null;
  }
  try {
    const tenantId = req?.tenant?.id;
    if (!tenantId) return; // no-op for anonymous / tenantless requests
    const actorId    = req?.user?.sub ?? null;
    const actorEmail = req?.user?.email ?? null;
    const requestId  = pickCorrelationId(req);
    const ua         = req?.headers?.['user-agent'] ?? null;
    const ip         = clientIp(req);
    const safePayload = redactSecrets(payload ?? {});
    // Sprint 5B classification stamps. Subject clearance is always known
    // (default 'internal'). Resource classification is opportunistic — the
    // caller passes payload.classification or payload.after.classification.
    safePayload.subject_clearance = req?.user?.clearance || 'internal';
    const rc = (safePayload && (
      safePayload.resource_classification ??
      safePayload.classification ??
      safePayload.after?.classification ??
      safePayload.before?.classification ??
      null
    ));
    if (rc) safePayload.resource_classification = rc;
    // Fire-and-forget. We deliberately do not await — audit must not slow
    // the response path nor surface failures to the client.
    q(
      `INSERT INTO iam.audit_event
         (tenant_id, actor_id, actor_email, action, resource, resource_id,
          payload, request_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        tenantId,
        actorId,
        actorEmail,
        String(action),
        String(resource),
        resourceId == null ? null : String(resourceId),
        JSON.stringify(safePayload),
        requestId,
        ip,
        ua,
      ],
    ).catch((err) => {
      console.error('[audit] insert_failed:', err?.message ?? err);
    });
  } catch (err) {
    console.error('[audit] emit_failed:', err?.message ?? err);
  }
}
