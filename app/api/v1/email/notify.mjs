// =============================================================================
// email/notify.mjs — notification dispatchers (enqueue into email.outbox).
// -----------------------------------------------------------------------------
// Public surface used by the rest of the API. Each `notifyX` function:
//   1. resolves recipients (caller-supplied `to[]` OR auto-derived from
//      sales.assignment for the entity),
//   2. consults shouldSend(kind, tenantId, userId),
//   3. enqueues one email.outbox row per surviving recipient (status='queued',
//      next_attempt_at=now()),
//   4. emits `recordAudit({ action: 'email.notify.enqueue', ... })`.
//
// Functions return immediately — the HTTP request path is never blocked on
// transport I/O. The drain worker (email/drain.mjs) picks the row up on the
// next tick.
//
// Legacy direct-send functions (notifyContact, notifyWelcome, notifyPasswordReset,
// notifyNewsletterConfirm) still go through email/send.mjs::send because the
// outbox migration only covers the five S3B kinds.
//
// Env:
//   RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, EMAIL_INTERNAL_TO, PUBLIC_BASE_URL
// =============================================================================

import * as T from './templates.mjs';
import { send } from './send.mjs';
import { shouldSend } from './prefs.mjs';
import { q } from '../db/pool.mjs';
import { recordAudit } from '../audit.mjs';

const INTERNAL_TO = (process.env.EMAIL_INTERNAL_TO ?? 'ops@report.farm')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// audit helper for the legacy direct-send paths — preserved for backwards
// compat with the marketing / register / reset flows.
// ---------------------------------------------------------------------------
async function audit({ tenantId, kind, recipient, subject, id, ok, error }) {
  if (!tenantId) {
    console.log(`[email] sent kind=${kind} to=${recipient} subject="${subject}" ok=${ok}${error ? ' error=' + error : ''}`);
    return;
  }
  try {
    await q(
      `INSERT INTO iam.audit_event (tenant_id, actor_id, actor_email, action, resource, resource_id, payload)
       VALUES ($1,NULL,'system','email.' || $2, 'notification', $3,
               jsonb_build_object('to', $4, 'subject', $5, 'ok', $6, 'error', $7))`,
      [tenantId, kind, id ?? null, recipient, subject, ok, error ?? null],
    );
  } catch (e) {
    console.error('[email] audit insert failed', e?.message);
  }
}

// ---------------------------------------------------------------------------
// enqueue() — internal: write one row per recipient into email.outbox.
// Caller has already filtered via shouldSend(); this function is purely a
// persistence helper. Returns the list of inserted ids.
// ---------------------------------------------------------------------------
async function enqueue({ tenantId, kind, recipients, payload }) {
  if (!tenantId || !kind || !Array.isArray(recipients) || recipients.length === 0) {
    return [];
  }
  const ids = [];
  for (const r of recipients) {
    const email = typeof r === 'string' ? r : r?.email;
    const userId = typeof r === 'string' ? null : (r?.user_id ?? null);
    if (!email) continue;
    try {
      const { rows } = await q(
        `INSERT INTO email.outbox
           (tenant_id, kind, recipient_email, recipient_user_id, payload, status, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', now())
         RETURNING id`,
        [tenantId, kind, String(email), userId, JSON.stringify(payload ?? {})],
      );
      ids.push(rows[0].id);
    } catch (err) {
      console.error('[notify] enqueue_failed', kind, email, err?.message ?? err);
    }
  }
  return ids;
}

// Normalise a single recipient argument into [{ email, user_id? }, ...].
function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) {
    return to
      .map((x) => (typeof x === 'string' ? { email: x, user_id: null } : x))
      .filter((x) => x && x.email);
  }
  if (typeof to === 'string') return [{ email: to, user_id: null }];
  if (typeof to === 'object' && to.email) return [{ email: to.email, user_id: to.user_id ?? null }];
  return [];
}

// Auto-resolve recipients for an entity from sales.assignment. Returns rows
// shaped { email, user_id }. Best-effort — failures fall back to [].
async function resolveAssignmentRecipients(tenantId, entityKind, entityId) {
  if (!tenantId || !entityId) return [];
  try {
    const { rows } = await q(
      `SELECT DISTINCT u.id AS user_id, u.email
         FROM sales.assignment a
         JOIN iam.user_profile u ON u.id = a.user_id
        WHERE a.tenant_id = $1
          AND a.entity_kind = $2
          AND a.entity_id   = $3
          AND a.released_at IS NULL
          AND u.email IS NOT NULL`,
      [tenantId, entityKind, entityId],
    );
    return rows.map((r) => ({ email: r.email, user_id: r.user_id }));
  } catch (err) {
    console.error('[notify] resolveAssignment_failed', err?.message ?? err);
    return [];
  }
}

