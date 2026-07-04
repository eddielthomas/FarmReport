// =============================================================================
// lib/activity.mjs — append-only timeline emitter (Sprint 2A / EPIC-003).
// -----------------------------------------------------------------------------
// Inserts a sales.activity row. The table itself is protected by an append-only
// trigger; this helper exists so call sites get a uniform shape + can stamp the
// envelope used by rwr.workflow.state_changed.v1.
//
// publishStateChanged() emits the workflow envelope into the iam.audit_event
// log (we don't yet have a separate event bus in MVP) AND a sales.activity
// row so consumers can read the entire lifecycle out of either store.
//
// Both helpers are fire-and-forget: any DB failure is logged but never raised
// to the caller — the originating mutation must still return.
// =============================================================================

import { q } from '../db/pool.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_KINDS = new Set([
  'system','note','status_change','call','email','sms',
  'meeting','assignment','attachment','message','revenue',
]);
const VALID_ENTITIES = new Set([
  'lead','contact','organization','client','opportunity',
  'meeting','revenue_record','vendor',
]);
const VALID_SOURCES = new Set(['manual','system','external']);

export async function emitActivity({
  tenantId, entityKind, entityId, kind,
  source = 'manual', actorId = null, actorLabel = null,
  text = null, metadata = null, occurredAt = null, auditEventId = null,
} = {}) {
  if (!tenantId || !UUID_RE.test(String(tenantId))) return null;
  if (!entityId || !UUID_RE.test(String(entityId))) return null;
  if (!VALID_ENTITIES.has(entityKind)) return null;
  if (!VALID_KINDS.has(kind))          return null;
  if (!VALID_SOURCES.has(source))      source = 'manual';
  try {
    const { rows } = await q(
      `INSERT INTO sales.activity
         (tenant_id, entity_kind, entity_id, kind, source,
          actor_id, actor_label, text, occurred_at, audit_event_id, metadata)
       VALUES ($1,$2::sales.activity_entity_kind_t,$3,
               $4::sales.activity_kind_t,$5,$6,$7,$8,
               COALESCE($9::timestamptz, now()),$10,$11::jsonb)
       RETURNING id`,
      [
        tenantId, entityKind, entityId, kind, source,
        actorId, actorLabel, text, occurredAt, auditEventId,
        JSON.stringify(metadata ?? {}),
      ],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('[activity] emit_failed:', err?.message ?? err);
    return null;
  }
}

// Convenience: shape an `rwr.workflow.state_changed.v1` envelope. Routes call
// this on every state-machine transition (lead status, opportunity stage,
// revenue status, archive). We persist the envelope into sales.activity
// (kind = the entity's kind change verb) so the downstream timeline UI
// reflects every state transition in tenant time order.
export async function publishStateChanged({
  tenantId, entityKind, entityId, fromState, toState,
  actorId = null, actorLabel = null, kind = 'status_change', metadata = null,
} = {}) {
  return emitActivity({
    tenantId, entityKind, entityId, kind, source: 'system',
    actorId, actorLabel,
    text: `state_changed: ${fromState ?? '(new)'} -> ${toState ?? '(?)'}`,
    metadata: {
      ...(metadata ?? {}),
      envelope: 'rwr.workflow.state_changed.v1',
      from: fromState ?? null,
      to:   toState   ?? null,
    },
  });
}
