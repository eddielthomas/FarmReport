// =============================================================================
// field-relay.mjs — single fan-out point for field-service WS events (S9A).
// -----------------------------------------------------------------------------
// REST handlers under /field/* call publishFieldEvent(req.io, type, payload)
// after the DB INSERT + recordAudit. Mirrors the lib/chat-relay.mjs pattern:
//
//   - schema_version === 1
//   - room key = `field:tenant:<tenant_id>` (single bus per tenant; volume is
//     manageable + every recipient cares about every tenant-scoped field
//     event)
//   - Idempotent / safe in tests: if `io` is null/undefined, the helper no-ops.
//   - NEVER throws — handlers must not fail because relay is down.
//
// Topic enum:
//   field.tech.moved             — { user_id, location, accuracy_m, captured_at }
//   field.job.assigned           — { job_id, assigned_to, before, after }
//   field.job.status_changed     — { job_id, from, to }
//   field.geofence.entered       — { job_id, user_id, distance_m }
//   field.geofence.exited        — { job_id, user_id, distance_m }
//   field.upload.created         — { upload_id, job_id, user_id, gps_verified }
//   field.time_entry.opened      — { time_entry_id, job_id, user_id, started_at }
//   field.time_entry.closed      — { time_entry_id, job_id, user_id, ended_at, duration_seconds }
//   field.spoofing_suspected     — { user_id, job_id, distance_m, reason }
// =============================================================================

import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;

const ALLOWED_TYPES = new Set([
  'field.tech.moved',
  'field.job.assigned',
  'field.job.status_changed',
  'field.geofence.entered',
  'field.geofence.exited',
  'field.upload.created',
  'field.time_entry.opened',
  'field.time_entry.closed',
  'field.spoofing_suspected',
]);

function roomFor(tenantId) {
  if (!tenantId) return null;
  return `field:tenant:${tenantId}`;
}

/**
 * Publish a field-service event envelope to the connected socket.io fanout.
 *
 * @param {import('socket.io').Server | null | undefined} io
 * @param {string} type — one of ALLOWED_TYPES
 * @param {object} payload — MUST include tenant_id so we can route
 */
export function publishFieldEvent(io, type, payload) {
  try {
    if (!io || typeof io.to !== 'function') return;
    if (!type || typeof payload !== 'object' || payload == null) return;
    if (!ALLOWED_TYPES.has(type)) return;
    const tenantId = payload.tenant_id ?? null;
    const room = roomFor(tenantId);
    if (!room) return;
    const envelope = {
      event_id:       randomUUID(),
      type,
      schema_version: SCHEMA_VERSION,
      tenant_id:      tenantId,
      occurred_at:    new Date().toISOString(),
      payload,
    };
    io.to(room).emit(type, envelope);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[field-relay] publish_failed:', err?.message ?? err);
  }
}