// Filter recipients by per-user shouldSend(). Returns the survivors and the
// number of opt-outs (for audit).
async function applyPrefs(kind, tenantId, recipients) {
  const kept = [];
  const skipped = [];
  for (const r of recipients) {
    const allow = await shouldSend(kind, tenantId, r.user_id);
    if (allow) kept.push(r);
    else       skipped.push(r);
  }
  return { kept, skipped };
}

// =============================================================================
// === Phase-1 direct dispatchers (legacy — unchanged behaviour) ===============
// =============================================================================

export async function notifyContact({ submission, tenantId, ip, user_agent }) {
  const conf = T.contactConfirmation({
    first_name:   submission.first_name,
    mission_line: submission.mission_line,
    message:      submission.message,
  });
  const r1 = await send({
    to:      submission.email,
    subject: conf.subject,
    html:    conf.html ?? conf,
    text:    conf.text,
    tags:    [{ name: 'kind', value: 'contact_confirmation' }],
  });
  await audit({ tenantId, kind: 'contact_confirm', recipient: submission.email, subject: conf.subject, id: r1.id, ok: r1.ok, error: r1.error });

  if (INTERNAL_TO.length > 0) {
    const int = T.contactInternal({
      ...submission, ip, user_agent,
      phone: submission.phone, role: submission.role, country: submission.country,
      timeline: submission.timeline, nda_required: submission.nda_required, how_heard: submission.how_heard,
    });
    const r2 = await send({
      to: INTERNAL_TO, subject: int.subject, html: int.html, text: int.text,
      replyTo: submission.email, tags: [{ name: 'kind', value: 'contact_internal' }],
    });
    await audit({ tenantId, kind: 'contact_internal', recipient: INTERNAL_TO.join(','), subject: int.subject, id: r2.id, ok: r2.ok, error: r2.error });
  }
  return { ok: true };
}

export async function notifyWelcome({ user, tenantId, tenantName }) {
  const t = T.welcome({ first_name: user.display_name ?? user.email.split('@')[0], tenant_name: tenantName });
  const r = await send({ to: user.email, subject: t.subject, html: t.html, text: t.text, tags: [{ name: 'kind', value: 'welcome' }] });
  await audit({ tenantId, kind: 'welcome', recipient: user.email, subject: t.subject, id: r.id, ok: r.ok, error: r.error });
  return r;
}

export async function notifyPasswordReset({ user, resetUrl, tenantId, expiresMinutes }) {
  const t = T.passwordReset({
    first_name: user.display_name ?? user.email.split('@')[0],
    reset_url:  resetUrl,
    expires_minutes: expiresMinutes ?? 30,
  });
  const r = await send({ to: user.email, subject: t.subject, html: t.html, text: t.text, tags: [{ name: 'kind', value: 'password_reset' }] });
  await audit({ tenantId, kind: 'password_reset', recipient: user.email, subject: t.subject, id: r.id, ok: r.ok, error: r.error });
  return r;
}

export async function notifyNewsletterConfirm({ email, first_name, confirmUrl }) {
  const t = T.newsletterConfirm({ first_name, confirm_url: confirmUrl });
  const r = await send({ to: email, subject: t.subject, html: t.html, text: t.text, tags: [{ name: 'kind', value: 'newsletter_confirm' }] });
  await audit({ kind: 'newsletter_confirm', recipient: email, subject: t.subject, id: r.id, ok: r.ok, error: r.error });
  return r;
}

// =============================================================================
// === Phase-2 enqueue dispatchers (S3B) =======================================
// =============================================================================

// ----- helper: build the canonical req shim used by recordAudit ---------------
function auditReq(reqOrTenantId, byUser) {
  if (reqOrTenantId && typeof reqOrTenantId === 'object' && reqOrTenantId.tenant) {
    return reqOrTenantId;
  }
  // Fallback: synthesise a minimal req for direct callers (background workers).
  return {
    tenant:  { id: reqOrTenantId },
    user:    { email: byUser ?? 'system', sub: null },
    headers: {},
  };
}

