// =============================================================================
// chat-relay.mjs — single fan-out point for chat WS events (S6A Phase 2).
// -----------------------------------------------------------------------------
// REST handlers under /chat/* call `publishChatEvent(req.io, type, payload)`
// after the DB INSERT + recordAudit so connected socket.io clients receive
// real-time updates. The shape mirrors the EventEnvelope<T> contract documented
// in mvp/.mempalace/rwr/crm-plan-chat.md section 8 (schema_version === 1).
//
// In-process single-replica only — no Redis adapter, no outbox publish. The
// later sprint that adds horizontal scaling will swap this helper for a
// pub/sub variant; consumers only call publishChatEvent so the swap is
// transparent.
//
// Idempotent: if `io` is null (unit tests, missing attach, dev tooling) the
// helper silently no-ops. We never throw from this module — chat send must
// not fail because the relay is down.
// =============================================================================

import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;

// Map event type -> room key builder. Some events broadcast to the tenant
// bus (e.g. "a new conversation was created"); most go to the conversation
// room only.
function roomFor(io, tenantId, conversationId, type) {
  if (!tenantId) return null;
  // chat.conversation.created is published to the tenant-wide bus so any
  // open MessagesPanel can refresh its conversation list. Per-message
  // events route to the conversation room only.
  if (type === 'chat.conversation.created') {
    return `chat:tenant:${tenantId}`;
  }
  if (!conversationId) return null;
  return `chat:${tenantId}:${conversationId}`;
}

/**
 * Publish a chat event envelope to the connected socket.io fanout.
 *
 * @param {import('socket.io').Server | null | undefined} io
 *   The socket.io server instance (set on req.io by the middleware in
 *   api/server.mjs). May be null/undefined when running outside the HTTP
 *   server (unit tests, scripts) — call is a no-op in that case.
 * @param {string} type
 *   Event type string (e.g. 'chat.message.sent'). Must match the union in
 *   packages/shared-types/src/events/chat.ts.
 * @param {object} payload
 *   Event-specific payload. Must contain `tenant_id` and (for room-scoped
 *   events) `conversation_id` so we can route to the correct room.
 */
export function publishChatEvent(io, type, payload) {
  try {
    if (!io || typeof io.to !== 'function') return;
    if (!type || typeof payload !== 'object' || payload == null) return;
    const tenantId = payload.tenant_id ?? null;
    const conversationId = payload.conversation_id ?? null;
    const room = roomFor(io, tenantId, conversationId, type);
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
    // Never let WS relay failure bubble into REST.
    // eslint-disable-next-line no-console
    console.error('[chat-relay] publish_failed:', err?.message ?? err);
  }
}
