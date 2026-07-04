// =============================================================================
// lib/calendar-events.mjs — single emit point for meeting state transitions.
// -----------------------------------------------------------------------------
// Pair-emits:
//   1. sales.activity row (kind='meeting', envelope=rwr.workflow.state_changed.v1)
//   2. iam.audit_event row via recordAudit(action='sales.meeting.<toStatus>')
//
// Reuses the publishStateChanged() pattern from lib/activity.mjs. Both writes
// are best-effort; the caller (meetings.mjs) emits its own primary recordAudit
// for the underlying mutation. This helper layers the state-transition event
// on top so the workflow envelope is consistent across CRM modules.
//
// Usage:
//   emitMeetingTransition(req, meetingId, null, 'scheduled', { meeting });
//   emitMeetingTransition(req, meetingId, 'scheduled', 'cancelled', { meeting });
// =============================================================================

import { publishStateChanged } from './activity.mjs';
import { recordAudit } from '../audit.mjs';

const VALID_STATES = new Set(['scheduled','tentative','cancelled','completed']);

export async function emitMeetingTransition(req, meetingId, fromStatus, toStatus, payload = {}) {
  if (!meetingId) return;
  if (toStatus && !VALID_STATES.has(toStatus)) {
    console.warn('[calendar-events] unknown meeting toStatus:', toStatus);
  }
  // 1. Append-only timeline + workflow envelope.
  try {
    await publishStateChanged({
      tenantId:    req?.tenant?.id,
      entityKind:  'meeting',
      entityId:    meetingId,
      fromState:   fromStatus,
      toState:     toStatus,
      actorId:     req?.user?.sub ?? null,
      actorLabel:  req?.user?.email ?? null,
      kind:        'meeting',
      metadata:    {
        ...payload,
        envelope: 'rwr.workflow.state_changed.v1',
        provider: payload?.provider ?? null,
      },
    });
  } catch (err) {
    console.error('[calendar-events] state_changed_failed:', err?.message ?? err);
  }

  // 2. Audit event keyed on the destination state. Allows downstream filters
  //    like action LIKE 'sales.meeting.%' to pick up every transition.
  try {
    recordAudit({
      req,
      action: `sales.meeting.${toStatus ?? 'unknown'}`,
      resource: 'sales.meeting',
      resourceId: meetingId,
      payload: { from: fromStatus ?? null, to: toStatus ?? null, ...payload },
    });
  } catch (err) {
    console.error('[calendar-events] audit_failed:', err?.message ?? err);
  }
}