// ----- notifyLeadCreated -----------------------------------------------------
// Called after sales.lead INSERT. Recipient resolution:
//   1. body.to[] takes precedence
//   2. otherwise sales.assignment for the lead
//   3. otherwise EMAIL_INTERNAL_TO fallback so the desk hears about it
export async function notifyLeadCreated(req, leadId, opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId || !leadId) return { ok: false, error: 'tenant_or_lead_missing' };
  const kind = 'lead_created';

  let recipients = normalizeRecipients(opts.to);
  if (recipients.length === 0) {
    recipients = await resolveAssignmentRecipients(tenantId, 'lead', leadId);
  }
  if (recipients.length === 0 && INTERNAL_TO.length > 0) {
    recipients = INTERNAL_TO.map((e) => ({ email: e, user_id: null }));
  }

  // Hydrate template payload — drain renders at send-time so template fixes
  // apply to in-flight queued mail.
  let leadRow = opts.lead ?? null;
  if (!leadRow) {
    try {
      const { rows } = await q(
        `SELECT id, name, email, company, status, source
           FROM sales.lead WHERE tenant_id = $1 AND id = $2`,
        [tenantId, leadId],
      );
      leadRow = rows[0] ?? null;
    } catch (_e) { /* drain will re-resolve if missing */ }
  }
  const payload = {
    template_key: 'leadCreated',
    vars: {
      lead_id:   leadId,
      lead_name: leadRow?.name ?? 'New lead',
      lead_company: leadRow?.company ?? null,
      lead_status:  leadRow?.status ?? 'Info Request',
      lead_source:  leadRow?.source ?? null,
      by_user:      req?.user?.email ?? 'system',
    },
  };

  const { kept, skipped } = await applyPrefs(kind, tenantId, recipients);
  const ids = await enqueue({ tenantId, kind, recipients: kept, payload });

  recordAudit({
    req: auditReq(req), action: 'email.notify.enqueue',
    resource: 'email.outbox', resourceId: leadId,
    payload: { kind, enqueued: ids.length, skipped: skipped.length, ids },
  });
  return { ok: true, enqueued: ids.length, ids };
}

// ----- notifyLeadStatusChanged (wired existing) ------------------------------
export async function notifyLeadStatusChanged(req, leadId, fromStatus, toStatus, opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId || !leadId) return { ok: false, error: 'tenant_or_lead_missing' };
  const kind = 'lead_status_changed';

  let recipients = normalizeRecipients(opts.to);
  if (recipients.length === 0) {
    recipients = await resolveAssignmentRecipients(tenantId, 'lead', leadId);
  }
  if (recipients.length === 0 && INTERNAL_TO.length > 0) {
    recipients = INTERNAL_TO.map((e) => ({ email: e, user_id: null }));
  }

  let leadRow = opts.lead ?? null;
  if (!leadRow) {
    try {
      const { rows } = await q(
        `SELECT name, company FROM sales.lead WHERE tenant_id = $1 AND id = $2`,
        [tenantId, leadId],
      );
      leadRow = rows[0] ?? null;
    } catch (_e) {}
  }
  const payload = {
    template_key: 'leadStatusChanged',
    vars: {
      lead_id:     leadId,
      lead_name:   leadRow?.name ?? `Lead ${leadId}`,
      from_status: fromStatus,
      to_status:   toStatus,
      by_user:     req?.user?.email ?? 'system',
      note:        opts.note ?? null,
    },
  };

  const { kept, skipped } = await applyPrefs(kind, tenantId, recipients);
  const ids = await enqueue({ tenantId, kind, recipients: kept, payload });

  recordAudit({
    req: auditReq(req), action: 'email.notify.enqueue',
    resource: 'email.outbox', resourceId: leadId,
    payload: { kind, from: fromStatus, to: toStatus, enqueued: ids.length, skipped: skipped.length, ids },
  });
  return { ok: true, enqueued: ids.length, ids };
}

// ----- notifyMeetingScheduled ------------------------------------------------
export async function notifyMeetingScheduled(req, meetingId, opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId || !meetingId) return { ok: false, error: 'tenant_or_meeting_missing' };
  const kind = 'meeting_scheduled';

  let mtg = opts.meeting ?? null;
  if (!mtg) {
    try {
      const { rows } = await q(
        `SELECT id, lead_id, title, start_at, end_at, location, attendees, notes
           FROM sales.meeting WHERE tenant_id = $1 AND id = $2`,
        [tenantId, meetingId],
      );
      mtg = rows[0] ?? null;
    } catch (_e) {}
  }

  let recipients = normalizeRecipients(opts.to);
  if (recipients.length === 0) {
    // Auto-resolve from attendees JSONB array (each element is either a
    // string-email or an object with .email). Then layer in assignment owners
    // of the linked lead, if any.
    const att = Array.isArray(mtg?.attendees) ? mtg.attendees : [];
    for (const a of att) {
      const email = typeof a === 'string' ? a : a?.email;
      if (email) recipients.push({ email, user_id: null });
    }
    if (mtg?.lead_id) {
      const owners = await resolveAssignmentRecipients(tenantId, 'lead', mtg.lead_id);
      recipients.push(...owners);
    }
    if (req?.user?.email) {
      recipients.push({ email: req.user.email, user_id: req?.user?.sub ?? null });
    }
  }
  // dedupe by email
  {
    const seen = new Set();
    recipients = recipients.filter((r) => {
      const k = String(r.email).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  const payload = {
    template_key: 'meetingScheduled',
    vars: {
      meeting_id: meetingId,
      title:      mtg?.title ?? 'Scheduled meeting',
      start_at:   mtg?.start_at ?? null,
      end_at:     mtg?.end_at ?? null,
      location:   mtg?.location ?? null,
      notes:      mtg?.notes ?? null,
      by_user:    req?.user?.email ?? 'system',
    },
  };

  const { kept, skipped } = await applyPrefs(kind, tenantId, recipients);
  const ids = await enqueue({ tenantId, kind, recipients: kept, payload });

  recordAudit({
    req: auditReq(req), action: 'email.notify.enqueue',
    resource: 'email.outbox', resourceId: meetingId,
    payload: { kind, enqueued: ids.length, skipped: skipped.length, ids },
  });
  return { ok: true, enqueued: ids.length, ids };
}

// ----- notifyCaseAssigned (wired existing) -----------------------------------
export async function notifyCaseAssigned(req, caseId, assigneeUserId, opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId || !caseId) return { ok: false, error: 'tenant_or_case_missing' };
  const kind = 'case_assigned';

  let recipients = normalizeRecipients(opts.to);
  if (recipients.length === 0 && assigneeUserId) {
    try {
      const { rows } = await q(
        `SELECT email, id FROM iam.user_profile WHERE tenant_id = $1 AND id = $2`,
        [tenantId, assigneeUserId],
      );
      if (rows[0]?.email) recipients.push({ email: rows[0].email, user_id: rows[0].id });
    } catch (_e) {}
  }

  let kase = opts.case_row ?? null;
  if (!kase) {
    try {
      const { rows } = await q(
        `SELECT id, title, priority FROM ops.case WHERE tenant_id = $1 AND id = $2`,
        [tenantId, caseId],
      );
      kase = rows[0] ?? null;
    } catch (_e) {}
  }

  const payload = {
    template_key: 'caseAssigned',
    vars: {
      case_id:       caseId,
      case_title:    kase?.title ?? `Case ${caseId}`,
      priority:      kase?.priority ?? 'medium',
      assignee_id:   assigneeUserId ?? null,
      by_user:       req?.user?.email ?? 'system',
    },
  };

  const { kept, skipped } = await applyPrefs(kind, tenantId, recipients);
  const ids = await enqueue({ tenantId, kind, recipients: kept, payload });

  recordAudit({
    req: auditReq(req), action: 'email.notify.enqueue',
    resource: 'email.outbox', resourceId: caseId,
    payload: { kind, enqueued: ids.length, skipped: skipped.length, ids },
  });
  return { ok: true, enqueued: ids.length, ids };
}

// ----- notifyChatAlert -------------------------------------------------------
// S3A wires this from POST /chat/conversations/:id/alert. Until that route
// lands, this function is exposed as a stub other code can already call.
export async function notifyChatAlert(req, conversationId, opts = {}) {
  const tenantId = req?.tenant?.id;
  if (!tenantId || !conversationId) return { ok: false, error: 'tenant_or_convo_missing' };
  const kind = 'chat_alert';

  let recipients = normalizeRecipients(opts.to);
  // Best-effort assignment-derived recipients (S3A wires real conversation row).
  if (recipients.length === 0 && opts.entity_id) {
    recipients = await resolveAssignmentRecipients(tenantId, opts.entity_kind ?? 'lead', opts.entity_id);
  }
  if (recipients.length === 0 && INTERNAL_TO.length > 0) {
    recipients = INTERNAL_TO.map((e) => ({ email: e, user_id: null }));
  }

  const payload = {
    template_key: 'chatAlert',
    vars: {
      conversation_id:      conversationId,
      conversation_subject: opts.subject ?? '(no subject)',
      message_excerpt:      opts.excerpt ?? null,
      by_user:              req?.user?.email ?? 'system',
    },
  };

  const { kept, skipped } = await applyPrefs(kind, tenantId, recipients);
  const ids = await enqueue({ tenantId, kind, recipients: kept, payload });

  recordAudit({
    req: auditReq(req), action: 'email.notify.enqueue',
    resource: 'email.outbox', resourceId: conversationId,
    payload: { kind, enqueued: ids.length, skipped: skipped.length, ids },
  });
  return { ok: true, enqueued: ids.length, ids };
}
